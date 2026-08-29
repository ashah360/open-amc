// Minimal in-memory fakes that structurally satisfy the Playwright surface the
// AMC adapter uses. They let the browser behavioral tests run with no real
// Chromium: ownership/cleanup, cookie scoping, timeouts, and collector teardown
// are all observable through recorded calls and flags.

export interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface FakePageOptions {
  evaluateResults?: unknown[];
  evaluateResult?: unknown;
  gotoImpl?: (url: string) => Promise<void>;
  addScriptTagImpl?: (options: {
    content?: string;
    url?: string;
  }) => Promise<void>;
  url?: string;
}

export class FakePlaywrightPage {
  closed = false;
  gotos: Array<{ url: string; options?: unknown }> = [];
  scriptTags: Array<{ content?: string; url?: string }> = [];
  evaluateArgs: unknown[] = [];
  private readonly evaluateResults: unknown[];
  private readonly constResult: unknown;

  constructor(private readonly options: FakePageOptions = {}) {
    this.evaluateResults = [...(options.evaluateResults ?? [])];
    this.constResult = options.evaluateResult;
  }

  async goto(url: string, options?: unknown): Promise<null> {
    this.gotos.push({ url, options });
    if (this.options.gotoImpl) await this.options.gotoImpl(url);
    return null;
  }

  async evaluate<R>(_fn: unknown, arg?: unknown): Promise<R> {
    this.evaluateArgs.push(arg);
    if (this.evaluateResults.length > 0) {
      return this.evaluateResults.shift() as R;
    }
    return this.constResult as R;
  }

  async addScriptTag(options: {
    content?: string;
    url?: string;
  }): Promise<null> {
    this.scriptTags.push(options);
    if (this.options.addScriptTagImpl)
      await this.options.addScriptTagImpl(options);
    return null;
  }

  url(): string {
    return this.options.url ?? "https://www.amctheatres.com/";
  }

  async waitForTimeout(_ms: number): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeContextOptions {
  cookies?: FakeCookie[];
  page?: FakePlaywrightPage;
  pageOptions?: FakePageOptions;
}

export class FakePlaywrightContext {
  closed = false;
  newPageCalls = 0;
  cookieUrlArgs: Array<string | string[] | undefined> = [];
  defaultTimeout?: number;
  defaultNavigationTimeout?: number;
  readonly createdPages: FakePlaywrightPage[] = [];
  cookieList: FakeCookie[];

  constructor(private readonly options: FakeContextOptions = {}) {
    this.cookieList = options.cookies ?? [];
  }

  async newPage(): Promise<FakePlaywrightPage> {
    this.newPageCalls += 1;
    const page =
      this.options.page ?? new FakePlaywrightPage(this.options.pageOptions);
    this.createdPages.push(page);
    return page;
  }

  async cookies(urls?: string | string[]): Promise<FakeCookie[]> {
    this.cookieUrlArgs.push(urls);
    return this.cookieList;
  }

  setDefaultTimeout(timeout: number): void {
    this.defaultTimeout = timeout;
  }

  setDefaultNavigationTimeout(timeout: number): void {
    this.defaultNavigationTimeout = timeout;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export interface FakeBrowserBehavior {
  /** Make newContext reject with this error (to test cleanup on failure). */
  newContextError?: Error;
  /** Make newContext hang forever (to test acquisition under the timeout budget). */
  newContextHang?: boolean;
  /** Resolve newContext only after this delay (to test late acquisition). */
  newContextDelayMs?: number;
}

export class FakePlaywrightBrowser {
  closed = false;
  newContextCalls = 0;
  readonly context: FakePlaywrightContext;

  constructor(
    options: FakeContextOptions = {},
    private readonly behavior: FakeBrowserBehavior = {},
  ) {
    this.context = new FakePlaywrightContext(options);
  }

  async newContext(
    _options?: Record<string, unknown>,
  ): Promise<FakePlaywrightContext> {
    this.newContextCalls += 1;
    if (this.behavior.newContextHang) {
      return new Promise<FakePlaywrightContext>(() => undefined);
    }
    if (this.behavior.newContextDelayMs !== undefined) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.behavior.newContextDelayMs),
      );
    }
    if (this.behavior.newContextError) throw this.behavior.newContextError;
    return this.context;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isConnected(): boolean {
    return !this.closed;
  }
}

export interface FakeChromium {
  launchCalls: Array<Record<string, unknown>>;
  connectCalls: string[];
  connectRawArgs: Array<[unknown, unknown]>;
  launch(options?: Record<string, unknown>): Promise<FakePlaywrightBrowser>;
  connectOverCDP(
    endpointURL: string,
    options?: Record<string, unknown>,
  ): Promise<FakePlaywrightBrowser>;
}

export function fakePlaywrightModule(opts: {
  launch?: FakePlaywrightBrowser;
  connect?: FakePlaywrightBrowser;
  launchError?: Error;
}): { chromium: FakeChromium } {
  const chromium: FakeChromium = {
    launchCalls: [],
    connectCalls: [],
    connectRawArgs: [],
    async launch(
      options?: Record<string, unknown>,
    ): Promise<FakePlaywrightBrowser> {
      this.launchCalls.push(options ?? {});
      if (opts.launchError) throw opts.launchError;
      if (!opts.launch) throw new Error("fake module has no launch browser");
      return opts.launch;
    },
    async connectOverCDP(
      endpointURL: string,
      options?: Record<string, unknown>,
    ): Promise<FakePlaywrightBrowser> {
      this.connectRawArgs.push([endpointURL, options]);
      this.connectCalls.push(
        typeof endpointURL === "string" ? endpointURL : "",
      );
      if (!opts.connect) throw new Error("fake module has no connect browser");
      return opts.connect;
    },
  };
  return { chromium };
}
