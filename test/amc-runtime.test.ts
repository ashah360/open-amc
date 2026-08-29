import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { BrowserRefreshUnavailableError } from "../src/client/browser-refresh";
import { syntheticListingHtml, syntheticSeatHtml } from "./fixtures";
import {
  AMC_SESSION_KEY,
  AmcRuntime,
  bootstrapAmcSession,
  clearAmcSession,
  getAmcAuthStatus,
} from "../src/client/runtime";
import {
  AmcSession,
  decodeAmcSession,
  encodeAmcSession,
} from "../src/client/session";

class QueueTransport implements Transport {
  readonly name = "recording";
  readonly sent: RequestInput[] = [];

  constructor(
    private readonly responses: ResponseOutput[],
    private readonly beforeRespond?: (
      call: number,
      input: RequestInput,
    ) => Promise<void>,
  ) {}

  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    await this.beforeRespond?.(this.sent.length, input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected AMC request");
    return response;
  }
}

class FakeBrowserRefresher {
  calls = 0;

  constructor(
    private readonly outcome: AmcSession | Error,
    private readonly delayMs = 0,
  ) {}

  async refresh(): Promise<AmcSession> {
    this.calls += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// One labeled example theater; any official AMC theater URL works. The
// runtime no longer carries a built-in venue, so tests supply it explicitly.
const LISTING_URL =
  "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes";
const LISTING_PATH = "/movie-theatres/san-francisco/amc-metreon-16/showtimes";

describe("AMC auth lifecycle", () => {
  it("imports, validates, reports, and clears only the AMC personal session", async () => {
    const store = await newStore();
    const listing = syntheticListingHtml();
    const transport = new QueueTransport([
      htmlResponse(listing),
      htmlResponse(listing),
    ]);

    await bootstrapAmcSession(
      encodeAmcSession(session()),
      transport,
      store,
      "ssr",
      LISTING_PATH,
    );
    expect(
      await getAmcAuthStatus(transport, store, "ssr", LISTING_PATH),
    ).toMatchObject({
      status: "valid",
    });
    expect(
      transport.sent.every(
        (request) => request.headers.cookie === "root=secret",
      ),
    ).toBe(true);

    await clearAmcSession(store);
    expect(await store.load(AMC_SESSION_KEY)).toBeNull();
    expect(
      await getAmcAuthStatus(transport, store, "ssr", LISTING_PATH),
    ).toEqual({
      provider: "amc",
      account: "personal",
      status: "missing",
    });
  });

  it("reports a challenge honestly without mutating the stored session", async () => {
    const store = await newStore();
    const original = encodeAmcSession(session());
    await store.save(AMC_SESSION_KEY, original);
    const transport = new QueueTransport([
      {
        ...htmlResponse("<title>Just a moment... Cloudflare</title>"),
        status: 429,
      },
    ]);

    expect(
      await getAmcAuthStatus(transport, store, "ssr", LISTING_PATH),
    ).toMatchObject({
      status: "challenged",
      instruction: expect.stringContaining("auth bootstrap"),
    });
    expect(await store.load(AMC_SESSION_KEY)).toEqual(original);
  });

  it("reports an undecodable saved bundle as stale without an implicit bootstrap read", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, Buffer.from('{"version":2}'));
    const transport = new QueueTransport([]);

    expect(
      await getAmcAuthStatus(transport, store, "ssr", LISTING_PATH),
    ).toEqual({
      provider: "amc",
      account: "personal",
      status: "stale",
    });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("AMC managed reads", () => {
  it("repairs a Queue-it 302 directly before falling back to the browser", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session("stale")));
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const browserRefresher = new FakeBrowserRefresher(
      session("must-not-be-used"),
    );
    const transport = new QueueTransport([
      redirectResponse(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      redirectResponse(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      redirectResponse(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      redirectResponse(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?queueittoken=opaque-return",
      ),
      redirectResponse(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
        [
          "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
        ],
      ),
      htmlResponse(listing),
      htmlResponse(seats),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher,
      listingUrl: LISTING_URL,
    });

    const layout = await runtime.getSeatLayout("900000004");

    expect(layout).toMatchObject({ columns: 7, rows: 4 });
    expect(browserRefresher.calls).toBe(0);
    expect(
      transport.sent.map((request) => new URL(request.url).hostname),
    ).toEqual([
      "www.amctheatres.com",
      "www.amctheatres.com",
      "www.amctheatres.com",
      "queue.amctheatres.com",
      "www.amctheatres.com",
      "www.amctheatres.com",
      "www.amctheatres.com",
    ]);
    expect(
      decodeAmcSession((await store.load(AMC_SESSION_KEY))!).cookies.some(
        (cookie) => cookie.name.startsWith("QueueITAccepted-"),
      ),
    ).toBe(true);
  });

  it("lazily browser-refreshes a missing session, validates it, persists it, and reads once", async () => {
    const store = await newStore();
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const browserRefresher = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([
      htmlResponse(listing),
      htmlResponse(seats),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher,
      sessionRefresher: browserRefresher,
      listingUrl: LISTING_URL,
    });

    const layout = await runtime.getSeatLayout("900000004");

    expect(layout).toMatchObject({ columns: 7, rows: 4 });
    expect(browserRefresher.calls).toBe(1);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]?.headers.cookie).toBe("root=browser-fresh");
    expect(transport.sent[1]?.headers.cookie).toBe(
      "seat=scoped; root=browser-fresh",
    );
    expect(
      decodeAmcSession((await store.load(AMC_SESSION_KEY))!).cookies.find(
        (cookie) => cookie.name === "root",
      )?.value,
    ).toBe("browser-fresh");
  });

  it("lazily browser-refreshes an undecodable stale session for a routine read", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, Buffer.from('{"version":2}'));
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const browserRefresher = new FakeBrowserRefresher(session("browser-fresh"));
    const runtime = new AmcRuntime({
      transport: new QueueTransport([
        htmlResponse(listing),
        htmlResponse(seats),
      ]),
      store,
      browserRefresher,
      sessionRefresher: browserRefresher,
      listingUrl: LISTING_URL,
    });

    await runtime.getSeatLayout("900000004");

    expect(browserRefresher.calls).toBe(1);
    expect(
      decodeAmcSession((await store.load(AMC_SESSION_KEY))!).cookies.find(
        (cookie) => cookie.name === "root",
      )?.value,
    ).toBe("browser-fresh");
  });

  it("coalesces concurrent missing-session reads into one browser refresh", async () => {
    const store = await newStore();
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const browserRefresher = new FakeBrowserRefresher(
      session("browser-fresh"),
      10,
    );
    const transport = new QueueTransport([
      htmlResponse(listing),
      htmlResponse(seats),
      htmlResponse(seats),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher,
      sessionRefresher: browserRefresher,
      listingUrl: LISTING_URL,
    });

    const [first, second] = await Promise.all([
      runtime.getSeatLayout("900000004"),
      runtime.getSeatLayout("900000004"),
    ]);

    expect(first).toMatchObject({ columns: 7, rows: 4 });
    expect(second).toMatchObject({ columns: 7, rows: 4 });
    expect(browserRefresher.calls).toBe(1);
    expect(transport.sent).toHaveLength(3);
  });

  it("browser-refreshes one positive challenge and retries the original read exactly once", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session("old")));
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const browserRefresher = new FakeBrowserRefresher(session("browser-fresh"));
    const challenge = {
      ...htmlResponse(
        "<title>Just a moment...</title><div>challenge-platform</div>",
      ),
      status: 429,
    };
    const transport = new QueueTransport([
      htmlResponse(listing),
      challenge,
      htmlResponse(listing),
      htmlResponse(seats),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher,
      sessionRefresher: browserRefresher,
      listingUrl: LISTING_URL,
    });

    await runtime.getSeatLayout("900000004");

    expect(browserRefresher.calls).toBe(1);
    expect(transport.sent).toHaveLength(4);
    expect(transport.sent[1]?.headers.cookie).toContain("root=old");
    expect(transport.sent[3]?.headers.cookie).toContain("root=browser-fresh");
  });

  it("browser-refreshes one definitive 401 and retries the original read exactly once", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session("old")));
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const browserRefresher = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([
      htmlResponse(listing),
      { ...htmlResponse("unauthorized"), status: 401 },
      htmlResponse(listing),
      htmlResponse(seats),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher,
      sessionRefresher: browserRefresher,
      listingUrl: LISTING_URL,
    });

    await runtime.getSeatLayout("900000004");

    expect(browserRefresher.calls).toBe(1);
    expect(transport.sent).toHaveLength(4);
  });

  it("surfaces browser unavailability without leaking underlying tool output", async () => {
    const store = await newStore();
    const browserRefresher = new FakeBrowserRefresher(
      new BrowserRefreshUnavailableError("transport"),
    );
    const runtime = new AmcRuntime({
      transport: new QueueTransport([]),
      store,
      browserRefresher,
      sessionRefresher: browserRefresher,
      listingUrl: LISTING_URL,
    });

    await expect(runtime.getSeatLayout("900000004")).rejects.toMatchObject({
      code: "AMC_BROWSER_REFRESH_UNAVAILABLE",
      stage: "transport",
      message: "AMC browser refresh unavailable (transport)",
    });
    expect(browserRefresher.calls).toBe(1);
  });

  it("uses SessionManager and atomically persists response cookie rotations", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const listing = syntheticListingHtml();
    const seats = syntheticSeatHtml();
    const rotated = htmlResponse(seats);
    rotated.setCookies = [
      "root=rotated; Domain=.amctheatres.com; Path=/; Secure; HttpOnly; SameSite=Lax",
    ];
    const transport = new QueueTransport([htmlResponse(listing), rotated]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });

    await runtime.getSeatLayout("900000004");

    expect(transport.sent[0]?.headers.cookie).toBe("root=secret");
    expect(transport.sent[1]?.headers.cookie).toBe("seat=scoped; root=secret");
    const saved = decodeAmcSession((await store.load(AMC_SESSION_KEY))!);
    expect(saved.cookies.find((cookie) => cookie.name === "root")?.value).toBe(
      "rotated",
    );
  });

  it("does not misclassify or retry a generic 429 as authentication", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new QueueTransport([
      { ...htmlResponse("rate limited"), status: 429 },
    ]);
    const browserRefresher = new FakeBrowserRefresher(
      session("must-not-be-used"),
    );
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher,
      listingUrl: LISTING_URL,
    });

    await expect(runtime.getSeatLayout("900000004")).rejects.toMatchObject({
      status: 429,
    });
    expect(transport.sent).toHaveLength(1);
    expect(browserRefresher.calls).toBe(0);
  });

  it("reloads the current jar under lock so a stale rotation cannot overwrite browser refresh", async () => {
    const store = await newStore();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession(session("stale-reader")),
    );
    const listing = syntheticListingHtml();
    const seats = htmlResponse(syntheticSeatHtml());
    seats.setCookies = [
      "sensor=rotated; Domain=.amctheatres.com; Path=/; Secure; HttpOnly; SameSite=Lax",
    ];
    const concurrentFresh = session("concurrent-browser");
    concurrentFresh.cookies.push({
      name: "browser_only",
      value: "must-survive",
      domain: ".amctheatres.com",
      path: "/",
      expires: -1,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    const transport = new QueueTransport(
      [htmlResponse(listing), seats],
      async (call) => {
        if (call === 2) {
          await store.save(AMC_SESSION_KEY, encodeAmcSession(concurrentFresh));
        }
      },
    );
    const runtime = new AmcRuntime({
      transport,
      store,
      browserRefresher: new FakeBrowserRefresher(session("unused")),
      listingUrl: LISTING_URL,
    });

    await runtime.getSeatLayout("900000004");

    const persisted = decodeAmcSession((await store.load(AMC_SESSION_KEY))!);
    expect(
      persisted.cookies.find((cookie) => cookie.name === "root")?.value,
    ).toBe("concurrent-browser");
    expect(
      persisted.cookies.find((cookie) => cookie.name === "browser_only")?.value,
    ).toBe("must-survive");
    expect(
      persisted.cookies.find((cookie) => cookie.name === "sensor")?.value,
    ).toBe("rotated");
  });
});

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-runtime-test-"));
  roots.push(root);
  return new FileSessionStore({ root, lockPollMs: 5 });
}

function session(rootValue = "secret"): AmcSession {
  return {
    version: 1,
    origin: "https://www.amctheatres.com",
    profile: "chrome147-mac",
    exportedAt: "2030-01-15T07:00:00.000Z",
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
      {
        name: "seat",
        value: "scoped",
        domain: "www.amctheatres.com",
        path: "/showtimes",
        expires: -1,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ],
  };
}

function redirectResponse(
  location: string,
  setCookies: string[] = [],
): ResponseOutput {
  return {
    status: 302,
    headers: { location },
    bodyText: "",
    timingMs: 1,
    transport: "recording",
    setCookieNames: setCookies.map((line) => line.slice(0, line.indexOf("="))),
    setCookies,
  };
}

function htmlResponse(bodyText: string): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText,
    timingMs: 10,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}
