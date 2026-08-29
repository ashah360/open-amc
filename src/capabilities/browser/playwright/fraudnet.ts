import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DeviceDataProvider } from "../../../commerce/direct-braintree-tokenizer";
import {
  BrowserOperationTimeoutError,
  PlaywrightBrowserRuntime,
  PlaywrightPage,
  PlaywrightSetupError,
  PlaywrightWorkspace,
  runWithBrowserBudget,
} from "./runtime";

const AMC_ORIGIN = "https://www.amctheatres.com";
const AMC_GRAPH_ORIGIN = "https://graph.amctheatres.com";
const DEFAULT_ORIGIN_URL = `${AMC_ORIGIN}/`;
const DEFAULT_TIMEOUT_MS = 60_000;
const CORRELATION = /^[A-Za-z0-9_-]{16,128}$/;

/** The official pinned braintree-web component bundles, as source to inject. */
export interface BraintreeAssetBundle {
  client: string;
  dataCollector: string;
  /** Installed braintree-web version, for a bounded diagnostic only. */
  version?: string;
}

export interface BraintreeAssetLoader {
  load(): Promise<BraintreeAssetBundle>;
}

/**
 * Loads the official pinned braintree-web `client` and `data-collector` browser
 * bundles from the optional `braintree-web` npm dependency. When that package
 * is not installed it fails with the single typed setup error naming it, so a
 * caller knows exactly what optional dependency to add.
 */
export class NpmBraintreeAssetLoader implements BraintreeAssetLoader {
  // braintree-web@3.144.0 publishes UMD component bundles as `.js` (not
  // `.min.js`) under dist/browser; each registers window.braintree.<component>.
  constructor(
    private readonly clientRelativePath = "dist/browser/client.js",
    private readonly dataCollectorRelativePath = "dist/browser/data-collector.js",
  ) {}

  async load(): Promise<BraintreeAssetBundle> {
    let packageDir: string;
    let version: string | undefined;
    try {
      const manifestPath = require.resolve("braintree-web/package.json");
      packageDir = dirname(manifestPath);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: unknown;
      };
      version =
        typeof manifest.version === "string" ? manifest.version : undefined;
    } catch {
      throw new PlaywrightSetupError(
        "braintree-web",
        "install the optional peer dependency (npm i braintree-web) to collect FraudNet device data",
      );
    }
    try {
      const client = readFileSync(
        join(packageDir, this.clientRelativePath),
        "utf8",
      );
      const dataCollector = readFileSync(
        join(packageDir, this.dataCollectorRelativePath),
        "utf8",
      );
      return { client, dataCollector, version };
    } catch {
      throw new PlaywrightSetupError(
        "braintree-web",
        "the installed braintree-web is missing its client/data-collector browser bundles",
      );
    }
  }
}

export interface CollectDeviceDataArgs {
  authorization: string;
  /**
   * The fresh per-attempt fraud session id, passed to
   * braintree.dataCollector.create as riskCorrelationId so the returned
   * correlation is bound to this attempt.
   */
  riskCorrelationId: string;
}

export interface CollectDeviceDataResult {
  ok: boolean;
  deviceData: string | null;
  diagnostic: string;
}

/**
 * The in-page collection contract. It reads the injected braintree-web globals,
 * invokes braintree.client.create and braintree.dataCollector.create with the
 * short-lived authorization, extracts deviceData, tears the collector down, and
 * returns only a small structured result. All provider errors are swallowed
 * into a fixed diagnostic token so authorization/card/URL detail can never
 * escape. It is exported so its behavior is directly testable in Node with a
 * fake braintree global, and it is also the exact function serialized into the
 * page.
 */
export async function collectBraintreeDeviceData(
  args: CollectDeviceDataArgs,
): Promise<CollectDeviceDataResult> {
  const scope = globalThis as { braintree?: unknown };
  const braintree = scope.braintree as
    | {
        client?: {
          create(options: { authorization: string }): Promise<unknown>;
        };
        dataCollector?: {
          create(options: {
            client: unknown;
            riskCorrelationId: string;
          }): Promise<{
            deviceData?: unknown;
            teardown?: () => Promise<void>;
          }>;
        };
      }
    | undefined;
  if (!braintree || !braintree.client || !braintree.dataCollector) {
    return { ok: false, deviceData: null, diagnostic: "braintree-unavailable" };
  }
  let client: unknown;
  try {
    client = await braintree.client.create({
      authorization: args.authorization,
    });
  } catch {
    return { ok: false, deviceData: null, diagnostic: "client-create-failed" };
  }
  let collector:
    { deviceData?: unknown; teardown?: () => Promise<void> } | undefined;
  try {
    collector = await braintree.dataCollector.create({
      client,
      riskCorrelationId: args.riskCorrelationId,
    });
  } catch {
    client = null;
    return {
      ok: false,
      deviceData: null,
      diagnostic: "collector-create-failed",
    };
  }
  const deviceData =
    typeof collector?.deviceData === "string" ? collector.deviceData : null;
  try {
    if (collector && typeof collector.teardown === "function") {
      await collector.teardown();
    }
  } catch {
    // Teardown is best effort; a provider error must never surface.
  }
  // Blank the local references to the collector/client once we have the string.
  client = null;
  collector = undefined;
  return deviceData
    ? { ok: true, deviceData, diagnostic: "ok" }
    : { ok: false, deviceData: null, diagnostic: "device-data-missing" };
}

export interface PlaywrightFraudNetDeviceDataProviderOptions {
  runtime: PlaywrightBrowserRuntime;
  /** Loads the braintree-web bundles. Defaults to the npm dependency loader. */
  braintreeAssets?: BraintreeAssetLoader;
  /** Allowlisted AMC origin used to host the collector. */
  originUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Concrete Playwright DeviceDataProvider that runs the real Braintree FraudNet
 * data-collector. It accepts a short-lived Braintree client-token
 * authorization, loads the pinned braintree-web bundles, collects deviceData in
 * an allowlisted AMC page, validates freshness, and returns only the
 * deviceData/fresh/bounded-diagnostic contract. It never exposes the
 * authorization, cookies, request bodies, raw provider errors, card data, or
 * URLs through results, errors, or logs, and closes only the resources it
 * created.
 */
export class PlaywrightFraudNetDeviceDataProvider implements DeviceDataProvider {
  private readonly runtime: PlaywrightBrowserRuntime;
  private readonly assets: BraintreeAssetLoader;
  private readonly originUrl: string;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;

  constructor(options: PlaywrightFraudNetDeviceDataProviderOptions) {
    this.runtime = options.runtime;
    this.assets = options.braintreeAssets ?? new NpmBraintreeAssetLoader();
    this.originUrl = assertAmcUrl(options.originUrl ?? DEFAULT_ORIGIN_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = options.signal;
  }

  async collect(input: {
    orderToken: string;
    sessionId: string;
    authorization?: string;
  }): Promise<{
    deviceData: string | null;
    fresh: boolean;
    diagnostic?: string;
  }> {
    if (!input.authorization) return notFresh("authorization-missing");
    const signal = this.signal;
    if (signal?.aborted) return notFresh("aborted");
    const authorization = input.authorization;
    const sessionId = input.sessionId;

    // Acquisition runs under the same budget as collection, so a hung module
    // load, launch, connect, or newContext is aborted too. Any workspace that
    // acquisition produced is still disposed.
    let workspace: PlaywrightWorkspace | undefined;
    try {
      return await runWithBrowserBudget(
        async (budgetSignal) => {
          workspace = await this.runtime.open();
          // If the budget elapsed while acquisition was pending, the outer
          // finally already ran with no workspace: dispose the late one here
          // and do not collect.
          if (budgetSignal.aborted) {
            await workspace.dispose();
            return notFresh("timeout");
          }
          return this.runCollect(workspace, authorization, sessionId);
        },
        { timeoutMs: this.timeoutMs, signal },
      );
    } catch (error) {
      if (error instanceof PlaywrightSetupError) throw error;
      if (error instanceof BrowserOperationTimeoutError) {
        return notFresh(error.reason);
      }
      return notFresh("collector-failed");
    } finally {
      if (workspace) await workspace.dispose();
    }
  }

  private async runCollect(
    workspace: PlaywrightWorkspace,
    authorization: string,
    sessionId: string,
  ): Promise<{
    deviceData: string | null;
    fresh: boolean;
    diagnostic?: string;
  }> {
    const assets = await this.assets.load();
    const page: PlaywrightPage = await workspace.newPage();
    await page.goto(this.originUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs,
    });
    // Verify where navigation actually landed: a redirect off an allowlisted
    // AMC origin must stop us before any script injection or authorization
    // handoff into the page.
    if (!isAllowedAmcOrigin(page.url())) {
      return notFresh("origin-untrusted");
    }
    await page.addScriptTag({ content: assets.client });
    await page.addScriptTag({ content: assets.dataCollector });

    const collected = await page.evaluate<CollectDeviceDataResult>(
      collectBraintreeDeviceData,
      { authorization, riskCorrelationId: sessionId },
    );

    if (
      !collected ||
      collected.ok !== true ||
      typeof collected.deviceData !== "string"
    ) {
      return notFresh(collected?.diagnostic ?? "collector-failed");
    }
    const correlation = parseCorrelationId(collected.deviceData);
    if (correlation === null || !CORRELATION.test(correlation)) {
      return notFresh("correlation-invalid");
    }
    // Bind the returned correlation to this attempt's fraud session. Braintree
    // may expose the risk correlation id truncated to 32 characters.
    if (correlation !== sessionId && correlation !== sessionId.slice(0, 32)) {
      return notFresh("correlation-unbound");
    }
    return { deviceData: collected.deviceData, fresh: true, diagnostic: "ok" };
  }
}

function notFresh(diagnostic: string): {
  deviceData: null;
  fresh: false;
  diagnostic: string;
} {
  return {
    deviceData: null,
    fresh: false,
    diagnostic: diagnostic.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 64),
  };
}

function parseCorrelationId(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof (parsed as { correlation_id?: unknown }).correlation_id ===
        "string"
    ) {
      return (parsed as { correlation_id: string }).correlation_id;
    }
    return null;
  } catch {
    return null;
  }
}

function isAllowedAmcOrigin(rawUrl: string): boolean {
  try {
    const origin = new URL(rawUrl).origin;
    return origin === AMC_ORIGIN || origin === AMC_GRAPH_ORIGIN;
  } catch {
    return false;
  }
}

function assertAmcUrl(rawUrl: string): string {
  if (!isAllowedAmcOrigin(rawUrl)) {
    throw new Error(
      "AMC FraudNet origin URL is outside the allowed AMC origin",
    );
  }
  return new URL(rawUrl).toString();
}
