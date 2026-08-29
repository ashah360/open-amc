import { describe, expect, it, vi } from "vitest";
import {
  AsideBrowserRefresher,
  AsideExecutionAdapter,
  AsideExecutionRequest,
  BrowserRefreshUnavailableError,
} from "../src/client/browser-refresh";

// One labeled example theater; any official AMC theater URL works and the
// refresher now REQUIRES an explicit one (no built-in venue default).
const LISTING_URL =
  "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes";

class FakeAsideExecution implements AsideExecutionAdapter {
  readonly requests: AsideExecutionRequest[] = [];

  constructor(private readonly outcome: string | Error) {}

  async execute(request: AsideExecutionRequest): Promise<string> {
    this.requests.push(request);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

describe("AsideBrowserRefresher", () => {
  it("runs one bounded semantic listing transaction and normalizes scoped CDP cookies privately", async () => {
    const execution = new FakeAsideExecution(
      JSON.stringify({
        ok: true,
        stage: "complete",
        semantic: { movieSections: 18, formatGroups: 24, showtimeLinks: 69 },
        cookies: [
          {
            name: "session",
            value: "secret-cookie-value",
            domain: ".amctheatres.com",
            path: "/",
            expires: 1_797_123_456.75,
            secure: true,
            httpOnly: true,
            session: false,
          },
        ],
      }),
    );
    const consoleSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    try {
      const session = await new AsideBrowserRefresher({
        execution,
        listingUrl: LISTING_URL,
      }).refresh();

      expect(session).toMatchObject({
        version: 1,
        origin: "https://www.amctheatres.com",
        profile: "chrome147-mac",
        cookies: [
          {
            name: "session",
            value: "secret-cookie-value",
            expires: 1_797_123_456,
            sameSite: "Lax",
          },
        ],
      });
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }

    expect(execution.requests).toHaveLength(1);
    expect(execution.requests[0]?.title).toBe("Refresh AMC read session");
    expect(execution.requests[0]?.code).toContain(
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    );
    expect(execution.requests[0]?.code).toContain(
      'section[aria-label^="Showtimes for "]',
    );
    expect(execution.requests[0]?.code).toContain("Network.getAllCookies");
    expect(execution.requests[0]?.code).toContain("finally");
    expect(execution.requests[0]?.code).not.toMatch(/\/seats|\.click\(/);
  });

  it("accepts an admitted empty-day listing result (sections rendered, zero remaining showtimes)", async () => {
    const execution = new FakeAsideExecution(
      JSON.stringify({
        ok: true,
        stage: "complete",
        semantic: { movieSections: 21, formatGroups: 0, showtimeLinks: 0 },
        cookies: [
          {
            name: "session",
            value: "secret-cookie-value",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
            session: true,
          },
        ],
      }),
    );

    const session = await new AsideBrowserRefresher({
      execution,
      listingUrl: LISTING_URL,
    }).refresh();

    expect(session.cookies.map((cookie) => cookie.name)).toEqual(["session"]);
  });

  it("rejects a listing result with zero movie sections (challenge/empty page)", async () => {
    const execution = new FakeAsideExecution(
      JSON.stringify({
        ok: true,
        stage: "complete",
        semantic: { movieSections: 0, formatGroups: 0, showtimeLinks: 0 },
        cookies: [
          {
            name: "session",
            value: "secret-cookie-value",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
            session: true,
          },
        ],
      }),
    );

    await expect(
      new AsideBrowserRefresher({
        execution,
        listingUrl: LISTING_URL,
      }).refresh(),
    ).rejects.toMatchObject({
      code: "AMC_BROWSER_REFRESH_UNAVAILABLE",
      stage: "semantic",
    });
  });

  it("in-browser transaction admits on origin + movie sections, not showtime availability", async () => {
    const execution = new FakeAsideExecution(
      JSON.stringify({
        ok: true,
        stage: "complete",
        semantic: { movieSections: 21, formatGroups: 0, showtimeLinks: 0 },
        cookies: [
          {
            name: "session",
            value: "v",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
            session: true,
          },
        ],
      }),
    );
    await new AsideBrowserRefresher({
      execution,
      listingUrl: LISTING_URL,
    }).refresh();

    const code = execution.requests[0]!.code;
    expect(code).toContain("movieSections > 0");
    // formatGroups/showtimeLinks are availability counters, never admission
    // requirements: an admitted listing may have zero remaining showtimes.
    expect(code).not.toContain("formatGroups > 0");
    expect(code).not.toContain("showtimeLinks > 0");
  });

  it("classifies a semantic listing failure without surfacing browser output", async () => {
    const execution = new FakeAsideExecution(
      JSON.stringify({
        ok: false,
        stage: "semantic",
        detail: "secret-cookie-value and raw page text",
      }),
    );

    const failure = await new AsideBrowserRefresher({
      execution,
      listingUrl: LISTING_URL,
    })
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserRefreshUnavailableError);
    expect(failure).toMatchObject({
      code: "AMC_BROWSER_REFRESH_UNAVAILABLE",
      stage: "semantic",
      message: "AMC browser refresh unavailable (semantic)",
    });
    expect(String(failure)).not.toContain("secret-cookie-value");
  });

  it("keeps navigation failure distinct from semantic failure", async () => {
    const execution = new FakeAsideExecution(
      JSON.stringify({
        ok: false,
        stage: "navigation",
        detail: "private browser detail",
      }),
    );

    await expect(
      new AsideBrowserRefresher({
        execution,
        listingUrl: LISTING_URL,
      }).refresh(),
    ).rejects.toMatchObject({
      code: "AMC_BROWSER_REFRESH_UNAVAILABLE",
      stage: "navigation",
      message: "AMC browser refresh unavailable (navigation)",
    });
  });

  it("classifies Aside tool failures without surfacing secret-bearing errors", async () => {
    const execution = new FakeAsideExecution(
      new Error("tool failed while carrying secret-cookie-value"),
    );

    const failure = await new AsideBrowserRefresher({
      execution,
      listingUrl: LISTING_URL,
    })
      .refresh()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BrowserRefreshUnavailableError);
    expect(failure).toMatchObject({
      code: "AMC_BROWSER_REFRESH_UNAVAILABLE",
      stage: "transport",
      message: "AMC browser refresh unavailable (transport)",
    });
    expect(String(failure)).not.toContain("secret-cookie-value");
  });
});
