import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BuiltInBrowserRepairOptions,
  builtInRepairConnection,
  parseBrowserProxyUrl,
  runAmcCli,
} from "../src/cli";
import type { AmcClient } from "../src/client";
import type { AmcBrowserRefresher } from "../src/client/browser-refresh";
import type { AmcSession } from "../src/client/session";

const LISTING =
  "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes";
// A stand-in with percent-encoded credentials; never a real secret.
const PROXY_WITH_CREDS =
  "http://user%40corp:p%23ss%25w@proxy.example.test:8080";

const savedProxy = process.env.AMC_PROXY_URL;
afterEach(() => {
  if (savedProxy === undefined) delete process.env.AMC_PROXY_URL;
  else process.env.AMC_PROXY_URL = savedProxy;
});

class FakeBrowserRefresher implements AmcBrowserRefresher {
  async refresh(): Promise<AmcSession> {
    return {
      version: 1,
      origin: "https://www.amctheatres.com",
      profile: "chrome147-mac",
      exportedAt: "2030-01-15T07:00:00.000Z",
      cookies: [],
    };
  }
}

function stubClient(repair = vi.fn(async () => undefined)): AmcClient {
  return {
    showtimes: { list: vi.fn(async () => []) },
    inventory: { get: vi.fn(), getBatch: vi.fn() },
    auth: { status: vi.fn(), bootstrap: vi.fn(), clear: vi.fn(), repair },
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
  factory?: (options: BuiltInBrowserRepairOptions) => AmcBrowserRefresher,
) {
  const output: string[] = [];
  return runAmcCli(["node", "amc", ...argv], {
    client,
    writeOut: (line) => output.push(line),
    writeErr: (line) => output.push(line),
    ...(factory ? { createBrowserRepair: factory } : {}),
  }).then((code) => ({ code, output }));
}

describe("parseBrowserProxyUrl", () => {
  it("parses an http proxy with percent-encoded credentials into the Playwright shape", () => {
    expect(parseBrowserProxyUrl(PROXY_WITH_CREDS)).toEqual({
      server: "http://proxy.example.test:8080",
      username: "user@corp",
      password: "p#ss%w",
    });
  });

  it("parses https and socks5 proxies without credentials", () => {
    expect(parseBrowserProxyUrl("https://proxy.example.test:3128")).toEqual({
      server: "https://proxy.example.test:3128",
    });
    expect(parseBrowserProxyUrl("socks5://127.0.0.1:1080")).toEqual({
      server: "socks5://127.0.0.1:1080",
    });
  });

  it.each([
    ["not a url", "garbage"],
    ["unsupported scheme", "ftp://proxy.example.test:2121"],
    [
      "socks with credentials (Chromium cannot authenticate SOCKS)",
      "socks5://user:secretpw@127.0.0.1:1080",
    ],
    ["path", "http://proxy.example.test:8080/path"],
    ["query", "http://proxy.example.test:8080/?x=1"],
    ["missing host", "http://user@"],
    ["malformed percent-encoding", "http://bad%GG:pw@proxy.example.test:8080"],
  ])(
    "rejects %s with a typed setup error that never echoes the value",
    (_case, raw) => {
      let error: unknown;
      try {
        parseBrowserProxyUrl(raw);
      } catch (e) {
        error = e;
      }
      expect((error as { code?: string }).code).toBe("AMC_CLI_SETUP");
      const message = (error as Error).message;
      expect(message).not.toContain(raw);
      expect(message).not.toContain("secretpw");
      expect(message).not.toContain("proxy.example.test");
    },
  );
});

describe("built-in repair connection proxy policy", () => {
  it("threads the parsed proxy into a launch connection", () => {
    expect(
      builtInRepairConnection({
        listingUrl: LISTING,
        channel: "chrome",
        proxyUrl: PROXY_WITH_CREDS,
      }),
    ).toEqual({
      kind: "launch",
      headless: false,
      channel: "chrome",
      proxy: {
        server: "http://proxy.example.test:8080",
        username: "user@corp",
        password: "p#ss%w",
      },
    });
  });

  it("adds no proxy key when none is configured", () => {
    expect(
      builtInRepairConnection({ listingUrl: LISTING, channel: "chrome" }),
    ).not.toHaveProperty("proxy");
  });

  it("fails closed on --cdp-url + proxy without echoing either value", () => {
    let error: unknown;
    try {
      builtInRepairConnection({
        listingUrl: LISTING,
        cdpUrl: "http://127.0.0.1:9222",
        proxyUrl: PROXY_WITH_CREDS,
      });
    } catch (e) {
      error = e;
    }
    expect((error as { code?: string }).code).toBe("AMC_CLI_SETUP");
    const message = (error as Error).message;
    expect(message).not.toContain("proxy.example.test");
    expect(message).not.toContain("9222");
    expect(message).toMatch(/--browser-channel|launch/i);
  });
});

describe("CLI same-egress browser repair wiring", () => {
  it("auth repair passes AMC_PROXY_URL to the launched repair browser options", async () => {
    process.env.AMC_PROXY_URL = PROXY_WITH_CREDS;
    const factory = vi.fn(() => new FakeBrowserRefresher());
    const repair = vi.fn(async () => undefined);
    const { code, output } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        LISTING,
        "--browser-channel",
        "chrome",
        "--json",
      ],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledWith({
      listingUrl: LISTING,
      channel: "chrome",
      proxyUrl: PROXY_WITH_CREDS,
    });
    expect(repair).toHaveBeenCalledTimes(1);
    // The proxy URL (and its credentials) never reach any output line.
    expect(output.join("\n")).not.toContain("proxy.example.test");
  });

  it("setup passes AMC_PROXY_URL to the launched repair browser options", async () => {
    process.env.AMC_PROXY_URL = PROXY_WITH_CREDS;
    const factory = vi.fn(() => new FakeBrowserRefresher());
    const { code, output } = await run(
      ["setup", "--theater-url", LISTING, "--json"],
      stubClient(),
      factory,
    );
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledWith({
      listingUrl: LISTING,
      channel: "chrome",
      proxyUrl: PROXY_WITH_CREDS,
    });
    expect(output.join("\n")).not.toContain("proxy.example.test");
  });

  it("leaves options untouched when AMC_PROXY_URL is unset", async () => {
    delete process.env.AMC_PROXY_URL;
    const factory = vi.fn(
      (_options: BuiltInBrowserRepairOptions) => new FakeBrowserRefresher(),
    );
    const { code } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        LISTING,
        "--browser-channel",
        "chrome",
        "--json",
      ],
      stubClient(),
      factory,
    );
    expect(code).toBe(0);
    expect(factory.mock.calls[0]![0]).not.toHaveProperty("proxyUrl");
  });

  it("rejects --cdp-url with AMC_PROXY_URL before any browser factory or repair, leaking nothing", async () => {
    process.env.AMC_PROXY_URL = PROXY_WITH_CREDS;
    const factory = vi.fn(() => new FakeBrowserRefresher());
    const repair = vi.fn(async () => undefined);
    const { code, output } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        LISTING,
        "--cdp-url",
        "http://127.0.0.1:9222",
        "--json",
      ],
      stubClient(repair),
      factory,
    );
    expect(code).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    const envelope = JSON.parse(output[0]!);
    expect(envelope.error.code).toBe("AMC_CLI_SETUP");
    const all = output.join("\n");
    expect(all).not.toContain("proxy.example.test");
    expect(all).not.toContain("p%23ss");
    expect(all).not.toContain("user%40corp");
  });

  it("rejects setup --cdp-url with AMC_PROXY_URL the same way", async () => {
    process.env.AMC_PROXY_URL = PROXY_WITH_CREDS;
    const factory = vi.fn(() => new FakeBrowserRefresher());
    const { code, output } = await run(
      [
        "setup",
        "--theater-url",
        LISTING,
        "--cdp-url",
        "http://127.0.0.1:9222",
        "--json",
      ],
      stubClient(),
      factory,
    );
    expect(code).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_CLI_SETUP");
    expect(output.join("\n")).not.toContain("proxy.example.test");
  });

  it("rejects a malformed AMC_PROXY_URL before any browser factory, leaking nothing", async () => {
    process.env.AMC_PROXY_URL = "ftp://user:secretpw@proxy.example.test:2121";
    const factory = vi.fn(() => new FakeBrowserRefresher());
    const { code, output } = await run(
      [
        "auth",
        "repair",
        "--listing-url",
        LISTING,
        "--browser-channel",
        "chrome",
        "--json",
      ],
      stubClient(),
      factory,
    );
    expect(code).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_CLI_SETUP");
    const all = output.join("\n");
    expect(all).not.toContain("secretpw");
    expect(all).not.toContain("proxy.example.test");
  });
});
