import { describe, expect, it, vi } from "vitest";
import { runAmcCli, BuiltInBrowserRepairOptions } from "../src/cli";
import type { AmcClient } from "../src/client";
import type { AmcBrowserRefresher } from "../src/client/browser-refresh";
import type { AmcSession } from "../src/client/session";
import { PlaywrightConnectionError } from "../src/capabilities/browser/playwright/runtime";

const THEATER_URL =
  "https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes";

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

function stubClient(
  overrides: {
    repair?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
  } = {},
): AmcClient {
  return {
    showtimes: { list: overrides.list ?? vi.fn(async () => []) },
    inventory: { get: vi.fn(), getBatch: vi.fn() },
    auth: {
      status: vi.fn(),
      bootstrap: vi.fn(),
      clear: vi.fn(),
      repair: overrides.repair ?? vi.fn(async () => undefined),
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
  factory = vi.fn(
    (_options: BuiltInBrowserRepairOptions): AmcBrowserRefresher =>
      new FakeBrowserRefresher(),
  ),
) {
  const output: string[] = [];
  return runAmcCli(["node", "amc", ...argv], {
    client,
    createBrowserRepair: factory,
    writeOut: (line) => output.push(line),
    writeErr: (line) => output.push(line),
  }).then((code) => ({ code, output, factory }));
}

describe("amc setup", () => {
  it("defaults to the visible installed Chrome channel and runs exactly one repair", async () => {
    const repair = vi.fn(async () => undefined);
    const client = stubClient({ repair });
    const { code, output, factory } = await run(
      ["setup", "--theater-url", THEATER_URL, "--json"],
      client,
    );
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);
    const options = factory.mock.calls[0]![0];
    expect(options).toMatchObject({
      listingUrl: THEATER_URL,
      channel: "chrome",
    });
    expect(options.headless).toBeUndefined();
    expect(options.cdpUrl).toBeUndefined();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith({
      browserRepair: expect.any(FakeBrowserRefresher),
      listingUrl: THEATER_URL,
    });

    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({
      kind: "setup",
      cli: "ready",
      auth: "valid",
      theater: {
        name: "AMC River East 21",
        slug: "amc-river-east-21",
        market: "chicago",
        url: THEATER_URL,
      },
    });
    expect(String(result.nextCommand)).toContain("amc showtimes --theater-url");
    // No tokens, cookies, or filesystem paths in the stable success shape.
    const serialized = output[0]!;
    expect(serialized).not.toMatch(/token|cookie|\/home\/|session/i);
  });

  it("honors explicit selectors: --cdp-url wins and no chrome channel default is added", async () => {
    const { code, factory } = await run(
      [
        "setup",
        "--theater-url",
        THEATER_URL,
        "--cdp-url",
        "http://127.0.0.1:9222",
        "--json",
      ],
      stubClient(),
    );
    expect(code).toBe(0);
    const options = factory.mock.calls[0]![0];
    expect(options).toMatchObject({ cdpUrl: "http://127.0.0.1:9222" });
    expect(options.channel).toBeUndefined();
  });

  it("passes --headless and --browser-executable through as best-effort overrides", async () => {
    const { code, factory } = await run(
      [
        "setup",
        "--theater-url",
        THEATER_URL,
        "--browser-executable",
        "/usr/bin/chromium",
        "--headless",
        "--json",
      ],
      stubClient(),
    );
    expect(code).toBe(0);
    const options = factory.mock.calls[0]![0];
    expect(options).toMatchObject({
      executablePath: "/usr/bin/chromium",
      headless: true,
    });
    expect(options.channel).toBeUndefined();
  });

  it("runs the optional dated read canary through the resolved theater", async () => {
    const list = vi.fn(async () => [{ id: "1" }, { id: "2" }]);
    const { code, output } = await run(
      ["setup", "--theater-url", THEATER_URL, "--date", "2030-01-15", "--json"],
      stubClient({ list }),
    );
    expect(code).toBe(0);
    expect(list).toHaveBeenCalledWith({
      venue: expect.objectContaining({ slug: "amc-river-east-21" }),
      date: "2030-01-15",
    });
    expect(JSON.parse(output[0]!).read).toEqual({
      date: "2030-01-15",
      showtimes: 2,
    });
  });

  it("rejects a lookalike theater URL before any browser or repair work", async () => {
    const repair = vi.fn();
    const { code, output, factory } = await run(
      [
        "setup",
        "--theater-url",
        "https://www.amctheatres.com.evil.example/movie-theatres/x/amc-y/showtimes",
        "--json",
      ],
      stubClient({ repair }),
    );
    expect(code).toBe(1);
    expect(factory).not.toHaveBeenCalled();
    expect(repair).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_THEATER_URL");
  });

  it("surfaces a typed repair failure through the existing envelope with no writes", async () => {
    const repairError = Object.assign(
      new Error("AMC session repair could not establish a trusted session"),
      { code: "AMC_SESSION_REPAIR_REQUIRED" },
    );
    const repair = vi.fn(async () => {
      throw repairError;
    });
    const list = vi.fn();
    const { code, output } = await run(
      ["setup", "--theater-url", THEATER_URL, "--json"],
      stubClient({ repair, list }),
    );
    expect(code).toBe(1);
    expect(list).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe(
      "AMC_SESSION_REPAIR_REQUIRED",
    );
  });

  it("surfaces a dead CDP endpoint as one stable nonzero JSON error without leaking the endpoint", async () => {
    const repair = vi.fn(async () => {
      throw new PlaywrightConnectionError("unreachable");
    });
    const { code, output } = await run(
      [
        "setup",
        "--theater-url",
        THEATER_URL,
        "--cdp-url",
        "http://127.0.0.1:39861",
        "--json",
      ],
      stubClient({ repair }),
    );
    expect(code).toBe(1);
    expect(output).toHaveLength(1);
    const { error } = JSON.parse(output[0]!);
    expect(error.code).toBe("AMC_PLAYWRIGHT_CONNECTION_FAILED");
    expect(output[0]).not.toContain("39861");
  });

  it("doctor and showtimes never build a browser (setup is the only launcher here)", async () => {
    const factory = vi.fn(
      (_options: BuiltInBrowserRepairOptions): AmcBrowserRefresher =>
        new FakeBrowserRefresher(),
    );
    const doctor = await run(["doctor", "--json"], stubClient(), factory);
    expect(doctor.code).toBe(0);
    const reads = await run(
      [
        "showtimes",
        "--theater-url",
        THEATER_URL,
        "--date",
        "2030-01-15",
        "--json",
      ],
      stubClient(),
      factory,
    );
    expect(reads.code).toBe(0);
    expect(factory).not.toHaveBeenCalled();
  });
});
