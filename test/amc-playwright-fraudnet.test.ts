import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NpmBraintreeAssetLoader,
  PlaywrightFraudNetDeviceDataProvider,
  collectBraintreeDeviceData,
} from "../src/capabilities/browser/playwright/fraudnet";
import {
  PlaywrightBrowserRuntime,
  PlaywrightSetupError,
} from "../src/capabilities/browser/playwright/runtime";
import {
  BraintreeAssetBundle,
  BraintreeAssetLoader,
} from "../src/capabilities/browser/playwright/fraudnet";
import {
  FakePlaywrightBrowser,
  FakePlaywrightContext,
  FakePlaywrightPage,
} from "./helpers/fake-playwright";
import { BrowserOperationTimeoutError } from "../src/capabilities/browser/playwright/runtime";

const AUTHORIZATION = "sandbox_short_lived_client_token_do_not_log_or_expose";
// The fresh per-attempt fraud session id; Braintree echoes it as correlation_id.
const SESSION_ID = "0123456789abcdef0123456789abcdef";
const FRESH_DEVICE_DATA =
  '{"correlation_id":"0123456789abcdef0123456789abcdef"}';
// A 36-char session id whose Braintree correlation is truncated to 32 chars.
const SESSION_ID_UUID = "00000000-0000-4000-8000-000000000003";
const TRUNCATED_DEVICE_DATA =
  '{"correlation_id":"00000000-0000-4000-8000-00000000"}';

class FakeAssetLoader implements BraintreeAssetLoader {
  loads = 0;
  load(): Promise<BraintreeAssetBundle> {
    this.loads += 1;
    return Promise.resolve({
      client: "/* fake braintree client bundle */",
      dataCollector: "/* fake braintree data-collector bundle */",
      version: "3.144.0",
    });
  }
}

function providerFor(
  page: FakePlaywrightPage,
  loader: BraintreeAssetLoader = new FakeAssetLoader(),
) {
  const context = new FakePlaywrightContext({ page });
  const runtime = new PlaywrightBrowserRuntime({ kind: "context", context });
  return {
    context,
    provider: new PlaywrightFraudNetDeviceDataProvider({
      runtime,
      braintreeAssets: loader,
      timeoutMs: 5_000,
    }),
  };
}

describe("PlaywrightFraudNetDeviceDataProvider", () => {
  it("hands authorization and per-attempt riskCorrelationId to the collector and returns fresh device data", async () => {
    const page = new FakePlaywrightPage({
      evaluateResult: {
        ok: true,
        deviceData: FRESH_DEVICE_DATA,
        diagnostic: "ok",
      },
    });
    const { context, provider } = providerFor(page);
    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    let result;
    try {
      result = await provider.collect({
        orderToken: "00000000-0000-4000-8000-000000000003",
        sessionId: SESSION_ID,
        authorization: AUTHORIZATION,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(result).toMatchObject({
      deviceData: FRESH_DEVICE_DATA,
      fresh: true,
    });
    expect(page.evaluateArgs[0]).toEqual({
      authorization: AUTHORIZATION,
      riskCorrelationId: SESSION_ID,
    });
    expect(page.scriptTags).toHaveLength(2);
    expect(page.gotos[0]?.url).toContain("amctheatres.com");
    // cleanup: page created and closed, caller-owned context untouched
    expect(page.closed).toBe(true);
    expect(context.closed).toBe(false);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("accepts a correlation Braintree truncated to 32 characters as bound", async () => {
    const page = new FakePlaywrightPage({
      evaluateResult: {
        ok: true,
        deviceData: TRUNCATED_DEVICE_DATA,
        diagnostic: "ok",
      },
    });
    const { provider } = providerFor(page);

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID_UUID,
      authorization: AUTHORIZATION,
    });

    expect(result).toMatchObject({
      deviceData: TRUNCATED_DEVICE_DATA,
      fresh: true,
    });
    expect(page.evaluateArgs[0]).toEqual({
      authorization: AUTHORIZATION,
      riskCorrelationId: SESSION_ID_UUID,
    });
  });

  it("rejects a correlation that is not bound to the attempt session", async () => {
    const page = new FakePlaywrightPage({
      evaluateResult: {
        ok: true,
        deviceData: '{"correlation_id":"unrelatedcorrelation1234567890"}',
        diagnostic: "ok",
      },
    });
    const { provider } = providerFor(page);

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
      authorization: AUTHORIZATION,
    });

    expect(result).toMatchObject({ deviceData: null, fresh: false });
  });

  it("fails closed without acquiring a browser when authorization is missing", async () => {
    const page = new FakePlaywrightPage({
      evaluateResult: { ok: true, deviceData: FRESH_DEVICE_DATA },
    });
    const { context, provider } = providerFor(page);

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
    });

    expect(result).toMatchObject({ deviceData: null, fresh: false });
    expect(context.newPageCalls).toBe(0);
  });

  it("returns a sanitized, bounded diagnostic and never leaks the authorization on collector failure", async () => {
    const page = new FakePlaywrightPage({
      evaluateResult: {
        ok: false,
        deviceData: null,
        diagnostic: "client-create-failed",
      },
    });
    const { provider } = providerFor(page);

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
      authorization: AUTHORIZATION,
    });

    expect(result.fresh).toBe(false);
    expect(result.deviceData).toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(AUTHORIZATION);
    expect(result.diagnostic).toMatch(/^[A-Za-z0-9._:-]{1,64}$/);
  });

  it("rejects stale or malformed device data as not fresh", async () => {
    const page = new FakePlaywrightPage({
      evaluateResult: { ok: true, deviceData: "not-json", diagnostic: "ok" },
    });
    const { provider } = providerFor(page);

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
      authorization: AUTHORIZATION,
    });

    expect(result).toMatchObject({ deviceData: null, fresh: false });
  });

  it("returns not-fresh, injects no scripts, and never evaluates when navigation redirects off AMC", async () => {
    const page = new FakePlaywrightPage({
      url: "https://evil.example.com/",
      evaluateResult: {
        ok: true,
        deviceData: FRESH_DEVICE_DATA,
        diagnostic: "ok",
      },
    });
    const { provider } = providerFor(page);

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
      authorization: AUTHORIZATION,
    });

    expect(result).toMatchObject({ deviceData: null, fresh: false });
    expect(page.gotos).toHaveLength(1);
    expect(page.scriptTags).toHaveLength(0);
    expect(page.evaluateArgs).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(AUTHORIZATION);
  });

  it("disposes a late-resolving acquisition after timeout and never collects", async () => {
    const browser = new FakePlaywrightBrowser(
      {
        pageOptions: {
          evaluateResult: {
            ok: true,
            deviceData: FRESH_DEVICE_DATA,
            diagnostic: "ok",
          },
        },
      },
      { newContextDelayMs: 60 },
    );
    const runtime = new PlaywrightBrowserRuntime({ kind: "browser", browser });
    const loader = new FakeAssetLoader();
    const provider = new PlaywrightFraudNetDeviceDataProvider({
      runtime,
      braintreeAssets: loader,
      timeoutMs: 20,
    });

    const result = await provider.collect({
      orderToken: "00000000-0000-4000-8000-000000000003",
      sessionId: SESSION_ID,
      authorization: AUTHORIZATION,
    });

    expect(result).toMatchObject({ deviceData: null, fresh: false });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(browser.context.closed).toBe(true);
    expect(browser.context.newPageCalls).toBe(0);
    expect(loader.loads).toBe(0);
    expect(browser.closed).toBe(false);
  }, 2000);
});

describe("collectBraintreeDeviceData (in-page contract)", () => {
  afterEach(() => {
    delete (globalThis as { braintree?: unknown }).braintree;
  });

  it("invokes client.create and dataCollector.create with riskCorrelationId then tears down", async () => {
    const events: string[] = [];
    let clientCreateArg: unknown;
    let collectorCreateArg: unknown;
    (globalThis as { braintree?: unknown }).braintree = {
      client: {
        create(options: unknown) {
          clientCreateArg = options;
          events.push("client.create");
          return Promise.resolve({ id: "client" });
        },
      },
      dataCollector: {
        create(options: unknown) {
          collectorCreateArg = options;
          events.push("dataCollector.create");
          return Promise.resolve({
            deviceData: FRESH_DEVICE_DATA,
            teardown() {
              events.push("teardown");
              return Promise.resolve();
            },
          });
        },
      },
    };

    const result = await collectBraintreeDeviceData({
      authorization: AUTHORIZATION,
      riskCorrelationId: SESSION_ID,
    });

    expect(result).toMatchObject({ ok: true, deviceData: FRESH_DEVICE_DATA });
    expect(clientCreateArg).toEqual({ authorization: AUTHORIZATION });
    expect(collectorCreateArg).toEqual({
      client: { id: "client" },
      riskCorrelationId: SESSION_ID,
    });
    expect(events).toEqual([
      "client.create",
      "dataCollector.create",
      "teardown",
    ]);
  });

  it("returns a fixed diagnostic and no secret when the collector throws", async () => {
    (globalThis as { braintree?: unknown }).braintree = {
      client: {
        create() {
          return Promise.reject(new Error(`boom with ${AUTHORIZATION}`));
        },
      },
      dataCollector: { create: () => Promise.reject(new Error("unused")) },
    };

    const result = await collectBraintreeDeviceData({
      authorization: AUTHORIZATION,
      riskCorrelationId: SESSION_ID,
    });

    expect(result.ok).toBe(false);
    expect(result.deviceData).toBeNull();
    expect(JSON.stringify(result)).not.toContain(AUTHORIZATION);
    expect(result.diagnostic).toBe("client-create-failed");
  });
});

describe("NpmBraintreeAssetLoader", () => {
  it("resolves and reads the real pinned braintree-web browser bundles", async () => {
    const bundle = await new NpmBraintreeAssetLoader().load();

    expect(bundle.version).toBe("3.144.0");
    expect(bundle.client.length).toBeGreaterThan(1000);
    expect(bundle.dataCollector.length).toBeGreaterThan(1000);
    // The UMD bundles register the components onto window.braintree.*.
    expect(bundle.client).toContain("braintree");
    expect(bundle.dataCollector).toContain("braintree");
  });

  it("throws a typed setup error naming braintree-web when a bundle file is absent", async () => {
    const loader = new NpmBraintreeAssetLoader(
      "dist/browser/does-not-exist.js",
      "dist/browser/also-missing.js",
    );
    const failure = await loader.load().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlaywrightSetupError);
    expect(failure).toMatchObject({
      code: "AMC_PLAYWRIGHT_SETUP_REQUIRED",
      dependency: "braintree-web",
    });
  });
});
