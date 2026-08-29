import { describe, expect, it } from "vitest";
import {
  PlaywrightBrowserRuntime,
  PlaywrightSetupError,
  PlaywrightWorkspace,
} from "../src/capabilities/browser/playwright/runtime";
import {
  FakePlaywrightBrowser,
  FakePlaywrightContext,
  fakePlaywrightModule,
} from "./helpers/fake-playwright";

describe("PlaywrightBrowserRuntime.acquire", () => {
  it("launches Playwright-managed Chromium and owns the browser (terminate) and context", async () => {
    const browser = new FakePlaywrightBrowser();
    const module = fakePlaywrightModule({ launch: browser });
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "launch", channel: "chrome", headless: true },
      { loadModule: async () => module },
    );

    const acquired = await runtime.acquire();

    expect(module.chromium.launchCalls).toHaveLength(1);
    expect(module.chromium.launchCalls[0]).toMatchObject({
      channel: "chrome",
      headless: true,
    });
    expect(acquired.browserDisposal).toBe("terminate");
    expect(acquired.ownsContext).toBe(true);
    expect(acquired.browser).toBe(browser);
    expect(browser.newContextCalls).toBe(1);
  });

  it("connects over CDP passing endpointURL and options positionally, owning a disconnect boundary", async () => {
    const browser = new FakePlaywrightBrowser();
    const module = fakePlaywrightModule({ connect: browser });
    const runtime = new PlaywrightBrowserRuntime(
      {
        kind: "cdp",
        endpointURL: "http://127.0.0.1:9222",
        connectOptions: { slowMo: 5 },
      },
      { loadModule: async () => module },
    );

    const acquired = await runtime.acquire();

    // playwright-core@1.62: connectOverCDP(endpointURL, options) — positional.
    expect(module.chromium.connectRawArgs).toHaveLength(1);
    expect(module.chromium.connectRawArgs[0]![0]).toBe("http://127.0.0.1:9222");
    expect(typeof module.chromium.connectRawArgs[0]![0]).toBe("string");
    expect(module.chromium.connectRawArgs[0]![1]).toMatchObject({ slowMo: 5 });
    // Closing a CDP connection disconnects the local Playwright Browser without
    // terminating the caller's remote Chrome.
    expect(acquired.browserDisposal).toBe("disconnect");
    expect(acquired.ownsContext).toBe(true);
    expect(browser.newContextCalls).toBe(1);
  });

  it("uses a caller-supplied browser without closing it (no disposal)", async () => {
    const browser = new FakePlaywrightBrowser();
    const runtime = new PlaywrightBrowserRuntime({ kind: "browser", browser });

    const acquired = await runtime.acquire();

    expect(acquired.browserDisposal).toBe("none");
    expect(acquired.ownsContext).toBe(true);
    expect(browser.newContextCalls).toBe(1);
  });

  it("uses a caller-supplied context without owning it", async () => {
    const context = new FakePlaywrightContext();
    const runtime = new PlaywrightBrowserRuntime({ kind: "context", context });

    const acquired = await runtime.acquire();

    expect(acquired.browserDisposal).toBe("none");
    expect(acquired.ownsContext).toBe(false);
    expect(acquired.context).toBe(context);
  });

  it("closes the launched browser when newContext fails", async () => {
    const browser = new FakePlaywrightBrowser(
      {},
      { newContextError: new Error("context boom") },
    );
    const module = fakePlaywrightModule({ launch: browser });
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "launch" },
      { loadModule: async () => module },
    );

    await expect(runtime.acquire()).rejects.toThrow(/context boom/);
    expect(browser.closed).toBe(true);
  });

  it("disconnects the CDP browser when newContext fails", async () => {
    const browser = new FakePlaywrightBrowser(
      {},
      { newContextError: new Error("cdp context boom") },
    );
    const module = fakePlaywrightModule({ connect: browser });
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "cdp", endpointURL: "http://127.0.0.1:9222" },
      { loadModule: async () => module },
    );

    await expect(runtime.acquire()).rejects.toThrow(/cdp context boom/);
    expect(browser.closed).toBe(true);
  });

  it("throws one typed setup error naming the missing optional dependency", async () => {
    const runtime = new PlaywrightBrowserRuntime(
      { kind: "launch" },
      {
        loadModule: async () => {
          throw new Error("Cannot find module 'playwright-core'");
        },
      },
    );

    const failure = await runtime.acquire().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PlaywrightSetupError);
    expect(failure).toMatchObject({
      code: "AMC_PLAYWRIGHT_SETUP_REQUIRED",
      dependency: "playwright-core",
    });
  });
});

describe("PlaywrightWorkspace.dispose", () => {
  it("closes created pages and the context and browser it owns", async () => {
    const browser = new FakePlaywrightBrowser();
    const context = browser.context;
    const workspace = new PlaywrightWorkspace({
      context,
      ownsContext: true,
      browserDisposal: "terminate",
      browser,
    });
    await workspace.newPage();
    const page = context.createdPages[0]!;

    await workspace.dispose();

    expect(page.closed).toBe(true);
    expect(context.closed).toBe(true);
    expect(browser.closed).toBe(true);
  });

  it("disconnects (closes) a CDP browser connection it created", async () => {
    const browser = new FakePlaywrightBrowser();
    const context = browser.context;
    const workspace = new PlaywrightWorkspace({
      context,
      ownsContext: true,
      browserDisposal: "disconnect",
      browser,
    });
    await workspace.newPage();

    await workspace.dispose();

    expect(context.closed).toBe(true);
    expect(browser.closed).toBe(true);
  });

  it("never closes a caller-supplied browser or context", async () => {
    const browser = new FakePlaywrightBrowser();
    const context = browser.context;
    const workspace = new PlaywrightWorkspace({
      context,
      ownsContext: false,
      browserDisposal: "none",
      browser,
    });
    await workspace.newPage();
    const page = context.createdPages[0]!;

    await workspace.dispose();

    expect(page.closed).toBe(true);
    expect(context.closed).toBe(false);
    expect(browser.closed).toBe(false);
  });
});
