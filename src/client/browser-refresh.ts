import { spawn } from "node:child_process";
import { decodeAmcBootstrap, AmcSession } from "./session";

const DEFAULT_TIMEOUT_MS = 190_000;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export type BrowserRefreshStage =
  "transport" | "navigation" | "semantic" | "browser-trust" | "cookie-export";

export class BrowserRefreshUnavailableError extends Error {
  readonly code = "AMC_BROWSER_REFRESH_UNAVAILABLE";

  constructor(readonly stage: BrowserRefreshStage) {
    super(`AMC browser refresh unavailable (${stage})`);
  }
}

export interface AmcBrowserRefresher {
  refresh(previous?: AmcSession | null): Promise<AmcSession>;
}

export interface AsideExecutionRequest {
  title: string;
  code: string;
  timeoutMs: number;
}

export interface AsideExecutionAdapter {
  execute(request: AsideExecutionRequest): Promise<string>;
}

export interface AsideBrowserRefresherOptions {
  /** The trusted in-process browser execution adapter (required). */
  execution: AsideExecutionAdapter;
  timeoutMs?: number;
  /**
   * Official AMC listing URL to navigate to validate the cleared session.
   * Required — there is no built-in venue default; callers derive it from
   * their own official theater URL.
   */
  listingUrl: string;
}

export class AsideBrowserRefresher implements AmcBrowserRefresher {
  private readonly execution: AsideExecutionAdapter;
  private readonly timeoutMs: number;
  private readonly listingUrl: string;

  constructor(options: AsideBrowserRefresherOptions) {
    this.execution = options.execution;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!options.listingUrl) {
      throw new Error(
        "an explicit AMC listing URL is required (no built-in venue default)",
      );
    }
    const url = new URL(options.listingUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "www.amctheatres.com"
    ) {
      throw new Error(
        "Aside browser refresh listing URL must be on https://www.amctheatres.com",
      );
    }
    this.listingUrl = options.listingUrl;
  }

  async refresh(): Promise<AmcSession> {
    let output: string;
    try {
      output = await this.execution.execute({
        title: "Refresh AMC read session",
        code: asideRefreshTransaction(this.listingUrl),
        timeoutMs: this.timeoutMs,
      });
    } catch {
      throw new BrowserRefreshUnavailableError("transport");
    }

    const result = parsePrivateResult(output);
    if (!isRecord(result) || result.ok !== true) {
      throw new BrowserRefreshUnavailableError(failureStage(result));
    }
    // Admission = rendered movie sections on the allowed origin (the
    // transaction only reports ok:true from that origin). formatGroups /
    // showtimeLinks describe showtime AVAILABILITY, not admission — an
    // admitted official listing may render zero remaining performances — so
    // they are shape-validated as counters but never required to be positive.
    // The exported jar is still validated by the caller's direct canary
    // before persistence.
    if (
      result.stage !== "complete" ||
      !isRecord(result.semantic) ||
      !positiveInteger(result.semantic.movieSections) ||
      !nonNegativeInteger(result.semantic.formatGroups) ||
      !nonNegativeInteger(result.semantic.showtimeLinks) ||
      !Array.isArray(result.cookies)
    ) {
      throw new BrowserRefreshUnavailableError("semantic");
    }

    try {
      return decodeAmcBootstrap(
        Buffer.from(JSON.stringify({ cookies: result.cookies })),
      );
    } catch {
      throw new BrowserRefreshUnavailableError("cookie-export");
    }
  }
}

export class AsideSessionExecutionAdapter implements AsideExecutionAdapter {
  /**
   * @param scriptPath explicit path to the caller's Aside bridge script. There
   *   is deliberately no built-in or home-directory default.
   */
  constructor(
    private readonly scriptPath: string,
    private readonly python = "python3",
  ) {}

  async execute(request: AsideExecutionRequest): Promise<string> {
    await this.invoke(
      ["start"],
      "",
      Math.min(request.timeoutMs, 30_000),
      false,
    );
    return this.invoke(
      ["run", request.title],
      request.code,
      request.timeoutMs,
      true,
    );
  }

  private invoke(
    args: string[],
    input: string,
    timeoutMs: number,
    captureOutput: boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.scriptPath, ...args], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (error?: Error, output?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(output ?? "");
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Aside execution timed out"));
      }, timeoutMs);

      child.on("error", () => finish(new Error("Aside execution failed")));
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (!captureOutput) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_RESULT_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("Aside execution result exceeded limit"));
          return;
        }
        chunks.push(buffer);
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(new Error("Aside execution failed"));
          return;
        }
        finish(undefined, Buffer.concat(chunks).toString("utf8"));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    });
  }
}

function asideRefreshTransaction(listingUrl: string): string {
  return `
globalThis.__amcRefreshResult = { ok: false, stage: "navigation" };
globalThis.__amcRefreshPage = null;
try {
  globalThis.__amcRefreshPage = await openTab(${JSON.stringify(listingUrl)});
  globalThis.__amcRefreshResult = { ok: false, stage: "semantic" };
  globalThis.__amcRefreshSemantic = null;
  for (globalThis.__amcRefreshAttempt = 0; globalThis.__amcRefreshAttempt < 30; globalThis.__amcRefreshAttempt++) {
    globalThis.__amcRefreshSemantic = await globalThis.__amcRefreshPage.evaluate(() => {
      const movieSections = document.querySelectorAll('section[aria-label^="Showtimes for "]').length;
      const formatGroups = document.querySelectorAll('li[role="listitem"][aria-label$=" Showtimes"]').length;
      const showtimeLinks = [...document.querySelectorAll('a[href^="/showtimes/"]')]
        .filter((anchor) => /^\\/showtimes\\/\\d+$/.test(anchor.getAttribute('href') || '')).length;
      return {
        allowedOrigin: location.origin === 'https://www.amctheatres.com',
        movieSections,
        formatGroups,
        showtimeLinks,
      };
    });
    if (
      globalThis.__amcRefreshSemantic.allowedOrigin &&
      globalThis.__amcRefreshSemantic.movieSections > 0
    ) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (
    globalThis.__amcRefreshSemantic &&
    globalThis.__amcRefreshSemantic.allowedOrigin &&
    globalThis.__amcRefreshSemantic.movieSections > 0
  ) {
    globalThis.__amcRefreshResult = { ok: false, stage: "cookie-export" };
    globalThis.__amcRefreshRawCookies =
      await globalThis.__amcRefreshPage._sendToTarget('Network.getAllCookies', {});
    globalThis.__amcRefreshScopedCookies = Array.isArray(globalThis.__amcRefreshRawCookies?.cookies)
      ? globalThis.__amcRefreshRawCookies.cookies.filter((cookie) =>
          ['.amctheatres.com', 'amctheatres.com', 'www.amctheatres.com', '.www.amctheatres.com',
           'graph.amctheatres.com', '.graph.amctheatres.com']
            .includes(String(cookie?.domain || '').toLowerCase()))
      : [];
    if (globalThis.__amcRefreshScopedCookies.length > 0) {
      globalThis.__amcRefreshResult = {
        ok: true,
        stage: "complete",
        semantic: {
          movieSections: globalThis.__amcRefreshSemantic.movieSections,
          formatGroups: globalThis.__amcRefreshSemantic.formatGroups,
          showtimeLinks: globalThis.__amcRefreshSemantic.showtimeLinks,
        },
        cookies: globalThis.__amcRefreshScopedCookies,
      };
    }
  }
} catch (_) {
} finally {
  if (globalThis.__amcRefreshPage) {
    try { await globalThis.__amcRefreshPage.close(); } catch (_) {}
  }
}
console.log(JSON.stringify(globalThis.__amcRefreshResult));
`.trim();
}

function parsePrivateResult(output: string): unknown {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      // Tool wrappers may add non-secret status lines; only a JSON result is accepted.
    }
  }
  return null;
}

function failureStage(value: unknown): BrowserRefreshStage {
  if (!isRecord(value)) return "transport";
  return value.stage === "navigation" ||
    value.stage === "semantic" ||
    value.stage === "cookie-export"
    ? value.stage
    : "transport";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
