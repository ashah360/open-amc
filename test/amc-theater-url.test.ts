import { describe, expect, it, vi } from "vitest";
import {
  AmcTheaterUrlError,
  resolveOfficialAmcTheaterUrl,
} from "../src/client/theater-url";
import { resolveVenue } from "../src/client/showtimes";
import { runAmcCli } from "../src/cli";
import type { AmcClient } from "../src/client";

describe("official AMC theater URL resolution", () => {
  it("resolves a non-Metreon official showtimes URL locally", () => {
    const resolved = resolveOfficialAmcTheaterUrl(
      "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
    );
    expect(resolved).toMatchObject({
      kind: "amc-theater",
      slug: "amc-empire-25",
      market: "new-york-city",
      name: "AMC Empire 25",
      path: "/movie-theatres/new-york-city/amc-empire-25/showtimes",
      url: "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
    });
  });

  it("normalizes a bare theater page and query/date suffixes", () => {
    const bare = resolveOfficialAmcTheaterUrl(
      "https://amctheatres.com/movie-theatres/san-francisco/amc-metreon-16",
    );
    expect(bare.path).toBe(
      "/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    );
    const dated = resolveOfficialAmcTheaterUrl(
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes?date=2030-01-15",
    );
    expect(dated.slug).toBe("amc-metreon-16");
  });

  it("rejects lookalike hosts and unsupported URLs", () => {
    const hostile = [
      "https://www.amctheatres.com.evil.example/movie-theatres/x/amc-y/showtimes",
      "https://evil-amctheatres.com/movie-theatres/x/amc-y/showtimes",
      "https://amctheatres.com@evil.example/movie-theatres/x/amc-y/showtimes",
      "http://www.amctheatres.com/movie-theatres/x/amc-y/showtimes",
      "https://www.amctheatres.com:8443/movie-theatres/x/amc-y/showtimes",
      "https://www.amctheatres.com/checkout/tok",
      "https://www.amctheatres.com/movie-theatres/san-francisco",
      "https://www.amctheatres.com/movie-theatres/san-francisco/regal-metreon/showtimes",
      "not a url",
      "",
    ];
    for (const url of hostile) {
      expect(() => resolveOfficialAmcTheaterUrl(url)).toThrow(
        AmcTheaterUrlError,
      );
    }
  });

  it("is accepted directly by resolveVenue as a resolved descriptor", () => {
    const resolved = resolveOfficialAmcTheaterUrl(
      "https://www.amctheatres.com/movie-theatres/boston/amc-boston-common-19/showtimes",
    );
    const venue = resolveVenue(resolved);
    expect(venue.slug).toBe("amc-boston-common-19");
    // Registry-based custom venue injection still works.
    expect(
      resolveVenue("custom", {
        custom: { id: "1", name: "X", slug: "amc-x", path: "/p" },
      }).slug,
    ).toBe("amc-x");
  });
});

describe("CLI theater resolve and showtimes --theater-url", () => {
  function stubClient(list = vi.fn(async () => [])): AmcClient {
    return {
      showtimes: { list },
      inventory: {
        get: vi.fn(),
        getBatch: vi.fn(),
      },
      auth: {
        status: vi.fn(),
        bootstrap: vi.fn(),
        clear: vi.fn(),
        repair: vi.fn(),
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

  function run(argv: string[], client: AmcClient) {
    const output: string[] = [];
    return runAmcCli(["node", "amc", ...argv], {
      client,
      writeOut: (line) => output.push(line),
      writeErr: (line) => output.push(line),
    }).then((code) => ({ code, output }));
  }

  it("theater resolve emits the typed descriptor without any provider read", async () => {
    const list = vi.fn(async () => []);
    const client = stubClient(list);
    const { code, output } = await run(
      [
        "theater",
        "resolve",
        "--url",
        "https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      kind: "amc-theater",
      slug: "amc-river-east-21",
      name: "AMC River East 21",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("theater resolve rejects a lookalike host with a typed JSON error", async () => {
    const { code, output } = await run(
      [
        "theater",
        "resolve",
        "--url",
        "https://www.amctheatres.com.evil.example/movie-theatres/x/amc-y/showtimes",
        "--json",
      ],
      stubClient(),
    );
    expect(code).toBe(1);
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_THEATER_URL");
  });

  it("showtimes --theater-url queries via the resolved descriptor", async () => {
    const list = vi.fn(async () => []);
    const { code } = await run(
      [
        "showtimes",
        "--theater-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
        "--date",
        "2030-01-15",
        "--json",
      ],
      stubClient(list),
    );
    expect(code).toBe(0);
    expect(list).toHaveBeenCalledWith({
      venue: expect.objectContaining({ slug: "amc-empire-25" }),
      date: "2030-01-15",
    });
  });

  it("showtimes requires exactly one of --venue and --theater-url", async () => {
    const neither = await run(
      ["showtimes", "--date", "2030-01-15", "--json"],
      stubClient(),
    );
    expect(neither.code).toBe(1);
    const both = await run(
      [
        "showtimes",
        "--venue",
        "metreon-16",
        "--theater-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
        "--date",
        "2030-01-15",
        "--json",
      ],
      stubClient(),
    );
    expect(both.code).toBe(1);
  });
});
