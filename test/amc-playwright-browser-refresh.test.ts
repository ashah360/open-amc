import { describe, expect, it, vi } from "vitest";
import {
  BrowserOperationTimeoutError,
  PlaywrightBrowserRuntime,
} from "../src/capabilities/browser/playwright/runtime";
import { PlaywrightAmcBrowserRefresher } from "../src/capabilities/browser/playwright/browser-refresh";
import { BrowserRefreshUnavailableError } from "../src/client/browser-refresh";
import {
  FakeCookie,
  FakePlaywrightBrowser,
  FakePlaywrightContext,
  FakePlaywrightPage,
} from "./helpers/fake-playwright";

const ADMITTED = {
  allowedOrigin: true,
  movieSections: 18,
  formatGroups: 24,
  showtimeLinks: 69,
};
const NOT_ADMITTED = {
  allowedOrigin: true,
  movieSections: 0,
  formatGroups: 0,
  showtimeLinks: 0,
};
// A real admitted listing on a day with no remaining performances: movie
// sections render, but zero format groups and zero /showtimes/<id> links.
const ADMITTED_EMPTY_DAY = {
  allowedOrigin: true,
  movieSections: 21,
  formatGroups: 0,
  showtimeLinks: 0,
};
const WRONG_ORIGIN_WITH_SECTIONS = {
  allowedOrigin: false,
  movieSections: 21,
  formatGroups: 24,
  showtimeLinks: 69,
};

const AMC_COOKIE: FakeCookie = {
  name: "session",
  value: "amc-session-value",
  domain: ".amctheatres.com",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
};
const GRAPH_COOKIE: FakeCookie = {
  name: "graph",
  value: "amc-graph-value",
  domain: "graph.amctheatres.com",
  path: "/",
  expires: 1_897_123_456,
  httpOnly: false,
  secure: true,
  sameSite: "None",
};
const FOREIGN_COOKIE: FakeCookie = {
  name: "tracker",
  value: "third-party-tracking-value",
  domain: ".google.com",
  path: "/",
  expires: -1,
  httpOnly: false,
  secure: true,
  sameSite: "None",
};

function refresherFor(
  context: FakePlaywrightContext,
  connectionBrowser?: FakePlaywrightBrowser,
  overrides: {
    timeoutMs?: number;
    admissionAttempts?: number;
    captureFingerprint?: boolean;
    fingerprintFetcher?: () => Promise<unknown>;
  } = {},
) {
  const runtime = connectionBrowser
    ? new PlaywrightBrowserRuntime({
        kind: "browser",
        browser: connectionBrowser,
      })
    : new PlaywrightBrowserRuntime({ kind: "context", context });
  return new PlaywrightAmcBrowserRefresher({
    runtime,
    listingUrl:
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    admissionAttempts: overrides.admissionAttempts ?? 2,
    admissionIntervalMs: 0,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    // Default off for the existing behavioral tests; the fingerprint tests
    // below opt in with an injected fetcher.
    captureFingerprint: overrides.captureFingerprint ?? false,
    ...(overrides.fingerprintFetcher
      ? { fingerprintFetcher: overrides.fingerprintFetcher }
      : {}),
  });
}

function syntheticPeetCapture(): Record<string, unknown> {
  return {
    ip: "203.0.113.9:44000",
    donate: "coffee",
    tcpip: { ip: { ttl: 64 }, tcp: { window: 65535 } },
    http_version: "h2",
    tls: {
      ciphers: ["TLS_AES_128_GCM_SHA256"],
      extensions: [
        { name: "supported_groups (10)", supported_groups: ["X25519 (29)"] },
      ],
      ja3: "771,4865,10,29,0",
      ja3_hash: "h3",
      ja4: "t13d_x_y",
      peetprint: "pp",
      peetprint_hash: "pph",
      client_random: "deadbeefdeadbeefdeadbeefdeadbeef",
      session_id: "cafebabecafebabecafebabecafebabe",
    },
    http2: { akamai_fingerprint: "1:65536", akamai_fingerprint_hash: "ah" },
    user_agent: "Mozilla/5.0 Chrome/147",
  };
}

describe("PlaywrightAmcBrowserRefresher", () => {
  it("proves semantic admission and exports only AMC-scoped cookies", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE, GRAPH_COOKIE, FOREIGN_COOKIE],
      pageOptions: { evaluateResult: ADMITTED },
    });
    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    let session;
    try {
      session = await refresherFor(context).refresh();
    } finally {
      consoleSpy.mockRestore();
    }

    expect(session.origin).toBe("https://www.amctheatres.com");
    const names = session.cookies.map((cookie) => cookie.name).sort();
    expect(names).toEqual(["graph", "session"]);
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("third-party-tracking-value");
    expect(serialized).not.toContain("google.com");
    expect(consoleSpy).not.toHaveBeenCalled();

    const page = context.createdPages[0]!;
    expect(page.gotos[0]?.url).toContain("amctheatres.com");
  });

  it("captures and attaches a sanitized fingerprint after admission", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: ADMITTED },
    });
    const session = await refresherFor(context, undefined, {
      captureFingerprint: true,
      fingerprintFetcher: async () => syntheticPeetCapture(),
    }).refresh();

    expect(session.fingerprint?.name).toMatch(/^amc-fp-[0-9a-f]{16}$/);
    const serialized = JSON.stringify(session.fingerprint);
    // Identifying/ephemeral fields never reach the persisted session.
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain("deadbeef");
    expect(serialized).not.toContain("cafebabe");
    expect(serialized).not.toContain("tcpip");
    // The stable signature is retained.
    expect(session.fingerprint?.peet.user_agent).toContain("Chrome/147");
  });

  it("captures via the default fetch path and disposes the capture page", async () => {
    // One shared page serves admission (first evaluate) then the peet JSON
    // (second evaluate, read as innerText by the default fetcher).
    const page = new FakePlaywrightPage({
      evaluateResults: [ADMITTED, JSON.stringify(syntheticPeetCapture())],
    });
    const context = new FakePlaywrightContext({ cookies: [AMC_COOKIE], page });

    const session = await refresherFor(context, undefined, {
      captureFingerprint: true, // no injected fetcher -> real default path
    }).refresh();

    expect(session.fingerprint?.name).toMatch(/^amc-fp-[0-9a-f]{16}$/);
    // The default fetcher navigated the fixed peet endpoint...
    expect(page.gotos.some((g) => g.url.includes("tls.peet.ws"))).toBe(true);
    // ...and every page the workspace created (admission + capture) is closed.
    expect(context.createdPages.every((p) => p.closed)).toBe(true);
  });

  it("returns a working session without a fingerprint when capture fails (non-fatal)", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: ADMITTED },
    });
    const session = await refresherFor(context, undefined, {
      captureFingerprint: true,
      fingerprintFetcher: async () => {
        throw new Error("peet unreachable");
      },
    }).refresh();

    expect(session.fingerprint).toBeUndefined();
    expect(session.cookies.length).toBeGreaterThan(0);
  });

  it("does not close a caller-owned context but closes the page it created", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: ADMITTED },
    });

    await refresherFor(context).refresh();

    expect(context.closed).toBe(false);
    expect(context.createdPages[0]?.closed).toBe(true);
  });

  it("closes the context and browser it created for a caller-supplied browser", async () => {
    const browser = new FakePlaywrightBrowser({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: ADMITTED },
    });

    await refresherFor(browser.context, browser).refresh();

    expect(browser.context.closed).toBe(true);
    // The caller supplied the browser, so the refresher must not close it.
    expect(browser.closed).toBe(false);
  });

  it("accepts an admitted empty-day listing (sections rendered, zero remaining showtimes)", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE, GRAPH_COOKIE, FOREIGN_COOKIE],
      pageOptions: { evaluateResult: ADMITTED_EMPTY_DAY },
    });

    const session = await refresherFor(context).refresh();

    // Listing semantics prove admission; showtime availability is not
    // required. Export stays AMC-scoped; the caller's direct canary still
    // gates persistence.
    const names = session.cookies.map((cookie) => cookie.name).sort();
    expect(names).toEqual(["graph", "session"]);
    expect(JSON.stringify(session)).not.toContain("google.com");
  });

  it("rejects a sections-bearing page on a disallowed origin", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: WRONG_ORIGIN_WITH_SECTIONS },
    });

    const failure = await refresherFor(context)
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserRefreshUnavailableError);
    expect(failure).toMatchObject({ stage: "semantic" });
  });

  it("fails closed with a semantic error when admission is never proven", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: NOT_ADMITTED },
    });

    const failure = await refresherFor(context)
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserRefreshUnavailableError);
    expect(failure).toMatchObject({
      code: "AMC_BROWSER_REFRESH_UNAVAILABLE",
      stage: "semantic",
    });
    expect(context.createdPages[0]?.closed).toBe(true);
  });

  it("classifies a navigation failure without leaking raw browser output", async () => {
    const page = new FakePlaywrightPage({
      gotoImpl: async () => {
        throw new Error("net::ERR carrying amc-session-value in the message");
      },
    });
    const context = new FakePlaywrightContext({ page });

    const failure = await refresherFor(context)
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserRefreshUnavailableError);
    expect(failure).toMatchObject({ stage: "navigation" });
    expect(String(failure)).not.toContain("amc-session-value");
    expect(page.closed).toBe(true);
  });

  it("times out cleanly and still disposes owned resources", async () => {
    const page = new FakePlaywrightPage({
      gotoImpl: () => new Promise<void>(() => undefined),
    });
    const context = new FakePlaywrightContext({ page });

    const failure = await refresherFor(context, undefined, { timeoutMs: 25 })
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserOperationTimeoutError);
    expect(failure).toMatchObject({
      code: "AMC_BROWSER_OPERATION_TIMEOUT",
      reason: "timeout",
    });
    expect(page.closed).toBe(true);
    expect(context.closed).toBe(false);
  });

  it("applies the timeout budget to acquisition, not just navigation", async () => {
    // newContext hangs forever: if acquisition ran outside the budget the
    // whole refresh would hang. It must instead time out cleanly.
    const browser = new FakePlaywrightBrowser(
      { cookies: [AMC_COOKIE], pageOptions: { evaluateResult: ADMITTED } },
      { newContextHang: true },
    );

    const failure = await refresherFor(browser.context, browser, {
      timeoutMs: 25,
    })
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserOperationTimeoutError);
    expect(failure).toMatchObject({ reason: "timeout" });
  }, 2000);

  it("disposes a late-resolving acquisition after timeout and never navigates", async () => {
    // Acquisition (newContext) resolves only after the budget has already
    // rejected. The late workspace must be disposed and must not proceed.
    const browser = new FakePlaywrightBrowser(
      { cookies: [AMC_COOKIE], pageOptions: { evaluateResult: ADMITTED } },
      { newContextDelayMs: 60 },
    );

    const failure = await refresherFor(browser.context, browser, {
      timeoutMs: 20,
    })
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserOperationTimeoutError);
    // Wait past the delayed acquisition so its late resolution runs.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(browser.context.closed).toBe(true);
    expect(browser.context.newPageCalls).toBe(0);
    // The caller-owned browser is never closed.
    expect(browser.closed).toBe(false);
  }, 2000);

  it("aborts immediately when the provided signal is already aborted", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: ADMITTED },
    });

    const failure = await refresherFor(context)
      .refresh(null, { signal: AbortSignal.abort() })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserOperationTimeoutError);
    expect(failure).toMatchObject({ reason: "aborted" });
    expect(context.newPageCalls).toBe(0);
  });
});
