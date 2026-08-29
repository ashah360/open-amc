import { describe, expect, it, vi } from "vitest";
import { runAmcCli, AmcCliDependencies } from "../src/cli";
import type { AmcClient } from "../src/client";
import type { AmcSeatingLayout } from "../src/client/seat-layout";
import type { CartSnapshot } from "../src/commerce/executor";
import type { CheckoutPreview } from "../src/commerce/service";
import {
  CartCreationOutcomeUnknownError,
  CheckoutOutcomeUnknownError,
} from "../src/commerce/service";
function stubClient(overrides: DeepPartial<AmcClient> = {}): {
  client: AmcClient;
  closed: { count: number };
} {
  const closed = { count: 0 };
  const base: AmcClient = {
    showtimes: { list: vi.fn(async () => []) },
    inventory: {
      get: vi.fn(async () => emptyLayout()),
      getBatch: vi.fn(async () => ({ observedAt: "t", results: [] })),
    },
    auth: {
      status: vi.fn(async () => ({
        provider: "amc" as const,
        account: "personal" as const,
        status: "valid" as const,
      })),
      bootstrap: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      repair: vi.fn(async () => undefined),
    },
    orders: {
      createCart: vi.fn(),
      get: vi.fn(),
      extendExpiration: vi.fn(),
      release: vi.fn(async () => ({ released: true as const })),
    },
    checkout: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    refunds: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    close: vi.fn(async () => {
      closed.count += 1;
    }),
  };
  return { client: merge(base, overrides), closed };
}

function run(
  argv: string[],
  client: AmcClient,
  extra: Partial<AmcCliDependencies> = {},
): Promise<{ code: number; output: string[] }> {
  const output: string[] = [];
  return runAmcCli(["node", "amc", ...argv], {
    client,
    writeOut: (line) => output.push(line),
    writeErr: (line) => output.push(line),
    ...extra,
  }).then((code) => ({ code, output }));
}

describe("AMC CLI thin delegation", () => {
  it("delegates showtimes to the public client and closes it", async () => {
    const list = vi.fn(async () => [
      {
        id: "900000004",
        movieId: "1",
        movieTitle: "Example Epic",
        theaterId: "2325",
        theaterName: "AMC Metreon 16",
        date: "2030-01-15",
        time: "10:00 pm",
        dateTimeUtc: "2030-01-16T06:00:00.000Z",
        format: "IMAX 70MM",
        availability: "Sellable",
      },
    ]);
    const { client, closed } = stubClient({ showtimes: { list } });
    const { code, output } = await run(
      [
        "showtimes",
        "--theater-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
        "--date",
        "2030-01-15",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(list).toHaveBeenCalledWith({
      venue: expect.objectContaining({
        kind: "amc-theater",
        slug: "amc-empire-25",
        market: "new-york-city",
      }),
      date: "2030-01-15",
    });
    expect(JSON.parse(output[0]!).showtimes[0].id).toBe("900000004");
    expect(closed.count).toBe(1);
  });

  it("delegates a single seats read to inventory.get", async () => {
    const get = vi.fn(async () => emptyLayout());
    const { client } = stubClient({ inventory: { get } });
    const { code } = await run(["seats", "900000004", "--json"], client);
    expect(code).toBe(0);
    expect(get).toHaveBeenCalledWith("900000004");
  });

  it("routes order get/extend/release to the orders namespace", async () => {
    const extendExpiration = vi.fn(async () => ({
      orderToken: "tok",
      expiresAt: "2030-01-15T09:00:00.000Z",
    }));
    const release = vi.fn(async () => ({ released: true as const }));
    const { client } = stubClient({
      orders: { extendExpiration, release },
    });
    expect(
      (await run(["order", "extend", "--token", "tok"], client)).code,
    ).toBe(0);
    expect(extendExpiration).toHaveBeenCalledWith({ orderToken: "tok" });
    expect(
      (await run(["order", "release", "--token", "tok"], client)).code,
    ).toBe(0);
    expect(release).toHaveBeenCalledWith("tok", undefined);
  });

  it("quotes buy without touching checkout, and never requires a card", async () => {
    const createCart = vi.fn();
    const layout = layoutWithSeat();
    const { client } = stubClient({ inventory: { get: async () => layout } });
    const { code, output } = await run(
      ["buy", "--showtime", "900000004", "--seat", "A2", "--json"],
      client,
    );
    expect(code).toBe(0);
    expect(createCart).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!)).toMatchObject({ kind: "quote" });
  });

  it("surfaces typed unknown-outcome errors as stable JSON", async () => {
    const createCart = vi.fn(async () => {
      throw new CartCreationOutcomeUnknownError("ambiguous", {
        showtimeId: "900000004",
        seatNames: ["A2"],
      });
    });
    const { client } = stubClient({
      inventory: { get: async () => layoutWithSeat() },
      orders: { createCart },
    });
    const { code, output } = await run(
      ["cart", "create", "--showtime", "900000004", "--seat", "A2", "--json"],
      client,
    );
    expect(code).toBe(1);
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_WRITE_OUTCOME_UNKNOWN");
  });

  it("never auto-releases the cart when a checkout submit is ambiguous", async () => {
    const cart: CartSnapshot = {
      orderToken: "tok",
      showtimeId: "900000004",
      seats: [{ name: "A2", sku: "TICKET-ADULT", row: 1, column: 1 }],
      tickets: [{ sku: "TICKET-ADULT", quantity: 1 }],
      total: "22.50",
      expiresAt: "2030-01-15T09:00:00.000Z",
      status: "OPEN",
    };
    const fullPreview: CheckoutPreview = {
      kind: "checkout",
      orderToken: cart.orderToken,
      showtimeId: cart.showtimeId,
      seats: cart.seats,
      tickets: cart.tickets,
      total: cart.total,
      expiresAt: cart.expiresAt,
      emailBinding: "binding",
      observedAt: "2030-01-15T08:00:00.000Z",
      confirmationToken: "ct",
    };
    const preview = vi.fn(async () => fullPreview);
    const submit = vi.fn(async () => {
      throw new CheckoutOutcomeUnknownError("ambiguous", { orderToken: "tok" });
    });
    const release = vi.fn(async () => ({ released: true as const }));
    const { client } = stubClient({
      orders: { release },
      checkout: { preview, submit },
    });
    const { code, output } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "tok",
        "--email",
        "guest@example.test",
        "--vault",
        "vault://synthetic",
        "--json",
      ],
      client,
    );
    expect(code).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
    // The blanket post-dispatch release is gone: an ambiguous fulfillment must
    // never trigger an OrderDelete that could cancel a completed purchase.
    expect(release).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_WRITE_OUTCOME_UNKNOWN");
  });

  it("has no watch/orchestration commands", async () => {
    const { client } = stubClient();
    expect((await run(["watch-buy"], client)).code).not.toBe(0);
    expect((await run(["watch-good-seats"], client)).code).not.toBe(0);
  });
});

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

function merge(base: AmcClient, overrides: DeepPartial<AmcClient>): AmcClient {
  const out = { ...base } as unknown as Record<string, unknown>;
  const source = base as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = { ...(source[key] as object), ...(value as object) };
  }
  return out as unknown as AmcClient;
}

function emptyLayout(): AmcSeatingLayout {
  return { columns: 0, rows: 0, seats: [], prices: [] };
}

function layoutWithSeat(): AmcSeatingLayout {
  return {
    columns: 1,
    rows: 1,
    seats: [
      {
        name: "A2",
        available: true,
        column: 1,
        row: 1,
        type: "CanReserve",
        seatTier: "Regular",
        shouldDisplay: true,
      },
    ],
    prices: [
      {
        sku: "TICKET-ADULT",
        type: "Adult",
        price: 20,
        convenienceFee: 2.5,
        tax: 0,
      },
    ],
  };
}
