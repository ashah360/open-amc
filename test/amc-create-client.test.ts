import { mkdtemp, rm, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAmcClient } from "../src/client";
import { MemorySessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { HelloTransport, helloPoolOwnerCount } from "../src/transport";
import {
  AMC_SESSION_KEY,
  AmcSessionRepairRequiredError,
} from "../src/client/runtime";
import { AmcBrowserRefresher } from "../src/client/browser-refresh";
import {
  AmcSession,
  decodeAmcSession,
  encodeAmcSession,
} from "../src/client/session";
import {
  CartCreationOutcomeUnknownError,
  ReleaseOutcomeUnknownError,
} from "../src/commerce/service";
import { CartCreateIntent } from "../src/commerce/executor";

class FakeTransport implements Transport {
  readonly name = "fake";
  readonly sent: RequestInput[] = [];
  readonly operations: string[] = [];
  closeCalls = 0;
  constructor(
    private readonly handler: (
      input: RequestInput,
      operationName: string | null,
    ) => ResponseOutput | Promise<ResponseOutput>,
  ) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    let operationName: string | null = null;
    if (input.body) {
      try {
        operationName =
          (JSON.parse(input.body) as { operationName?: string })
            .operationName ?? null;
      } catch {
        operationName = null;
      }
    }
    if (operationName) this.operations.push(operationName);
    return this.handler(input, operationName);
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function json(body: unknown, setCookies: string[] = []): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify(body),
    timingMs: 1,
    transport: "fake",
    setCookieNames: setCookies.map((line) => line.slice(0, line.indexOf("="))),
    setCookies,
  };
}

function httpError(status: number): ResponseOutput {
  return {
    status,
    headers: { "content-type": "application/json" },
    bodyText: "{}",
    timingMs: 1,
    transport: "fake",
    setCookieNames: [],
    setCookies: [],
  };
}

function challenge(): ResponseOutput {
  return {
    status: 403,
    headers: { "content-type": "text/html" },
    bodyText: "<title>Just a moment...</title> queue-it waiting room",
    timingMs: 1,
    transport: "fake",
    setCookieNames: [],
    setCookies: [],
  };
}

const authenticated = () =>
  json({ data: { viewer: { user: { __typename: "User" } } } });

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
    ],
  };
}

const inventoryBody = (showtimeId: string) => ({
  data: {
    viewer: {
      showtime: {
        showtimeId: Number(showtimeId),
        status: "OnSale",
        prices: [
          {
            sku: "TICKET-ADULT",
            type: "Adult",
            price: 20,
            convenienceFee: 2.5,
            tax: 0,
          },
        ],
        seatingLayout: {
          columns: 1,
          rows: 1,
          seats: [
            {
              name: "A1",
              available: true,
              column: 1,
              row: 1,
              type: "CanReserve",
              seatTier: "Regular",
              shouldDisplay: true,
            },
          ],
        },
      },
    },
  },
});

const validIntent = (): CartCreateIntent => ({
  showtimeId: "900000004",
  seats: [{ name: "A1", sku: "TICKET-ADULT", quantity: 1, row: 1, column: 1 }],
  waiveSubscriptionDiscounts: false,
  expectedTotal: "22.50",
  holdAcknowledgement: "CREATE_HOLD",
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("HelloTransport defaults and pool ownership", () => {
  it("pins the canonical profile by default and honors a custom profile", async () => {
    const canonical = new HelloTransport();
    const custom = new HelloTransport("amc-browser");
    expect(canonical.profile).toBe("chrome147-mac");
    expect(custom.profile).toBe("amc-browser");
    await canonical.close();
    await custom.close();
  });

  it("releases exactly its own reference so closing one never drains another's pool", async () => {
    const before = helloPoolOwnerCount();
    const first = new HelloTransport();
    const second = new HelloTransport();
    expect(helloPoolOwnerCount()).toBe(before + 2);

    await first.close();
    // The pool is drained only at zero live transports; `second` still holds one.
    expect(helloPoolOwnerCount()).toBe(before + 1);
    await first.close(); // idempotent
    expect(helloPoolOwnerCount()).toBe(before + 1);

    await second.close();
    expect(helloPoolOwnerCount()).toBe(before);
  });
});

describe("createAmcClient", () => {
  it("exposes only the curated namespaced API (no runtime/commerce escape hatch)", () => {
    const client = createAmcClient({
      transport: new FakeTransport(() => authenticated()),
      store: new MemorySessionStore(),
    });
    expect(Object.keys(client).sort()).toEqual([
      "auth",
      "checkout",
      "close",
      "inventory",
      "orders",
      "refunds",
      "showtimes",
    ]);
    expect(
      (client as unknown as Record<string, unknown>).runtime,
    ).toBeUndefined();
    expect(
      (client as unknown as Record<string, unknown>).commerce,
    ).toBeUndefined();
  });

  it("defaults to an in-memory session store and writes no filesystem state", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "amc-home-"));
    roots.push(home);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const transport = new FakeTransport((_input, operation) => {
        if (operation === "ShowtimeInventory") {
          return json(inventoryBody("900000004"), [
            "sensor=rotated; Domain=.amctheatres.com; Path=/; Secure; SameSite=Lax",
          ]);
        }
        throw new Error(`unexpected operation: ${operation}`);
      });
      // No `store` configured: must default to memory, not the filesystem.
      const client = createAmcClient({ transport });
      await client.inventory.get("900000004");
      await client.close();
      // Nothing should have been written under HOME (no ~/.open-amc, etc.).
      expect(await readdir(home)).toEqual([]);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it("closing factory clients never releases a caller-injected HelloTransport", async () => {
    const injected = new HelloTransport();
    const before = helloPoolOwnerCount(); // injected already counted
    const clientA = createAmcClient();
    const clientB = createAmcClient();
    expect(helloPoolOwnerCount()).toBe(before + 2);

    await clientA.close();
    await clientB.close();
    // Both factory transports released; the caller-injected one is untouched.
    expect(helloPoolOwnerCount()).toBe(before);

    await injected.close(); // only its own explicit close releases it
    expect(helloPoolOwnerCount()).toBe(before - 1);
  });

  it("does not close a caller-injected HelloTransport on client.close()", async () => {
    const injected = new HelloTransport();
    const before = helloPoolOwnerCount();
    const client = createAmcClient({
      transport: injected,
      store: new MemorySessionStore(),
    });
    await client.close();
    // client.close() must not have released the injected transport's reference.
    expect(helloPoolOwnerCount()).toBe(before);
    await injected.close();
    expect(helloPoolOwnerCount()).toBe(before - 1);
  });

  it("does not call close() on an injected custom transport", async () => {
    const transport = new FakeTransport(() => authenticated());
    const client = createAmcClient({
      transport,
      store: new MemorySessionStore(),
    });
    await client.close();
    expect(transport.closeCalls).toBe(0);
  });

  it("reads inventory over an injected custom transport (GraphQL-first)", async () => {
    const store = new MemorySessionStore();
    const transport = new FakeTransport((_input, operation) => {
      if (operation === "ShowtimeInventory") {
        return json(inventoryBody("900000004"));
      }
      throw new Error(`unexpected operation: ${operation}`);
    });
    const client = createAmcClient({ transport, store });
    const layout = await client.inventory.get("900000004");
    expect(layout).toMatchObject({ columns: 1, rows: 1 });
  });

  it("resolves a custom injected venue for showtime reads", async () => {
    const store = new MemorySessionStore();
    const transport = new FakeTransport((_input, operation) => {
      if (operation === "DatedShowtimes") {
        return json(customVenueShowtimes());
      }
      throw new Error(`unexpected operation: ${operation}`);
    });
    const client = createAmcClient({
      transport,
      store,
      venues: {
        "custom-1": {
          id: "9999",
          name: "Custom Cinema",
          slug: "custom-slug",
          path: "/movie-theatres/custom/custom-slug/showtimes",
        },
      },
    });
    const showtimes = await client.showtimes.list({
      venue: "custom-1",
      date: "2030-01-15",
    });
    expect(showtimes).toHaveLength(1);
    expect(showtimes[0]).toMatchObject({
      id: "900000010",
      theaterName: "Custom Cinema",
      format: "Standard",
    });
  });
});

describe("createAmcClient session repair is explicit", () => {
  it("keeps a challenged routine inventory read direct-only even with a browser configured", async () => {
    const store = new MemorySessionStore();
    let browserCalls = 0;
    const browserRepair: AmcBrowserRefresher = {
      async refresh() {
        browserCalls += 1;
        return session("must-not-be-used");
      },
    };
    const transport = new FakeTransport((input, operation) => {
      // Both the graph inventory read and the direct listing repair challenge.
      if (new URL(input.url).hostname === "www.amctheatres.com") {
        return challenge();
      }
      if (operation === "ShowtimeInventory") return challenge();
      throw new Error(`unexpected request: ${operation}`);
    });
    const client = createAmcClient({ transport, store, browserRepair });

    await expect(client.inventory.get("900000004")).rejects.toBeInstanceOf(
      AmcSessionRepairRequiredError,
    );
    expect(browserCalls).toBe(0);
  });

  it("surfaces repair-required from explicit repair when no browser is configured", async () => {
    const store = new MemorySessionStore();
    const transport = new FakeTransport(() => challenge());
    const client = createAmcClient({ transport, store });
    await expect(client.auth.repair()).rejects.toBeInstanceOf(
      AmcSessionRepairRequiredError,
    );
  });

  it("uses an explicitly injected browser capability only for auth.repair()", async () => {
    const store = new MemorySessionStore();
    let browserCalls = 0;
    const browserRepair: AmcBrowserRefresher = {
      async refresh() {
        browserCalls += 1;
        return session("browser-fresh");
      },
    };
    const transport = new FakeTransport((input, operation) => {
      if (new URL(input.url).hostname === "www.amctheatres.com") {
        return challenge();
      }
      if (operation === "AmcAuthCanary") return authenticated();
      throw new Error(`unexpected request: ${operation}`);
    });
    const client = createAmcClient({ transport, store, browserRepair });

    await client.auth.repair();
    expect(browserCalls).toBe(1);
    expect(
      decodeAmcSession((await store.load(AMC_SESSION_KEY))!).cookies.find(
        (cookie) => cookie.name === "root",
      )?.value,
    ).toBe("browser-fresh");
  });
});

describe("createAmcClient ambiguous-write semantics", () => {
  it("dispatches a cart create once and returns a typed unknown outcome on ambiguity", async () => {
    const store = new MemorySessionStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    let cartAttempts = 0;
    const transport = new FakeTransport((_input, operation) => {
      if (operation === "AmcAuthCanary") return authenticated();
      if (operation === "CartCreateOrder") {
        cartAttempts += 1;
        return httpError(500);
      }
      throw new Error(`unexpected operation: ${operation}`);
    });
    const client = createAmcClient({ transport, store });

    const failure = await client.orders
      .createCart(validIntent())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CartCreationOutcomeUnknownError);
    expect((failure as CartCreationOutcomeUnknownError).reconciliation).toEqual(
      {
        showtimeId: "900000004",
        seatNames: ["A1"],
      },
    );
    expect(cartAttempts).toBe(1);
  });
});

describe("createAmcClient stateless release (no journal)", () => {
  it("releases a cart without any durable journal", async () => {
    const store = new MemorySessionStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new FakeTransport((_input, operation) => {
      if (operation === "AmcAuthCanary") return authenticated();
      if (operation === "OrderDelete") {
        return json({ data: { orderDelete: { success: true } } });
      }
      throw new Error(`unexpected operation: ${operation}`);
    });
    const client = createAmcClient({ transport, store });
    await expect(client.orders.release("order-token-1")).resolves.toEqual({
      released: true,
    });
  });

  it("reconciles an ambiguous release once and returns released when cancelled", async () => {
    const store = new MemorySessionStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    let deletes = 0;
    const transport = new FakeTransport((_input, operation) => {
      if (operation === "AmcAuthCanary") return authenticated();
      if (operation === "OrderDelete") {
        deletes += 1;
        return httpError(500);
      }
      if (operation === "OrderProjection") {
        return json({
          data: {
            viewer: {
              order: {
                token: "order-token-2",
                status: "Cancelled",
                error: null,
              },
            },
          },
        });
      }
      throw new Error(`unexpected operation: ${operation}`);
    });
    const client = createAmcClient({ transport, store });
    await expect(client.orders.release("order-token-2")).resolves.toEqual({
      released: true,
    });
    // The consequential OrderDelete was dispatched at most once.
    expect(deletes).toBe(1);
  });

  it("throws a typed unknown outcome when an ambiguous release cannot be proven released", async () => {
    const store = new MemorySessionStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    let deletes = 0;
    const transport = new FakeTransport((_input, operation) => {
      if (operation === "AmcAuthCanary") return authenticated();
      if (operation === "OrderDelete") {
        deletes += 1;
        return httpError(500);
      }
      if (operation === "OrderProjection") {
        return json({
          data: {
            viewer: {
              order: { token: "order-token-3", status: "Pending", error: null },
            },
          },
        });
      }
      throw new Error(`unexpected operation: ${operation}`);
    });
    const client = createAmcClient({ transport, store });
    const failure = await client.orders
      .release("order-token-3")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReleaseOutcomeUnknownError);
    expect((failure as ReleaseOutcomeUnknownError).reconciliation).toEqual({
      orderToken: "order-token-3",
    });
    expect(deletes).toBe(1);
  });
});

function customVenueShowtimes() {
  return {
    data: {
      viewer: {
        user: {
          movies: {
            items: [
              {
                movie: {
                  movieId: 1,
                  name: "Custom Movie",
                  slug: "custom-movie",
                },
                theatres: [
                  {
                    theatre: {
                      theatreId: 9999,
                      name: "Custom Cinema",
                      slug: "custom-slug",
                    },
                    formats: {
                      items: [
                        {
                          attributes: [{ name: "Standard" }],
                          groups: {
                            edges: [
                              {
                                node: {
                                  showtimeGroupHeadingAttribute: {
                                    name: "Standard",
                                  },
                                  showtimes: {
                                    edges: [
                                      {
                                        node: {
                                          showtimeId: 900000010,
                                          businessDate: "2030-01-15",
                                          when: "2030-01-16T03:00:00.000Z",
                                          status: "Sellable",
                                          display: { time: "7:00", amPm: "PM" },
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}
