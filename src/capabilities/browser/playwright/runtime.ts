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
export type PlaywrightConnection =
  | {
      readonly kind: "launch";
      readonly channel?: string;
      readonly executablePath?: string;
      readonly headless?: boolean;
      readonly args?: readonly string[];
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

  constructor(
    private readonly connection: PlaywrightConnection,
    options: PlaywrightBrowserRuntimeOptions = {},
  ) {
    this.loadModule = options.loadModule ?? defaultLoadModule;
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
        const module = await this.loadPlaywright();
        const browser = await module.chromium.connectOverCDP(
          this.connection.endpointURL,
          this.connection.connectOptions,
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
