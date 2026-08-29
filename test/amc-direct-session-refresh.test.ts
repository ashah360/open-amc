import { describe, expect, it } from "vitest";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import {
  DirectAdmissionError,
  DirectAdmissionRequiresBrowserError,
  DirectFirstAmcSessionRefresher,
  DirectQueueItSessionRefresher,
} from "../src/client/direct-session-refresh";
import { AmcSession } from "../src/client/session";

class QueueTransport implements Transport {
  readonly name = "queue";
  readonly sent: RequestInput[] = [];
  constructor(private readonly responses: ResponseOutput[]) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }
}

class FakeBrowserRefresher {
  calls = 0;
  constructor(private readonly result: AmcSession) {}
  async refresh(): Promise<AmcSession> {
    this.calls += 1;
    return this.result;
  }
}

// One labeled example theater; any official AMC theater URL works and the
// refresher now REQUIRES an explicit one (no built-in venue default).
const LISTING = {
  listingUrl:
    "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
};

describe("AMC direct Queue-it admission", () => {
  it("requires an explicit official listing URL (no built-in venue default)", () => {
    const transport = new QueueTransport([]);
    expect(
      () =>
        new DirectQueueItSessionRefresher(
          transport,
          {} as unknown as { listingUrl: string },
        ),
    ).toThrow(/explicit official AMC listing URL/i);
    expect(
      () =>
        new DirectQueueItSessionRefresher(transport, {
          listingUrl: "https://www.amctheatres.com.evil.example/x",
        }),
    ).toThrow(/www\.amctheatres\.com/);
  });

  it("exchanges the Queue-it redirect for an accepted AMC cookie without a browser", async () => {
    const transport = new QueueTransport([
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb&enqueuetoken=opaque&t=https%3A%2F%2Fwww.amctheatres.com%2Fmovie-theatres%2Fsan-francisco%2Famc-metreon-16%2Fshowtimes",
        [
          "__cf_bm=rotated; Domain=.amctheatres.com; Path=/; Secure; HttpOnly; SameSite=None",
        ],
      ),
      redirect(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?queueittoken=opaque-return",
        [
          "Queue-it-visitorsession=queue-only; Path=/; Secure; HttpOnly; SameSite=Strict",
        ],
      ),
      redirect(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
        [
          "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
        ],
      ),
    ]);
    const refreshed = await new DirectQueueItSessionRefresher(
      transport,
      LISTING,
    ).refresh(session("stale"));

    expect(
      transport.sent.map((request) => new URL(request.url).hostname),
    ).toEqual([
      "www.amctheatres.com",
      "queue.amctheatres.com",
      "www.amctheatres.com",
    ]);
    expect(transport.sent[0]?.followRedirect).toBe(false);
    expect(transport.sent[1]?.headers.cookie ?? "").not.toContain("root=stale");
    expect(transport.sent[2]?.headers.cookie).toContain("__cf_bm=rotated");
    expect(
      refreshed.cookies.find((cookie) => cookie.name === "__cf_bm")?.value,
    ).toBe("rotated");
    expect(
      refreshed.cookies.find((cookie) =>
        cookie.name.startsWith("QueueITAccepted-"),
      )?.value,
    ).toContain("EventId%3Dglobalsafetynetweb");
    expect(
      refreshed.cookies.some(
        (cookie) => cookie.name === "Queue-it-visitorsession",
      ),
    ).toBe(false);
  });

  it("falls back to the browser only when Queue-it returns an actual waiting room", async () => {
    const transport = new QueueTransport([
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      html(
        "<title>AMC Waiting Room</title><div>users in line ahead of you</div>",
      ),
    ]);
    const browser = new FakeBrowserRefresher(session("browser"));
    const direct = new DirectQueueItSessionRefresher(transport, LISTING);
    await expect(direct.refresh(session("stale"))).rejects.toBeInstanceOf(
      DirectAdmissionRequiresBrowserError,
    );

    const secondTransport = new QueueTransport([
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      html(
        "<title>AMC Waiting Room</title><div>users in line ahead of you</div>",
      ),
    ]);
    const result = await new DirectFirstAmcSessionRefresher(
      new DirectQueueItSessionRefresher(secondTransport, LISTING),
      browser,
    ).refresh(session("stale"));

    expect(result.cookies.find((cookie) => cookie.name === "root")?.value).toBe(
      "browser",
    );
    expect(browser.calls).toBe(1);
  });
});

describe("explicit direct-first fallback covers deterministic admission failures", () => {
  it("falls back to the browser exactly once when the direct target shape fails (target)", async () => {
    // The initial target response is an ordinary 200 HTML page — not the
    // Queue-it 302 and not a challenge — which classifies as
    // DirectAdmissionError("target").
    const transport = new QueueTransport([html("<html>listing page</html>")]);
    const direct = new DirectQueueItSessionRefresher(transport, LISTING);
    const targetError = await direct
      .refresh(session("stale"))
      .catch((error: unknown) => error);
    expect(targetError).toBeInstanceOf(DirectAdmissionError);
    expect((targetError as DirectAdmissionError).stage).toBe("target");

    const browser = new FakeBrowserRefresher(session("browser"));
    const result = await new DirectFirstAmcSessionRefresher(
      new DirectQueueItSessionRefresher(
        new QueueTransport([html("<html>listing page</html>")]),
        LISTING,
      ),
      browser,
    ).refresh(session("stale"));

    expect(browser.calls).toBe(1);
    expect(result.cookies.find((cookie) => cookie.name === "root")?.value).toBe(
      "browser",
    );
  });

  it("falls back to the browser exactly once when admission completes without the accepted cookie", async () => {
    const acceptedCookieFailure = () =>
      new QueueTransport([
        redirect(
          "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
        ),
        redirect(
          "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?queueittoken=opaque-return",
        ),
        // Return leg succeeds but never sets a QueueITAccepted-* cookie.
        redirect(
          "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
        ),
      ]);
    const cookieError = await new DirectQueueItSessionRefresher(
      acceptedCookieFailure(),
      LISTING,
    )
      .refresh(session("stale"))
      .catch((error: unknown) => error);
    expect(cookieError).toBeInstanceOf(DirectAdmissionError);
    expect((cookieError as DirectAdmissionError).stage).toBe("accepted-cookie");

    const browser = new FakeBrowserRefresher(session("browser"));
    const result = await new DirectFirstAmcSessionRefresher(
      new DirectQueueItSessionRefresher(acceptedCookieFailure(), LISTING),
      browser,
    ).refresh(session("stale"));

    expect(browser.calls).toBe(1);
    expect(result.cookies.find((cookie) => cookie.name === "root")?.value).toBe(
      "browser",
    );
  });

  it("preserves unrelated errors without touching the browser", async () => {
    const plain = new Error("boom");
    const programmer = Object.assign(
      new TypeError('The "url" argument must be of type string'),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
    for (const raw of [plain, programmer]) {
      const browser = new FakeBrowserRefresher(session("browser"));
      const refresher = new DirectFirstAmcSessionRefresher(
        {
          refresh: async () => {
            throw raw;
          },
        },
        browser,
      );
      await expect(refresher.refresh(session("stale"))).rejects.toBe(raw);
      expect(browser.calls).toBe(0);
    }
  });

  it("never calls the browser when direct admission succeeds", async () => {
    const transport = new QueueTransport([
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb&enqueuetoken=opaque&t=https%3A%2F%2Fwww.amctheatres.com%2Fmovie-theatres%2Fsan-francisco%2Famc-metreon-16%2Fshowtimes",
      ),
      redirect(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?queueittoken=opaque-return",
      ),
      redirect(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
        [
          "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
        ],
      ),
    ]);
    const browser = new FakeBrowserRefresher(session("browser"));
    const result = await new DirectFirstAmcSessionRefresher(
      new DirectQueueItSessionRefresher(transport, LISTING),
      browser,
    ).refresh(session("stale"));

    expect(browser.calls).toBe(0);
    expect(
      result.cookies.some((cookie) =>
        cookie.name.startsWith("QueueITAccepted-"),
      ),
    ).toBe(true);
  });
});

function session(rootValue: string): AmcSession {
  return {
    version: 1,
    origin: "https://www.amctheatres.com",
    profile: "chrome147-mac",
    exportedAt: "2030-01-15T17:00:00.000Z",
    cookies: [
      {
        name: "root",
        value: rootValue,
        domain: ".amctheatres.com",
        path: "/",
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ],
  };
}

function redirect(location: string, setCookies: string[] = []): ResponseOutput {
  return {
    status: 302,
    headers: { location },
    bodyText: "",
    timingMs: 1,
    transport: "queue",
    setCookieNames: setCookies.map((line) => line.slice(0, line.indexOf("="))),
    setCookies,
  };
}

function html(bodyText: string): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText,
    timingMs: 1,
    transport: "queue",
    setCookieNames: [],
    setCookies: [],
  };
}
