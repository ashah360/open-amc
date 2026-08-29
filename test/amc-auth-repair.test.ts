import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { AMC_SESSION_KEY, AmcRuntime } from "../src/client/runtime";
import {
  AmcSession,
  decodeAmcSession,
  encodeAmcSession,
} from "../src/client/session";
import { PlaywrightAmcBrowserRefresher } from "../src/capabilities/browser/playwright";
import type { PlaywrightBrowserRuntime } from "../src/capabilities/browser/playwright";
import { runAmcCli } from "../src/cli";
import type { AmcClient } from "../src/client";
import type { AmcBrowserRefresher } from "../src/client/browser-refresh";
import { syntheticListingHtml } from "./fixtures";

class QueueTransport implements Transport {
  readonly name = "recording";
  readonly sent: RequestInput[] = [];
  constructor(private readonly responses: ResponseOutput[]) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected AMC request");
    return response;
  }
}

class FakeBrowserRefresher implements AmcBrowserRefresher {
  calls = 0;
  constructor(private readonly outcome: AmcSession | Error) {}
  async refresh(): Promise<AmcSession> {
    this.calls += 1;
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

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-repair-test-"));
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
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
  };
}

function htmlResponse(bodyText: string, status = 200): ResponseOutput {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText,
    timingMs: 10,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}

describe("explicit repair with a command-local browser refresher", () => {
  it("escalates to the passed refresher and canary-validates the export before persisting", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session("stale")));
    const refresher = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([
      // Direct admission hits a real challenge -> browser is required.
      htmlResponse("<title>Just a moment... Cloudflare</title>", 403),
      // The direct read canary validates the exported jar before save.
      htmlResponse(syntheticListingHtml()),
    ]);
    const runtime = new AmcRuntime({ transport, store });

    await runtime.repairSession({
      browserRefresher: refresher,
      listingUrl:
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
    });

    expect(refresher.calls).toBe(1);
    // The direct phase used the caller's listing URL, not a built-in venue.
    expect(transport.sent[0]?.url).toBe(
      "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
    );
    expect(
      decodeAmcSession((await store.load(AMC_SESSION_KEY))!).cookies.find(
        (cookie) => cookie.name === "root",
      )?.value,
    ).toBe("browser-fresh");
  });

  it("escalates to the browser for a typed direct-admission failure (target) and still canary-gates persistence", async () => {
    // Mirrors the observed live route: the initial direct target response is
    // an ordinary 200 HTML page (not the Queue-it 302, not a challenge), which
    // classifies as DirectAdmissionError("target"). Explicit repair with a
    // deliberately supplied browser (e.g. --cdp-url) must still reach it.
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session("stale")));
    const refresher = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([
      // Direct admission fails deterministically at the target stage.
      htmlResponse("<html>plain listing, no queue redirect</html>"),
      // The direct read canary validates the exported jar before save.
      htmlResponse(syntheticListingHtml()),
    ]);
    const runtime = new AmcRuntime({ transport, store });

    await runtime.repairSession({
      browserRefresher: refresher,
      listingUrl:
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    });

    expect(refresher.calls).toBe(1);
    // The canary read ran against the browser-exported jar before persisting.
    expect(transport.sent).toHaveLength(2);
    expect(
      decodeAmcSession((await store.load(AMC_SESSION_KEY))!).cookies.find(
        (cookie) => cookie.name === "root",
      )?.value,
    ).toBe("browser-fresh");
  });

  it("fails closed when the canary rejects the jar exported after a typed direct failure", async () => {
    const store = await newStore();
    const original = encodeAmcSession(session("stale"));
    await store.save(AMC_SESSION_KEY, original);
    const refresher = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([
      htmlResponse("<html>plain listing, no queue redirect</html>"),
      htmlResponse("still challenged", 401),
    ]);
    const runtime = new AmcRuntime({ transport, store });

    await expect(
      runtime.repairSession({ browserRefresher: refresher }),
    ).rejects.toThrow();
    expect(refresher.calls).toBe(1);
    expect(await store.load(AMC_SESSION_KEY)).toEqual(original);
  });

  it("fails closed when the direct canary rejects the browser-exported jar", async () => {
    const store = await newStore();
    const original = encodeAmcSession(session("stale"));
    await store.save(AMC_SESSION_KEY, original);
    const refresher = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([
      htmlResponse("<title>Just a moment... Cloudflare</title>", 403),
      // Canary rejects the exported jar: DOM admission alone is NOT success.
      htmlResponse("still challenged", 401),
    ]);
    const runtime = new AmcRuntime({ transport, store });

    await expect(
      runtime.repairSession({ browserRefresher: refresher }),
    ).rejects.toThrow();
    expect(refresher.calls).toBe(1);
    expect(await store.load(AMC_SESSION_KEY)).toEqual(original);
  });
});

describe("Playwright adapter has no built-in venue default", () => {
  it("requires an explicit AMC listing URL", () => {
    expect(
      () =>
        new PlaywrightAmcBrowserRefresher({
          runtime: {} as unknown as PlaywrightBrowserRuntime,
        } as never),
    ).toThrow(/listing URL/i);
  });
});

describe("CLI auth repair wiring", () => {
  function stubClient(repair = vi.fn(async () => undefined)): AmcClient {
    return {
      showtimes: { list: vi.fn(async () => []) },
      inventory: { get: vi.fn(), getBatch: vi.fn() },
      auth: {
        status: vi.fn(),
        bootstrap: vi.fn(),
        clear: vi.fn(),
        repair,
      },
      orders: {
        createCart: vi.fn(),
        get: vi.fn(),
        extendExpiration: vi.fn(),
        release: vi.fn(),
      },
      checkout: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
      refunds: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
      close: vi.fn(async () => undefined),
    } as unknown as AmcClient;
  }

  function run(
    argv: string[],
    client: AmcClient,
    createBrowserRepair?: (options: {
      listingUrl: string;
      channel?: string;
      executablePath?: string;
      cdpUrl?: string;
    }) => AmcBrowserRefresher,
  ) {
    const output: string[] = [];
    return runAmcCli(["node", "amc", ...argv], {
      client,
      writeOut: (line) => output.push(line),
      writeErr: (line) => output.push(line),
      ...(createBrowserRepair ? { createBrowserRepair } : {}),
    }).then((code) => ({ code, output }));
  }

  it("wires the built-in browser repair only for --listing-url", async () => {
    const built = new FakeBrowserRefresher(session());
    const factory = vi.fn(() => built);
    const repair = vi.fn(async () => undefined);
    const { code } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
        "--browser-channel",
        "chrome",
        "--json",
      ],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledWith({
      listingUrl:
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
      channel: "chrome",
    });
    expect(repair).toHaveBeenCalledWith({
      browserRepair: built,
      listingUrl:
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
    });
  });

  it("wires --cdp-url through the browser factory to repair", async () => {
    const built = new FakeBrowserRefresher(session());
    const factory = vi.fn(() => built);
    const repair = vi.fn(async () => undefined);
    const { code } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
        "--cdp-url",
        "http://127.0.0.1:53837",
        "--json",
      ],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledWith({
      listingUrl:
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
      cdpUrl: "http://127.0.0.1:53837",
    });
    expect(repair).toHaveBeenCalledWith({
      browserRepair: built,
      listingUrl:
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    });
  });

  it("stays direct-only without --listing-url", async () => {
    const factory = vi.fn();
    const repair = vi.fn(async () => undefined);
    const { code } = await run(
      ["auth", "repair", "--json"],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(0);
    expect(factory).not.toHaveBeenCalled();
    expect(repair).toHaveBeenCalledWith(undefined);
  });

  it("rejects a lookalike listing URL before any browser or repair work", async () => {
    const factory = vi.fn();
    const repair = vi.fn(async () => undefined);
    const { code, output } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        "https://www.amctheatres.com.evil.example/movie-theatres/x/amc-y/showtimes",
        "--json",
      ],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_THEATER_URL");
  });

  it("rejects browser flags without a listing URL", async () => {
    const factory = vi.fn();
    const repair = vi.fn(async () => undefined);
    const { code } = await run(
      ["auth", "repair", "--browser-channel", "chrome", "--json"],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
  });

  it("never builds browser repair for ordinary reads", async () => {
    const factory = vi.fn();
    const client = stubClient();
    const { code } = await run(
      [
        "showtimes",
        "--theater-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
        "--date",
        "2030-01-15",
        "--json",
      ],
      client,
      factory,
    );
    expect(code).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });
});
