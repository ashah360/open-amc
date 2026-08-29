import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { AmcGraphReadClient } from "../src/client/graphql-reads";
import { resolveOfficialAmcTheaterUrl } from "../src/client/theater-url";
import { AMC_SESSION_KEY } from "../src/client/runtime";
import { decodeAmcSession, encodeAmcSession } from "../src/client/session";

class QueueTransport implements Transport {
  readonly name = "recording";
  readonly sent: RequestInput[] = [];
  constructor(private readonly responses: ResponseOutput[]) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }
}
class DeferredTransport implements Transport {
  readonly name = "deferred";
  private releaseResponse!: (response: ResponseOutput) => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });
  private readonly response = new Promise<ResponseOutput>((resolve) => {
    this.releaseResponse = resolve;
  });
  async request(_input: RequestInput): Promise<ResponseOutput> {
    this.markStarted();
    return this.response;
  }
  release(response: ResponseOutput): void {
    this.releaseResponse(response);
  }
}

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("AMC GraphQL reads", () => {
  it("bootstraps graph cookies anonymously and returns exact-theatre dated showtimes", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse(discoveryPayload(), [
        "session=graph-session; Domain=.amctheatres.com; Path=/; Secure; HttpOnly; SameSite=Lax",
        "__cf_bm=graph-bm; Domain=.graph.amctheatres.com; Path=/; Secure; HttpOnly; SameSite=None",
      ]),
    ]);
    const client = new AmcGraphReadClient({ transport, store });

    const showtimes = await client.getShowtimes({
      // One labeled example theater; any official AMC theater URL works.
      venue: resolveOfficialAmcTheaterUrl(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
      ),
      date: "2030-01-15",
      movie: "example feature",
      format: "laser",
    });

    expect(showtimes).toEqual([
      expect.objectContaining({
        id: "900000001",
        movieId: "80002",
        movieTitle: "Example Feature",
        theaterId: "2325",
        theaterName: "AMC Metreon 16",
        date: "2030-01-15",
        time: "6:00 pm",
        dateTimeUtc: "2030-01-16T01:00:00.000Z",
        format: "Laser at AMC",
        availability: "Sellable",
      }),
    ]);
    expect(transport.sent[0]?.headers.cookie).toBeUndefined();
    const saved = decodeAmcSession((await store.load(AMC_SESSION_KEY))!);
    expect(saved.cookies.map((cookie) => cookie.name).sort()).toEqual([
      "__cf_bm",
      "session",
    ]);
  });

  it("matches an id-less URL-resolved venue by slug and derives theaterId from the provider", async () => {
    const store = await newStore();
    const transport = new QueueTransport([jsonResponse(discoveryPayload())]);
    const client = new AmcGraphReadClient({ transport, store });
    // Resolved from an official URL: carries slug/name/path but NO internal id.
    const venue = resolveOfficialAmcTheaterUrl(
      "https://www.amctheatres.com/movie-theatres/san-francisco/amc-kabuki-8/showtimes",
    );
    expect(venue).not.toHaveProperty("id");

    const showtimes = await client.getShowtimes({
      venue,
      date: "2030-01-15",
    });

    // Slug-only matching picked the right theatre out of several, and the
    // theaterId comes from the provider response, never invented locally.
    expect(showtimes).toEqual([
      expect.objectContaining({
        id: "900000001",
        theaterId: "9999",
        theaterName: "AMC Kabuki 8",
        format: "Laser at AMC",
      }),
    ]);
  });

  it("tolerates a null group heading (fallback) and skips only a genuinely unlabeled group", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse(riverEastMixedHeadingsPayload()),
    ]);
    const client = new AmcGraphReadClient({ transport, store });

    const showtimes = await client.getShowtimes({
      venue: resolveOfficialAmcTheaterUrl(
        "https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes",
      ),
      date: "2030-01-15",
    });

    // Healthy heading group + null-heading-with-fallback group parse; the
    // unlabeled group (null heading AND empty attributes) is skipped, but its
    // valid siblings all survive — one null optional heading no longer kills
    // the whole valid theater response.
    const byId = new Map(showtimes.map((s) => [s.id, s]));
    expect(byId.get("900000010")?.format).toBe("Dolby Cinema at AMC");
    expect(byId.get("900000011")?.format).toBe("Laser at AMC");
    // The unlabeled group's showtime is not present...
    expect(byId.has("900000012")).toBe(false);
    // ...and the healthy sibling on a second movie survives.
    expect(byId.get("900000020")?.format).toBe("IMAX at AMC");
    expect(byId.get("900000020")?.theaterId).toBe("133");
    expect(showtimes).toHaveLength(3);
  });

  it("repairs one positively classified graph challenge and retries once", async () => {
    const store = await newStore();
    let repairs = 0;
    const transport = new QueueTransport([
      {
        ...jsonResponse(
          "<html>Just a moment... challenge-platform Cloudflare</html>",
        ),
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
        bodyText: "<html>Just a moment... challenge-platform Cloudflare</html>",
      },
      jsonResponse(discoveryPayload()),
    ]);
    const client = new AmcGraphReadClient({
      transport,
      store,
      repairSession: async () => {
        repairs += 1;
        return session("repaired");
      },
    });

    const showtimes = await client.getShowtimes({
      venue: resolveOfficialAmcTheaterUrl(
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
      ),
      date: "2030-01-15",
    });

    expect(showtimes).toHaveLength(1);
    expect(repairs).toBe(1);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]?.headers.cookie).toContain("root=repaired");
  });

  it("returns the strict seat grid and ticket prices from viewer.showtime", async () => {
    const store = await newStore();
    const transport = new QueueTransport([jsonResponse(inventoryPayload())]);
    const client = new AmcGraphReadClient({ transport, store });

    const layout = await client.getSeatLayout("900000001");

    expect(layout).toEqual({
      columns: 2,
      rows: 1,
      seats: [
        {
          name: "A1",
          available: true,
          column: 1,
          row: 1,
          type: "LoveSeatLeft",
          seatTier: "Regular",
          shouldDisplay: true,
        },
        {
          name: "A2",
          available: false,
          column: 2,
          row: 1,
          type: "LoveSeatRight",
          seatTier: "Regular",
          shouldDisplay: true,
        },
      ],
      prices: [
        {
          sku: "TICKET-RS-900000001-ADULT",
          type: "Adult",
          price: 20.99,
          convenienceFee: 2.69,
          tax: 0,
        },
      ],
    });
  });
  it("normalizes AMC sold-out null dimensions as explicit empty inventory", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse({
        data: {
          viewer: {
            showtime: {
              showtimeId: 900000001,
              status: "Soldout",
              seatingLayout: { columns: null, rows: null, seats: null },
              prices: [
                {
                  sku: "ADULT",
                  type: "Adult",
                  price: 20,
                  convenienceFee: 2,
                  tax: 0,
                },
              ],
            },
          },
        },
      }),
    ]);
    const client = new AmcGraphReadClient({ transport, store });

    await expect(client.getSeatLayout("900000001")).resolves.toEqual({
      columns: 0,
      rows: 0,
      seats: [],
      prices: [
        { sku: "ADULT", type: "Adult", price: 20, convenienceFee: 2, tax: 0 },
      ],
      providerStatus: "Soldout",
    });
  });

  it("rejects unverified sold-out empty-array layout drift", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse({
        data: {
          viewer: {
            showtime: {
              showtimeId: 900000001,
              status: "Soldout",
              seatingLayout: { columns: null, rows: null, seats: [] },
              prices: [
                {
                  sku: "ADULT",
                  type: "Adult",
                  price: 20,
                  convenienceFee: 2,
                  tax: 0,
                },
              ],
            },
          },
        },
      }),
    ]);
    const client = new AmcGraphReadClient({ transport, store });
    await expect(client.getSeatLayout("900000001")).rejects.toMatchObject({
      code: "AMC_GRAPH_READ_CONTRACT_ERROR",
    });
  });

  it("returns multiple strict seat layouts from one aliased GraphQL request", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse({
        data: {
          viewer: {
            s0: inventoryShowtime(900000001),
            s1: inventoryShowtime(900000002),
          },
        },
      }),
    ]);
    const client = new AmcGraphReadClient({ transport, store });

    const batch = await client.getSeatLayouts(["900000001", "900000002"]);

    expect(transport.sent).toHaveLength(1);
    const envelope = JSON.parse(transport.sent[0]!.body!);
    expect(envelope).toMatchObject({
      operationName: "MultiShowtimeInventory",
      variables: {},
    });
    expect(envelope.query).toContain("s0: showtime(id: 900000001)");
    expect(envelope.query).toContain("s1: showtime(id: 900000002)");
    expect(batch.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(batch.results).toEqual([
      expect.objectContaining({ showtimeId: "900000001", status: "ok" }),
      expect.objectContaining({ showtimeId: "900000002", status: "ok" }),
    ]);
    expect(batch.results[0]).toMatchObject({
      layout: {
        columns: 2,
        rows: 1,
        seats: [{ name: "A1" }, { name: "A2" }],
        prices: [{ sku: "TICKET-RS-900000001-ADULT" }],
      },
    });
  });

  it("isolates one aliased showtime error without discarding healthy maps", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse({
        data: { viewer: { s0: inventoryShowtime(900000001), s1: null } },
        errors: [{ message: "showtime unavailable", path: ["viewer", "s1"] }],
      }),
    ]);
    const client = new AmcGraphReadClient({ transport, store });

    const batch = await client.getSeatLayouts(["900000001", "900000003"]);

    expect(batch.results[0]).toMatchObject({
      showtimeId: "900000001",
      status: "ok",
    });
    expect(batch.results[1]).toEqual({
      showtimeId: "900000003",
      status: "error",
      code: "AMC_GRAPH_READ_CONTRACT_ERROR",
      message: "AMC GraphQL read contract failed (ShowtimeInventory:900000003)",
    });
  });

  it("rejects unscoped GraphQL errors instead of accepting healthy-looking aliases", async () => {
    const store = await newStore();
    const transport = new QueueTransport([
      jsonResponse({
        data: {
          viewer: {
            s0: inventoryShowtime(900000001),
            s1: inventoryShowtime(900000002),
          },
        },
        errors: [{ message: "global resolver failure" }],
      }),
    ]);
    const client = new AmcGraphReadClient({ transport, store });

    await expect(
      client.getSeatLayouts(["900000001", "900000002"]),
    ).rejects.toMatchObject({
      code: "AMC_GRAPH_READ_CONTRACT_ERROR",
      operation: "MultiShowtimeInventory",
    });
  });

  it("does not resurrect a session cleared while a GraphQL read is in flight", async () => {
    const store = await newStore();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession(session("before-clear")),
    );
    const transport = new DeferredTransport();
    const client = new AmcGraphReadClient({ transport, store });

    const pending = client.getSeatLayouts(["900000001", "900000002"]);
    await transport.started;
    await store.remove(AMC_SESSION_KEY);
    transport.release(
      jsonResponse(
        {
          data: {
            viewer: {
              s0: inventoryShowtime(900000001),
              s1: inventoryShowtime(900000002),
            },
          },
        },
        ["rotated=new-value; Domain=.graph.amctheatres.com; Path=/; Secure"],
      ),
    );

    await pending;
    expect(await store.load(AMC_SESSION_KEY)).toBeNull();
  });
});

function session(rootValue: string) {
  return {
    version: 1 as const,
    origin: "https://www.amctheatres.com" as const,
    profile: "chrome147-mac" as const,
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
        sameSite: "Lax" as const,
      },
    ],
  };
}

async function newStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-graph-read-"));
  roots.push(root);
  return new FileSessionStore({ root, lockPollMs: 5 });
}
function jsonResponse(
  value: unknown,
  setCookies: string[] = [],
): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: JSON.stringify(value),
    timingMs: 1,
    transport: "recording",
    setCookieNames: setCookies.map((x) => x.slice(0, x.indexOf("="))),
    setCookies,
  };
}
function discoveryPayload() {
  const showtime = {
    showtimeId: 900000001,
    businessDate: "2030-01-15",
    when: "2030-01-16T01:00:00.000Z",
    status: "Sellable",
    auditorium: 14,
    display: { time: "6:00", amPm: "PM" },
  };
  const theatre = (theatreId: number, name: string, slug: string) => ({
    theatre: { theatreId, name, slug },
    formats: {
      date: "2030-01-15",
      items: [
        {
          attributes: [{ name: "Laser at AMC" }],
          groups: {
            edges: [
              {
                node: {
                  showtimeGroupHeadingAttribute: { name: "Laser at AMC" },
                  showtimes: { edges: [{ node: showtime }] },
                },
              },
            ],
          },
        },
      ],
    },
  });
  return {
    data: {
      viewer: {
        user: {
          movies: {
            items: [
              {
                movie: {
                  movieId: 80002,
                  name: "Example Feature",
                  slug: "example-feature-80002",
                },
                theatres: [
                  theatre(9999, "AMC Kabuki 8", "amc-kabuki-8"),
                  theatre(2325, "AMC Metreon 16", "amc-metreon-16"),
                ],
              },
            ],
          },
        },
      },
    },
  };
}
// Mirrors the live River East 21 shape: HTTP 200, no GraphQL errors, exact
// provider theater id/slug, healthy siblings, plus one group with a null
// heading (valid format-level fallback) and one group with a null heading AND
// empty attributes (genuinely unlabeled).
function riverEastMixedHeadingsPayload() {
  const node = (showtimeId: number) => ({
    node: {
      showtimeId,
      businessDate: "2030-01-15",
      when: "2030-01-16T01:00:00.000Z",
      status: "Sellable",
      display: { time: "6:00", amPm: "PM" },
    },
  });
  const theatre = {
    theatre: {
      theatreId: 133,
      name: "AMC River East 21",
      slug: "amc-river-east-21",
    },
    formats: {
      date: "2030-01-15",
      items: [
        {
          // Healthy heading present.
          attributes: [{ name: "Dolby Cinema at AMC" }],
          groups: {
            edges: [
              {
                node: {
                  showtimeGroupHeadingAttribute: {
                    name: "Dolby Cinema at AMC",
                  },
                  showtimes: { edges: [node(900000010)] },
                },
              },
            ],
          },
        },
        {
          // Null heading, but a valid format-level attribute fallback exists.
          attributes: [{ name: "Laser at AMC" }],
          groups: {
            edges: [
              {
                node: {
                  showtimeGroupHeadingAttribute: null,
                  showtimes: { edges: [node(900000011)] },
                },
              },
            ],
          },
        },
        {
          // Null heading AND empty attributes: genuinely unlabeled -> skipped.
          attributes: [],
          groups: {
            edges: [
              {
                node: {
                  showtimeGroupHeadingAttribute: null,
                  showtimes: { edges: [node(900000012)] },
                },
              },
            ],
          },
        },
      ],
    },
  };
  const secondMovieTheatre = {
    theatre: {
      theatreId: 133,
      name: "AMC River East 21",
      slug: "amc-river-east-21",
    },
    formats: {
      date: "2030-01-15",
      items: [
        {
          attributes: [{ name: "IMAX at AMC" }],
          groups: {
            edges: [
              {
                node: {
                  showtimeGroupHeadingAttribute: { name: "IMAX at AMC" },
                  showtimes: { edges: [node(900000020)] },
                },
              },
            ],
          },
        },
      ],
    },
  };
  return {
    data: {
      viewer: {
        user: {
          movies: {
            items: [
              {
                movie: {
                  movieId: 80010,
                  name: "Example One",
                  slug: "one-80010",
                },
                theatres: [theatre],
              },
              {
                movie: {
                  movieId: 80020,
                  name: "Example Two",
                  slug: "two-80020",
                },
                theatres: [secondMovieTheatre],
              },
            ],
          },
        },
      },
    },
  };
}

function inventoryPayload() {
  return { data: { viewer: { showtime: inventoryShowtime(900000001) } } };
}
function inventoryShowtime(showtimeId: number) {
  return {
    showtimeId,
    seatingLayout: {
      columns: 2,
      rows: 1,
      seats: [
        {
          name: "A1",
          available: true,
          column: 1,
          row: 1,
          type: "LoveSeatLeft",
          seatTier: "Regular",
          shouldDisplay: true,
        },
        {
          name: "A2",
          available: false,
          column: 2,
          row: 1,
          type: "LoveSeatRight",
          seatTier: "Regular",
          shouldDisplay: true,
        },
      ],
    },
    prices: [
      {
        sku: `TICKET-RS-${showtimeId}-ADULT`,
        type: "Adult",
        price: 20.99,
        convenienceFee: 2.69,
        tax: 0,
      },
    ],
  };
}
