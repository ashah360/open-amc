import { decodeAmcBootstrap, AmcSession } from "../../../client/session";
import {
  AmcFingerprintProfile,
  PEET_FINGERPRINT_URL,
  sanitizePeetFingerprint,
} from "../../../client/fingerprint";
import {
  AMC_ACCESS_CHECK_DOCUMENT,
  AMC_ACCESS_CHECK_OPERATION,
} from "../../../client/auth-probe";
import {
  AmcBrowserRefresher,
  BrowserRefreshUnavailableError,
} from "../../../client/browser-refresh";
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
const DEFAULT_TIMEOUT_MS = 190_000;
// The settlement loop must outlast a real Cloudflare jsd interstitial: ~40s of
// conservative polling (30 attempts × ~1.3s) before giving up, well within the
// overall browser budget.
const DEFAULT_ADMISSION_ATTEMPTS = 30;
const DEFAULT_ADMISSION_INTERVAL_MS = 1_300;

/**
 * Browser-side AccessCheck flags. Computed inside the browser context so the
 * response body/cookies never cross into Node; only these small booleans do.
 */
interface BrowserAccessCheck {
  status: number;
  hasData: boolean;
  hasErrors: boolean;
  challenge: boolean;
}

/**
 * In-browser AccessCheck: POST the canonical harmless GraphQL AccessCheck to
 * the graph origin from the SAME context/egress and reduce the response to
 * small non-secret booleans. Success proves the anti-bot layer (Cloudflare jsd)
 * has settled and the graph origin returns real JSON — not a 403 challenge —
 * BEFORE any cookie is exported. The response body is never returned or logged.
 */
const BROWSER_ACCESS_CHECK_SCRIPT = `(async () => {
  try {
    const response = await fetch(${JSON.stringify(`${AMC_GRAPH_ORIGIN}/`)}, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", accept: "*/*" },
      body: JSON.stringify({
        operationName: ${JSON.stringify(AMC_ACCESS_CHECK_OPERATION)},
        query: ${JSON.stringify(AMC_ACCESS_CHECK_DOCUMENT)},
        variables: {},
      }),
    });
    const text = await response.text();
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    let hasData = false;
    let hasErrors = false;
    if (contentType.indexOf("application/json") !== -1) {
      try {
        const parsed = JSON.parse(text);
        hasData = !!parsed && typeof parsed === "object" && parsed.data != null;
        hasErrors = !!parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0;
      } catch (_) {}
    }
    const challenge = /just a moment|cf-chl|challenge-platform|queue-it|attention required/i.test(text);
    return { status: response.status, hasData: hasData, hasErrors: hasErrors, challenge: challenge };
  } catch (_) {
    return { status: 0, hasData: false, hasErrors: false, challenge: false };
  }
})()`;

/** Cookie domains this adapter is permitted to export. */
const AMC_COOKIE_DOMAINS = new Set([
  ".amctheatres.com",
  "amctheatres.com",
  "www.amctheatres.com",
  ".www.amctheatres.com",
  "graph.amctheatres.com",
  ".graph.amctheatres.com",
]);

/**
 * In-page expression that proves the session cleared the waiting room by
 * finding the real listing DOM. It is a string (not a compiled function) so the
 * adapter never depends on DOM lib types and so the exact selectors are
 * auditable. It reads nothing sensitive and returns only small integers/flags.
 *
 * Admission requires only the exact allowed AMC origin plus rendered movie
 * sections. `formatGroups` and `showtimeLinks` are still counted, but they
 * describe showtime AVAILABILITY, not admission: an admitted official listing
 * legitimately renders zero remaining performances late in the provider day.
 */
const ADMISSION_SCRIPT = `(() => {
  const movieSections = document.querySelectorAll('section[aria-label^="Showtimes for "]').length;
  const formatGroups = document.querySelectorAll('li[role="listitem"][aria-label$=" Showtimes"]').length;
  const showtimeLinks = Array.from(document.querySelectorAll('a[href^="/showtimes/"]'))
    .filter((anchor) => /^\\/showtimes\\/\\d+$/.test(anchor.getAttribute('href') || '')).length;
  return {
    allowedOrigin: location.origin === ${JSON.stringify(AMC_ORIGIN)},
    movieSections,
    formatGroups,
    showtimeLinks,
  };
})()`;

interface AdmissionSignals {
  allowedOrigin: boolean;
  movieSections: number;
  formatGroups: number;
  showtimeLinks: number;
}

export interface PlaywrightAmcBrowserRefresherOptions {
  /** The concrete Playwright runtime/connection to acquire a context from. */
  runtime: PlaywrightBrowserRuntime;
  /**
   * AMC listing URL used to prove admission. Required — there is no built-in
   * venue default; callers derive it from their own official theater URL
   * (e.g. via `resolveOfficialAmcTheaterUrl`). Must be an amctheatres.com URL.
   */
  listingUrl: string;
  /** Overall budget for the whole refresh transaction. */
  timeoutMs?: number;
  /** Number of admission polls before failing closed. */
  admissionAttempts?: number;
  /** Delay between admission polls. */
  admissionIntervalMs?: number;
  /** Optional default AbortSignal; `refresh` may override per call. */
  signal?: AbortSignal;
  /**
   * Capture and self-align the browser's TLS/H2/header fingerprint after
   * admission (default true). This is the ONLY code path that ever contacts
   * the fixed {@link PEET_FINGERPRINT_URL}; ordinary reads never do. Failure to
   * capture is non-fatal: the session is returned without a fingerprint and the
   * caller's direct canary decides success with the stock profile.
   */
  captureFingerprint?: boolean;
  /**
   * Test/advanced seam that returns the raw fingerprint capture from the
   * browser's own egress. Defaults to navigating {@link PEET_FINGERPRINT_URL}
   * in the same context and reading the JSON body.
   */
  fingerprintFetcher?: (workspace: PlaywrightWorkspace) => Promise<unknown>;
  /**
   * Require a successful browser-side GraphQL AccessCheck (proving Cloudflare
   * jsd settled) before exporting cookies (default true). Disabling it is for
   * advanced/testing only and is unsafe against real anti-bot interstitials.
   */
  requireBrowserGraphTrust?: boolean;
  /**
   * Test/advanced seam returning the browser-side AccessCheck flags. Defaults
   * to running {@link BROWSER_ACCESS_CHECK_SCRIPT} in the listing page.
   */
  browserTrustFetcher?: (page: PlaywrightPage) => Promise<BrowserAccessCheck>;
}

/**
 * Concrete Playwright implementation of AmcBrowserRefresher. It navigates an
 * allowlisted AMC listing URL, proves semantic admission, exports only
 * AMC/AMC-GraphQL scoped cookies, and closes only the pages/contexts/browsers
 * it created (caller-owned contexts and browsers are left open). It never
 * executes or retries a commerce write.
 */
export class PlaywrightAmcBrowserRefresher implements AmcBrowserRefresher {
  private readonly runtime: PlaywrightBrowserRuntime;
  private readonly listingUrl: string;
  private readonly timeoutMs: number;
  private readonly admissionAttempts: number;
  private readonly admissionIntervalMs: number;
  private readonly signal?: AbortSignal;
  private readonly captureFingerprint: boolean;
  private readonly fingerprintFetcher?: (
    workspace: PlaywrightWorkspace,
  ) => Promise<unknown>;
  private readonly requireBrowserGraphTrust: boolean;
  private readonly browserTrustFetcher?: (
    page: PlaywrightPage,
  ) => Promise<BrowserAccessCheck>;

  constructor(options: PlaywrightAmcBrowserRefresherOptions) {
    this.runtime = options.runtime;
    if (!options.listingUrl) {
      throw new Error(
        "an explicit AMC listing URL is required (no built-in venue default)",
      );
    }
    this.listingUrl = assertAmcUrl(options.listingUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.admissionAttempts =
      options.admissionAttempts ?? DEFAULT_ADMISSION_ATTEMPTS;
    this.admissionIntervalMs =
      options.admissionIntervalMs ?? DEFAULT_ADMISSION_INTERVAL_MS;
    this.signal = options.signal;
    this.captureFingerprint = options.captureFingerprint ?? true;
    this.fingerprintFetcher = options.fingerprintFetcher;
    this.requireBrowserGraphTrust = options.requireBrowserGraphTrust ?? true;
    this.browserTrustFetcher = options.browserTrustFetcher;
  }

  async refresh(
    _previous?: AmcSession | null,
    options?: { signal?: AbortSignal },
  ): Promise<AmcSession> {
    const signal = options?.signal ?? this.signal;
    if (signal?.aborted) throw new BrowserOperationTimeoutError("aborted");

    // Acquisition (module load, launch/connect, newContext) runs under the same
    // budget as navigation, so a hung launch/connect is aborted too. Whatever
    // workspace acquisition produced is still disposed.
    let workspace: PlaywrightWorkspace | undefined;
    try {
      return await runWithBrowserBudget(
        async (budgetSignal) => {
          workspace = await this.acquireWorkspace();
          // If the budget already elapsed while acquisition was pending, the
          // outer finally has already run (workspace was still undefined then),
          // so dispose the late workspace here and do not proceed.
          if (budgetSignal.aborted) {
            await workspace.dispose();
            throw new BrowserOperationTimeoutError("timeout");
          }
          return this.runRefresh(workspace, budgetSignal);
        },
        { timeoutMs: this.timeoutMs, signal },
      );
    } finally {
      if (workspace) await workspace.dispose();
    }
  }

  private async acquireWorkspace(): Promise<PlaywrightWorkspace> {
    try {
      return await this.runtime.open();
    } catch (error) {
      // A missing dependency/browser is a typed setup error the caller can act
      // on; anything else collapses to an opaque transport failure.
      if (error instanceof PlaywrightSetupError) throw error;
      throw new BrowserRefreshUnavailableError("transport");
    }
  }

  private async runRefresh(
    workspace: PlaywrightWorkspace,
    signal?: AbortSignal,
  ): Promise<AmcSession> {
    let page: PlaywrightPage;
    try {
      page = await workspace.newPage();
      await page.goto(this.listingUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs,
      });
    } catch {
      throw new BrowserRefreshUnavailableError("navigation");
    }

    if (!(await this.proveAdmission(page, signal))) {
      throw new BrowserRefreshUnavailableError("semantic");
    }

    // A 200 listing DOM is NOT sufficient: real Cloudflare jsd can still 403 the
    // graph origin and static subresources for seconds after the document
    // renders. Prove a harmless browser-side GraphQL AccessCheck settles from
    // this same context/egress BEFORE exporting any cookie, so we never persist
    // a premature session that the direct canary would then reject.
    if (
      this.requireBrowserGraphTrust &&
      !(await this.proveBrowserGraphTrust(page, signal))
    ) {
      throw new BrowserRefreshUnavailableError("browser-trust");
    }

    // Self-align the direct-transport fingerprint from the SAME browser/context
    // egress. This is an explicit auth-repair side effect only; it is bounded,
    // sanitized immediately, and non-fatal on failure.
    const fingerprint = await this.captureBrowserFingerprint(workspace);

    try {
      const cookies = await workspace.cookies([AMC_ORIGIN, AMC_GRAPH_ORIGIN]);
      const scoped = cookies
        .filter((cookie) =>
          AMC_COOKIE_DOMAINS.has(String(cookie.domain).toLowerCase()),
        )
        .map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          session:
            cookie.expires === -1 ||
            !Number.isFinite(cookie.expires) ||
            cookie.expires <= 0,
          ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        }));
      const session = decodeAmcBootstrap(
        Buffer.from(JSON.stringify({ cookies: scoped })),
      );
      return fingerprint ? { ...session, fingerprint } : session;
    } catch {
      throw new BrowserRefreshUnavailableError("cookie-export");
    }
  }

  /**
   * Capture and sanitize the browser's own fingerprint. Non-fatal: any failure
   * (disabled, navigation/parse error, oversize, malformed) resolves to
   * undefined so repair still succeeds on cookies alone and the direct canary
   * decides with the stock profile. Never logs the raw capture.
   */
  private async captureBrowserFingerprint(
    workspace: PlaywrightWorkspace,
  ): Promise<AmcFingerprintProfile | undefined> {
    if (!this.captureFingerprint) return undefined;
    try {
      const raw = await (this.fingerprintFetcher ?? defaultFingerprintFetch)(
        workspace,
      );
      return sanitizePeetFingerprint(raw);
    } catch {
      return undefined;
    }
  }

  private async proveAdmission(
    page: PlaywrightPage,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.admissionAttempts; attempt++) {
      if (signal?.aborted) throw new BrowserOperationTimeoutError("aborted");
      let signals: AdmissionSignals | null = null;
      try {
        signals = await page.evaluate<AdmissionSignals>(ADMISSION_SCRIPT);
      } catch {
        signals = null;
      }
      // Admission = allowed origin + rendered movie sections. Availability
      // counters (formatGroups/showtimeLinks) may legitimately be zero on an
      // empty provider day and must not be required. Origin-only, title-only,
      // challenge, or empty pages (movieSections === 0) stay rejected. The
      // exported jar is still direct-canary-gated by the caller before
      // persistence.
      if (
        signals &&
        signals.allowedOrigin === true &&
        signals.movieSections > 0
      ) {
        return true;
      }
      if (attempt < this.admissionAttempts - 1) {
        await page.waitForTimeout(this.admissionIntervalMs);
      }
    }
    return false;
  }

  /**
   * Bounded quiet-settlement loop: poll the harmless browser-side GraphQL
   * AccessCheck until it returns a real 200 JSON `data` response with no errors
   * and no challenge markers, or the attempt budget is exhausted. It never
   * re-navigates and never hammers subresources — one AccessCheck per interval.
   * Respects the AbortSignal between attempts.
   */
  private async proveBrowserGraphTrust(
    page: PlaywrightPage,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.admissionAttempts; attempt++) {
      if (signal?.aborted) throw new BrowserOperationTimeoutError("aborted");
      let check: BrowserAccessCheck | null = null;
      try {
        check = await (this.browserTrustFetcher
          ? this.browserTrustFetcher(page)
          : page.evaluate<BrowserAccessCheck>(BROWSER_ACCESS_CHECK_SCRIPT));
      } catch {
        check = null;
      }
      if (
        check &&
        check.status === 200 &&
        check.hasData === true &&
        check.hasErrors === false &&
        check.challenge === false
      ) {
        return true;
      }
      if (attempt < this.admissionAttempts - 1) {
        await page.waitForTimeout(this.admissionIntervalMs);
      }
    }
    return false;
  }
}

/**
 * Default fingerprint capture: navigate the fixed peet endpoint in the same
 * browser context (same egress) and read the JSON body it renders. The body is
 * returned as a parsed object for the sanitizer; nothing is logged.
 */
async function defaultFingerprintFetch(
  workspace: PlaywrightWorkspace,
): Promise<unknown> {
  const page = await workspace.newPage();
  await page.goto(PEET_FINGERPRINT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  const text = await page.evaluate<string>(
    "document.body && document.body.innerText",
  );
  return JSON.parse(text);
}

function assertAmcUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.origin !== AMC_ORIGIN && url.origin !== AMC_GRAPH_ORIGIN) {
    throw new Error("AMC listing URL is outside the allowed AMC origin");
  }
  return url.toString();
}
