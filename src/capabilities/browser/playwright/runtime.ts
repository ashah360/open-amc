// A concrete, coherent Playwright browser runtime for the AMC adapter. It is
// intentionally built on a single stack (`playwright-core`), which does not
// bundle or download a browser on install, and supports every launch/connect
// shape the adapter needs: Playwright-managed Chromium (installed explicitly
// via `npx playwright install chromium`), an installed Chrome via
// channel/executable, an existing Chrome over a CDP endpoint, and a
// caller-supplied Browser or BrowserContext.
//
// The Playwright types below are minimal structural surfaces (not imports of
// `playwright-core`) so that core-only consumers can import this file's types
// without installing any browser dependency. The real module is loaded lazily
// and only when a launch/connect actually happens.

/** A cookie as returned by Playwright's `BrowserContext.cookies()`. */
export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds, or -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface PlaywrightPage {
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: string },
  ): Promise<unknown>;
  evaluate<R>(pageFunction: unknown, arg?: unknown): Promise<R>;
  addScriptTag(options: { content?: string; url?: string }): Promise<unknown>;
  url(): string;
  waitForTimeout(timeout: number): Promise<void>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  cookies(urls?: string | string[]): Promise<PlaywrightCookie[]>;
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(
    options?: Record<string, unknown>,
  ): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
  isConnected?(): boolean;
}

export interface PlaywrightChromium {
  launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
  // playwright-core's canonical signature is connectOverCDP(endpointURL, options).
  connectOverCDP(
    endpointURL: string,
    options?: Record<string, unknown>,
  ): Promise<PlaywrightBrowser>;
}

export interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

/**
 * How the runtime obtains a browser. Exactly one coherent stack, four shapes:
 * - `launch`: Playwright-managed Chromium (installed via
 *   `npx playwright install chromium`), or an installed Chrome via
 *   `channel`/`executablePath`.
 * - `cdp`: connect to an already-running Chrome over a CDP endpoint.
 * - `browser`/`context`: reuse a caller-owned Playwright object.
 */
/**
 * Playwright's launch proxy shape. Credentials are held only in memory for the
 * launch call and are never logged or echoed in errors.
 */
export interface PlaywrightProxyConfig {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
}

export type PlaywrightConnection =
  | {
      readonly kind: "launch";
      readonly channel?: string;
      readonly executablePath?: string;
      readonly headless?: boolean;
      readonly args?: readonly string[];
      readonly proxy?: PlaywrightProxyConfig;
      readonly launchOptions?: Record<string, unknown>;
    }
  | {
      readonly kind: "cdp";
      readonly endpointURL: string;
      readonly connectOptions?: Record<string, unknown>;
    }
  | { readonly kind: "browser"; readonly browser: PlaywrightBrowser }
  | { readonly kind: "context"; readonly context: PlaywrightBrowserContext };

/**
 * The single typed error the Playwright subpath raises when an optional
 * dependency or browser is missing. It names the missing piece and how to
 * install it, and never carries a raw provider error, path, or command output.
 */
export class PlaywrightSetupError extends Error {
  readonly code = "AMC_PLAYWRIGHT_SETUP_REQUIRED";

  constructor(
    readonly dependency: "playwright-core" | "chromium" | "braintree-web",
    readonly instruction: string,
  ) {
    super(`AMC Playwright capability requires ${dependency}: ${instruction}`);
  }
}

/**
 * Raised when a browser operation is stopped by its own timeout budget or by a
 * caller-provided AbortSignal. It carries only the reason, never a raw browser
 * error, page content, or URL.
 */
export class BrowserOperationTimeoutError extends Error {
  readonly code = "AMC_BROWSER_OPERATION_TIMEOUT";

  constructor(readonly reason: "timeout" | "aborted") {
    super(`AMC browser operation ${reason}`);
  }
}

/**
 * Raised when a CDP endpoint cannot be connected to: unreachable/refused,
 * timed out, or returned an invalid DevTools response. Deliberately carries
 * only the non-secret reason — never the endpoint URL or response bytes — and
 * exists so a dead `--cdp-url` fails fast with a stable nonzero JSON error
 * instead of leaving an unresolved, unref'd promise that lets Node exit 0
 * silently.
 */
export class PlaywrightConnectionError extends Error {
  readonly code = "AMC_PLAYWRIGHT_CONNECTION_FAILED";

  constructor(readonly reason: "unreachable" | "timeout" | "invalid-response") {
    super(
      reason === "timeout"
        ? "AMC Playwright CDP endpoint did not respond in time; verify the Chrome behind --cdp-url is running and reachable"
        : reason === "unreachable"
          ? "AMC Playwright CDP endpoint is unreachable; verify the Chrome behind --cdp-url is running and reachable"
          : "AMC Playwright CDP endpoint returned an invalid DevTools response; verify --cdp-url points at Chrome's remote debugging port",
    );
  }
}

/** Bounded preflight budget for GET <endpoint>/json/version. */
const CDP_PREFLIGHT_TIMEOUT_MS = 5_000;
/** Bound on the /json/version body we are willing to read. */
const CDP_PREFLIGHT_MAX_BYTES = 256 * 1024;
/** Hard wall for connectOverCDP itself (post-preflight hangs). */
const CDP_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Bounded reachability/protocol preflight for a CDP endpoint, run BEFORE
 * `connectOverCDP`: validates the http(s) URL shape, GETs its
 * `/json/version` (endpoint paths are respected), and requires HTTP 200 JSON
 * with a nonempty `webSocketDebuggerUrl` (or an equivalent valid CDP version
 * shape). Redirects are not followed and count as invalid. The timeout timer
 * is REF'D so the process cannot silently exit 0 mid-check. Errors never echo
 * the endpoint or response.
 */
export async function preflightCdpEndpoint(
  endpointURL: string,
  timeoutMs = CDP_PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  let base: URL;
  try {
    base = new URL(endpointURL);
  } catch {
    throw new PlaywrightConnectionError("invalid-response");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new PlaywrightConnectionError("invalid-response");
  }
  const versionUrl = new URL(base.toString());
  versionUrl.pathname = `${base.pathname.replace(/\/+$/, "")}/json/version`;
  versionUrl.search = "";
  versionUrl.hash = "";

  const controller = new AbortController();
  // Deliberately ref'd: this timer keeps the event loop alive for the check.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(versionUrl, {
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw new PlaywrightConnectionError(
        controller.signal.aborted ? "timeout" : "unreachable",
      );
    }
    // Any non-200 (including 3xx under redirect: "manual") is invalid; we never
    // follow redirects off the configured endpoint.
    if (response.status !== 200) {
      throw new PlaywrightConnectionError("invalid-response");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new PlaywrightConnectionError(
        controller.signal.aborted ? "timeout" : "invalid-response",
      );
    }
    if (Buffer.byteLength(text, "utf8") > CDP_PREFLIGHT_MAX_BYTES) {
      throw new PlaywrightConnectionError("invalid-response");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PlaywrightConnectionError("invalid-response");
    }
    const record =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const webSocketDebuggerUrl = record.webSocketDebuggerUrl;
    const validShape =
      (typeof webSocketDebuggerUrl === "string" &&
        webSocketDebuggerUrl.length > 0) ||
      (typeof record.Browser === "string" &&
        typeof record["Protocol-Version"] === "string");
    if (!validShape) {
      throw new PlaywrightConnectionError("invalid-response");
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `connectOverCDP` with a REF'D hard timeout: an endpoint can pass preflight
 * and then hang the connect, and playwright's pending promise alone holds no
 * ref'd handle, which previously let Node exit 0 with no output. A late
 * post-timeout connection is closed so nothing leaks; success clears the
 * timer.
 */
async function connectOverCdpWithBudget(
  module: PlaywrightModule,
  endpointURL: string,
  connectOptions?: Record<string, unknown>,
  timeoutMs = CDP_CONNECT_TIMEOUT_MS,
): Promise<PlaywrightBrowser> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    // Deliberately ref'd: keeps the process alive until connect settles or the
    // budget elapses.
    timer = setTimeout(() => {
      timedOut = true;
      reject(new PlaywrightConnectionError("timeout"));
    }, timeoutMs);
  });
  const connecting = module.chromium.connectOverCDP(
    endpointURL,
    connectOptions,
  );
  // If the library connects after the budget already rejected, close the late
  // browser handle so nothing leaks; swallow its own failure.
  connecting.then(
    (browser) => {
      if (timedOut) void browser.close().catch(() => undefined);
    },
    () => undefined,
  );
  try {
    return await Promise.race([connecting, timeout]);
  } catch (error) {
    if (error instanceof PlaywrightConnectionError) throw error;
    throw new PlaywrightConnectionError("unreachable");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs `work` under a timeout budget and an optional AbortSignal. On timeout or
 * abort it rejects with a typed BrowserOperationTimeoutError; the caller is
 * responsible for disposing any acquired browser resources in its own `finally`
 * so an in-flight operation is torn down.
 */
export function runWithBrowserBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  const controller = new AbortController();
  const external = options.signal;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      controller.abort();
      finish(() => reject(new BrowserOperationTimeoutError("aborted")));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new BrowserOperationTimeoutError("timeout")));
    }, options.timeoutMs);
    function finish(apply: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
      apply();
    }
    if (external) {
      if (external.aborted) {
        onAbort();
        return;
      }
      external.addEventListener("abort", onAbort, { once: true });
    }
    work(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * How the browser handle must be released on cleanup. This distinguishes owning
 * the remote process from owning only the local Playwright connection:
 * - `terminate`: this runtime launched the browser; `close()` quits it.
 * - `disconnect`: this runtime connected over CDP; `close()` drops the local
 *   Playwright connection (verified against playwright-core: a connected
 *   browser's `close()` closes the CDP transport and does not terminate the
 *   caller-owned remote Chrome process).
 * - `none`: the browser (and its process/connection) is caller-owned; never
 *   close it.
 */
export type BrowserDisposal = "terminate" | "disconnect" | "none";

/** Result of acquiring a context, with explicit ownership for safe cleanup. */
export interface AcquiredBrowser {
  readonly context: PlaywrightBrowserContext;
  /** True when this runtime created the context (and must close it). */
  readonly ownsContext: boolean;
  /** How to release the browser handle on cleanup (or `none` to leave it). */
  readonly browserDisposal: BrowserDisposal;
  readonly browser?: PlaywrightBrowser;
}

export interface PlaywrightBrowserRuntimeOptions {
  /**
   * Loads the Playwright module. Defaults to importing `playwright-core`
   * lazily; a missing module surfaces as a single typed PlaywrightSetupError.
   */
  loadModule?: () => Promise<PlaywrightModule>;
  /**
   * CDP endpoint preflight seam (tests). Defaults to the real bounded
   * {@link preflightCdpEndpoint}; only used for `kind: "cdp"` connections.
   */
  cdpPreflight?: (endpointURL: string) => Promise<void>;
  /** Hard budget for connectOverCDP itself (tests may shorten it). */
  cdpConnectTimeoutMs?: number;
}

async function defaultLoadModule(): Promise<PlaywrightModule> {
  try {
    return (await import("playwright-core")) as unknown as PlaywrightModule;
  } catch {
    throw new PlaywrightSetupError(
      "playwright-core",
      "install the optional peer dependency (npm i playwright-core) or the full 'playwright' package",
    );
  }
}

/** Canonical Playwright signal that the requested browser build is not present. */
function looksLikeMissingBrowser(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Executable doesn't exist|playwright install|Failed to launch|BrowserType\.launch/i.test(
    message,
  );
}

export class PlaywrightBrowserRuntime {
  private readonly loadModule: () => Promise<PlaywrightModule>;
  private readonly cdpPreflight: (endpointURL: string) => Promise<void>;
  private readonly cdpConnectTimeoutMs: number;

  constructor(
    private readonly connection: PlaywrightConnection,
    options: PlaywrightBrowserRuntimeOptions = {},
  ) {
    this.loadModule = options.loadModule ?? defaultLoadModule;
    this.cdpPreflight = options.cdpPreflight ?? preflightCdpEndpoint;
    this.cdpConnectTimeoutMs =
      options.cdpConnectTimeoutMs ?? CDP_CONNECT_TIMEOUT_MS;
  }

  /** Acquire a context, launching or connecting only when required. */
  async acquire(): Promise<AcquiredBrowser> {
    switch (this.connection.kind) {
      case "context":
        return {
          context: this.connection.context,
          ownsContext: false,
          browserDisposal: "none",
        };
      case "browser": {
        const context = await this.connection.browser.newContext();
        return {
          context,
          ownsContext: true,
          browserDisposal: "none",
          browser: this.connection.browser,
        };
      }
      case "launch": {
        const module = await this.loadPlaywright();
        const browser = await this.launch(module);
        // If context creation fails after a successful launch, close the
        // browser we launched so it can never leak.
        const context = await newContextOrClose(browser, "terminate");
        return {
          context,
          ownsContext: true,
          browserDisposal: "terminate",
          browser,
        };
      }
      case "cdp": {
        // Fail fast and typed on a dead/stale endpoint BEFORE loading
        // playwright or attempting connectOverCDP.
        await this.cdpPreflight(this.connection.endpointURL);
        const module = await this.loadPlaywright();
        const browser = await connectOverCdpWithBudget(
          module,
          this.connection.endpointURL,
          this.connection.connectOptions,
          this.cdpConnectTimeoutMs,
        );
        // The Chrome behind a CDP endpoint was started by someone else. We own
        // only the local Playwright connection: create/own a fresh context, and
        // on cleanup (or a context-creation failure) disconnect that connection
        // without terminating the caller-owned remote Chrome.
        const context = await newContextOrClose(browser, "disconnect");
        return {
          context,
          ownsContext: true,
          browserDisposal: "disconnect",
          browser,
        };
      }
    }
  }

  /** Acquire a context wrapped in a workspace that tracks created pages. */
  async open(): Promise<PlaywrightWorkspace> {
    return new PlaywrightWorkspace(await this.acquire());
  }

  private async loadPlaywright(): Promise<PlaywrightModule> {
    try {
      return await this.loadModule();
    } catch (error) {
      if (error instanceof PlaywrightSetupError) throw error;
      throw new PlaywrightSetupError(
        "playwright-core",
        "install the optional peer dependency (npm i playwright-core) or the full 'playwright' package",
      );
    }
  }

  private async launch(module: PlaywrightModule): Promise<PlaywrightBrowser> {
    if (this.connection.kind !== "launch") {
      throw new Error("unreachable");
    }
    const options: Record<string, unknown> = {
      headless: this.connection.headless ?? true,
      ...(this.connection.channel ? { channel: this.connection.channel } : {}),
      ...(this.connection.executablePath
        ? { executablePath: this.connection.executablePath }
        : {}),
      ...(this.connection.args ? { args: [...this.connection.args] } : {}),
      ...(this.connection.proxy ? { proxy: { ...this.connection.proxy } } : {}),
      ...(this.connection.launchOptions ?? {}),
    };
    try {
      return await module.chromium.launch(options);
    } catch (error) {
      if (looksLikeMissingBrowser(error)) {
        throw new PlaywrightSetupError(
          "chromium",
          "install a browser build (npx playwright install chromium) or point the runtime at an installed Chrome",
        );
      }
      throw error;
    }
  }
}

/**
 * Tracks the pages a workflow creates and closes exactly what the runtime
 * owns: created pages are always closed; the context and browser are closed
 * only when this runtime created them. Caller-owned contexts and browsers are
 * left untouched.
 */
export class PlaywrightWorkspace {
  private readonly createdPages: PlaywrightPage[] = [];
  private disposed = false;

  constructor(private readonly acquired: AcquiredBrowser) {}

  get context(): PlaywrightBrowserContext {
    return this.acquired.context;
  }

  async newPage(): Promise<PlaywrightPage> {
    const page = await this.acquired.context.newPage();
    this.createdPages.push(page);
    return page;
  }

  async cookies(urls?: string | string[]): Promise<PlaywrightCookie[]> {
    return this.acquired.context.cookies(urls);
  }

  async dispose(): Promise<void> {
    // Idempotent: two callers (the aborted work callback and the outer finally)
    // may both request disposal; only the first performs the closes.
    if (this.disposed) return;
    this.disposed = true;
    for (const page of this.createdPages.reverse()) {
      await safely(() => page.close());
    }
    this.createdPages.length = 0;
    if (this.acquired.ownsContext) {
      await safely(() => this.acquired.context.close());
    }
    // `terminate` and `disconnect` both call browser.close(); the distinction is
    // documented by BrowserDisposal (a connected browser's close() disconnects
    // rather than terminating the remote Chrome). `none` leaves it untouched.
    if (this.acquired.browserDisposal !== "none" && this.acquired.browser) {
      await safely(() => this.acquired.browser!.close());
    }
  }
}

async function newContextOrClose(
  browser: PlaywrightBrowser,
  disposal: BrowserDisposal,
): Promise<PlaywrightBrowserContext> {
  try {
    return await browser.newContext();
  } catch (error) {
    // The browser handle exists but is now unusable; release it per its
    // disposal semantics (terminate a launched browser, disconnect a CDP one).
    if (disposal !== "none") await safely(() => browser.close());
    throw error;
  }
}

async function safely(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Cleanup is best effort and must never surface a raw browser error.
  }
}
