// The portable, concrete Playwright browser capability for AMC. This subpath is
// the recommended browser adapter: one coherent `playwright-core` stack that
// supports Playwright-managed Chromium (installed explicitly via
// `npx playwright install chromium`), an installed Chrome via channel/executable,
// an existing Chrome over CDP, and caller-supplied Browser/BrowserContext
// objects.
//
// Importing this module does NOT load playwright-core or download any browser;
// the module is resolved lazily only when a launch/connect actually happens,
// and a missing optional dependency/browser surfaces as one typed
// PlaywrightSetupError.

export {
  PlaywrightBrowserRuntime,
  PlaywrightWorkspace,
  PlaywrightSetupError,
  PlaywrightConnectionError,
  BrowserOperationTimeoutError,
  preflightCdpEndpoint,
  runWithBrowserBudget,
} from "./runtime";
export type {
  AcquiredBrowser,
  PlaywrightBrowser,
  PlaywrightBrowserContext,
  PlaywrightBrowserRuntimeOptions,
  PlaywrightChromium,
  PlaywrightConnection,
  PlaywrightCookie,
  PlaywrightModule,
  PlaywrightPage,
} from "./runtime";

export { PlaywrightAmcBrowserRefresher } from "./browser-refresh";
export type { PlaywrightAmcBrowserRefresherOptions } from "./browser-refresh";

export {
  PlaywrightFraudNetDeviceDataProvider,
  NpmBraintreeAssetLoader,
  collectBraintreeDeviceData,
} from "./fraudnet";
export type {
  BraintreeAssetBundle,
  BraintreeAssetLoader,
  CollectDeviceDataArgs,
  CollectDeviceDataResult,
  PlaywrightFraudNetDeviceDataProviderOptions,
} from "./fraudnet";

// The contracts these adapters implement, re-exported for convenience.
export type { AmcBrowserRefresher } from "../../../client/browser-refresh";
export type { DeviceDataProvider } from "../../../commerce/direct-braintree-tokenizer";
