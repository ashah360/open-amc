import { describe, expect, it, vi } from "vitest";
import { PlaywrightBrowserRuntime } from "../src/capabilities/browser/playwright/runtime";
import {
  PlaywrightAmcBrowserRefresher,
  tryClickCloudflareTurnstileCheckbox,
} from "../src/capabilities/browser/playwright/browser-refresh";
import { BrowserRefreshUnavailableError } from "../src/client/browser-refresh";
import { FakeCookie, FakePlaywrightContext } from "./helpers/fake-playwright";
import type { PlaywrightPage } from "../src/capabilities/browser/playwright/runtime";

const NOT_ADMITTED = {
  allowedOrigin: true,
  movieSections: 0,
  formatGroups: 0,
  showtimeLinks: 0,
};
const ADMITTED = {
  allowedOrigin: true,
  movieSections: 18,
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
const TRUST_OK = {
  status: 200,
  hasData: true,
  hasErrors: false,
  challenge: false,
};

// ---------------------------------------------------------------------------
// Unit level: the real frame-allowlist clicker against structural fakes.
// ---------------------------------------------------------------------------

class FakeLocator {
  clicks = 0;
  constructor(
    private readonly options: {
      count?: number;
      visible?: boolean;
      enabled?: boolean;
      clickError?: Error;
    } = {},
  ) {}
  first(): FakeLocator {
    return this;
  }
  async count(): Promise<number> {
    return this.options.count ?? 1;
  }
  async isVisible(): Promise<boolean> {
    return this.options.visible ?? true;
  }
  async isEnabled(): Promise<boolean> {
    return this.options.enabled ?? true;
  }
  async click(): Promise<void> {
    if (this.options.clickError) throw this.options.clickError;
    this.clicks += 1;
  }
}

class FakeFrame {
  readonly roleCalls: Array<{ role: string; name?: RegExp }> = [];
  readonly selectorCalls: string[] = [];
  constructor(
    private readonly frameUrl: string,
    private readonly roleLocator?: FakeLocator,
    private readonly selectorLocator?: FakeLocator,
  ) {}
  url(): string {
    return this.frameUrl;
  }
  getByRole(role: string, options?: { name?: RegExp }): FakeLocator {
    this.roleCalls.push({
      role,
      ...(options?.name ? { name: options.name } : {}),
    });
    return this.roleLocator ?? new FakeLocator({ count: 0 });
  }
  locator(selector: string): FakeLocator {
    this.selectorCalls.push(selector);
    return this.selectorLocator ?? new FakeLocator({ count: 0 });
  }
}

function pageWithFrames(frames: FakeFrame[]): PlaywrightPage {
  return {
    frames: () => frames,
    goto: async () => null,
    evaluate: async () => null,
    addScriptTag: async () => null,
    url: () => "https://www.amctheatres.com/",
    waitForTimeout: async () => undefined,
    close: async () => undefined,
  } as unknown as PlaywrightPage;
}

describe("tryClickCloudflareTurnstileCheckbox", () => {
  it("clicks a visible enabled role=checkbox inside the challenges.cloudflare.com frame exactly once", async () => {
    const checkbox = new FakeLocator();
    const frame = new FakeFrame(
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x",
      checkbox,
    );
    const outcome = await tryClickCloudflareTurnstileCheckbox(
      pageWithFrames([frame]),
    );
    expect(outcome).toBe("clicked");
    expect(checkbox.clicks).toBe(1);
    // The role query is a strict checkbox-with-human-verification-name match.
    expect(frame.roleCalls[0]!.role).toBe("checkbox");
    expect("Verify you are human").toMatch(frame.roleCalls[0]!.name!);
    expect("I'm not a robot").toMatch(frame.roleCalls[0]!.name!);
  });

  it("clicks the strict Turnstile selector in an amctheatres.com challenge-platform frame", async () => {
    const checkbox = new FakeLocator();
    const frame = new FakeFrame(
      "https://www.amctheatres.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page",
      undefined,
      checkbox,
    );
    const outcome = await tryClickCloudflareTurnstileCheckbox(
      pageWithFrames([frame]),
    );
    expect(outcome).toBe("clicked");
    expect(checkbox.clicks).toBe(1);
    expect(frame.selectorCalls[0]).toMatch(/cb-lb|ctp-checkbox/);
  });

  it("never clicks a checkbox on an ordinary AMC page frame", async () => {
    const checkbox = new FakeLocator();
    const frame = new FakeFrame(
      "https://www.amctheatres.com/movie-theatres/x/amc-y/showtimes",
      checkbox,
      checkbox,
    );
    const outcome = await tryClickCloudflareTurnstileCheckbox(
      pageWithFrames([frame]),
    );
    expect(outcome).toBe("not-found");
    expect(checkbox.clicks).toBe(0);
  });

  it("never clicks inside a non-allowlisted frame host", async () => {
    const checkbox = new FakeLocator();
    const frames = [
      new FakeFrame(
        "https://challenges.cloudflare.com.evil.example/turnstile",
        checkbox,
        checkbox,
      ),
      new FakeFrame(
        "https://evil.example/cdn-cgi/challenge-platform/x",
        checkbox,
        checkbox,
      ),
    ];
    const outcome = await tryClickCloudflareTurnstileCheckbox(
      pageWithFrames(frames),
    );
    expect(outcome).toBe("not-found");
    expect(checkbox.clicks).toBe(0);
  });

  it("skips a hidden or disabled challenge checkbox", async () => {
    const hidden = new FakeLocator({ visible: false });
    const disabled = new FakeLocator({ enabled: false });
    const outcome = await tryClickCloudflareTurnstileCheckbox(
      pageWithFrames([
        new FakeFrame("https://challenges.cloudflare.com/a", hidden, disabled),
      ]),
    );
    expect(outcome).toBe("not-found");
    expect(hidden.clicks).toBe(0);
    expect(disabled.clicks).toBe(0);
  });

  it("returns not-found for a page without frame access (fakes, exotic runtimes)", async () => {
    const page = {
      goto: async () => null,
      evaluate: async () => null,
      addScriptTag: async () => null,
      url: () => "https://www.amctheatres.com/",
      waitForTimeout: async () => undefined,
      close: async () => undefined,
    } as unknown as PlaywrightPage;
    expect(await tryClickCloudflareTurnstileCheckbox(page)).toBe("not-found");
  });

  it("propagates a click failure so the caller can spend the single attempt", async () => {
    const failing = new FakeLocator({ clickError: new Error("detached") });
    await expect(
      tryClickCloudflareTurnstileCheckbox(
        pageWithFrames([
          new FakeFrame("https://challenges.cloudflare.com/a", failing),
        ]),
      ),
    ).rejects.toThrow(/detached/);
  });
});

// ---------------------------------------------------------------------------
// Refresher level: at-most-one click per repair, never success proof.
// ---------------------------------------------------------------------------

function refresherWith(
  context: FakePlaywrightContext,
  clicker: (page: PlaywrightPage) => Promise<"clicked" | "not-found">,
  admissionAttempts = 3,
) {
  return new PlaywrightAmcBrowserRefresher({
    runtime: new PlaywrightBrowserRuntime({ kind: "context", context }),
    listingUrl:
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    admissionAttempts,
    admissionIntervalMs: 0,
    timeoutMs: 5_000,
    captureFingerprint: false,
    browserTrustFetcher: async () => TRUST_OK,
    checkboxClicker: clicker,
  });
}

describe("bounded Turnstile checkbox handling during explicit repair", () => {
  it("clicks exactly once, keeps settling, and exports only after admission + AccessCheck", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: {
        evaluateResults: [NOT_ADMITTED, NOT_ADMITTED, ADMITTED],
      },
    });
    const clicker = vi.fn(async () => "clicked" as const);
    const session = await refresherWith(context, clicker).refresh();
    expect(session.cookies.map((c) => c.name)).toContain("session");
    // One click on the first unadmitted poll; never again once attempted.
    expect(clicker).toHaveBeenCalledTimes(1);
  });

  it("clicks exactly once even when the challenge never settles, then fails bounded", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResult: NOT_ADMITTED },
    });
    const clicker = vi.fn(async () => "clicked" as const);
    await expect(
      refresherWith(context, clicker, 4).refresh(),
    ).rejects.toBeInstanceOf(BrowserRefreshUnavailableError);
    expect(clicker).toHaveBeenCalledTimes(1);
  });

  it("keeps inspecting (never clicking) while no checkbox is exposed, and auto-settle still succeeds", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: { evaluateResults: [NOT_ADMITTED, ADMITTED] },
    });
    const clicker = vi.fn(async () => "not-found" as const);
    const session = await refresherWith(context, clicker).refresh();
    expect(session.cookies.length).toBeGreaterThan(0);
    // Inspection may repeat; an actual click never happened.
    expect(clicker).toHaveBeenCalled();
  });

  it("treats a click failure as the single spent attempt and stays bounded and safe", async () => {
    const context = new FakePlaywrightContext({
      cookies: [AMC_COOKIE],
      pageOptions: {
        evaluateResults: [NOT_ADMITTED, NOT_ADMITTED, ADMITTED],
      },
    });
    const clicker = vi.fn(async () => {
      throw new Error("frame detached mid-click");
    });
    const session = await refresherWith(context, clicker).refresh();
    expect(session.cookies.length).toBeGreaterThan(0);
    expect(clicker).toHaveBeenCalledTimes(1);
  });
});
