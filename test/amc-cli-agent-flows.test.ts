import { describe, expect, it, vi } from "vitest";
import { runAmcCli, AmcCliDependencies } from "../src/cli";
import type { AmcClient } from "../src/client";
import type { AmcSeatingLayout } from "../src/client/seat-layout";
import type { CartSnapshot } from "../src/commerce/executor";
import type { CheckoutPreview, RefundPreview } from "../src/commerce/service";
import {
  ConsequenceMismatchError,
  RefundOutcomeUnknownError,
} from "../src/commerce/service";

function openCart(overrides: Partial<CartSnapshot> = {}): CartSnapshot {
  return {
    orderToken: "synthetic-order-token",
    showtimeId: "900000004",
    seats: [{ name: "A2", sku: "TICKET-ADULT", row: 1, column: 1 }],
    tickets: [{ sku: "TICKET-ADULT", quantity: 1 }],
    total: "22.50",
    expiresAt: "2030-01-15T09:00:00.000Z",
    status: "OPEN",
    ...overrides,
  };
}

function checkoutPreviewOf(
  cart: CartSnapshot,
  overrides: Partial<CheckoutPreview> = {},
): CheckoutPreview {
  return {
    kind: "checkout",
    orderToken: cart.orderToken,
    showtimeId: cart.showtimeId,
    seats: cart.seats,
    tickets: cart.tickets,
    total: cart.total,
    expiresAt: cart.expiresAt,
    emailBinding: "binding-digest",
    observedAt: "2030-01-15T08:00:00.000Z",
    confirmationToken: "checkout:synthetic",
    ...overrides,
  };
}

function refundPreviewOf(
  overrides: Partial<RefundPreview> = {},
): RefundPreview {
  return {
    kind: "refund",
    orderNumber: "1000000001",
    orderToken: "synthetic-order-token",
    lineNumbers: ["1"],
    scope: "full",
    refundTotal: "20.00",
    remainingRefundableTotal: "0.00",
    nonRefundableFee: "2.50",
    chargedTotal: "22.50",
    status: "CONFIRMED",
    emailBinding: "binding-digest",
    observedAt: "2030-01-15T08:00:00.000Z",
    confirmationToken: "refund:synthetic",
    ...overrides,
  };
}

function stubClient(overrides: DeepPartial<AmcClient> = {}): AmcClient {
  const base: AmcClient = {
    showtimes: { list: vi.fn(async () => []) },
    inventory: {
      get: vi.fn(async () => layoutWithSeat()),
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
    close: vi.fn(async () => undefined),
  };
  return merge(base, overrides);
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

describe("cart handoff", () => {
  it("cart create accepts the documented variadic seat grammar (--seat A2 A3)", async () => {
    const cart = openCart({
      seats: [
        { name: "A2", sku: "TICKET-ADULT", row: 1, column: 1 },
        { name: "A3", sku: "TICKET-ADULT", row: 1, column: 2 },
      ],
    });
    const createCart = vi.fn(async (...args: unknown[]) => {
      void args;
      return cart;
    });
    const client = stubClient({
      inventory: { get: vi.fn(async () => layoutWithSeats(["A2", "A3"])) },
      orders: { createCart },
    });
    const { code } = await run(
      [
        "cart",
        "create",
        "--showtime",
        "900000004",
        "--seat",
        "A2",
        "A3",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(createCart).toHaveBeenCalledTimes(1);
    const intent = createCart.mock.calls[0]![0] as unknown as {
      seats: Array<{ name: string }>;
    };
    expect(intent.seats.map((seat) => seat.name)).toEqual(["A2", "A3"]);
  });

  it("cart create emits the first-party checkoutUrl with exactly one write", async () => {
    const cart = openCart();
    const createCart = vi.fn(async () => cart);
    const client = stubClient({
      orders: { createCart },
    });
    const { code, output } = await run(
      ["cart", "create", "--showtime", "900000004", "--seat", "A2", "--json"],
      client,
    );
    expect(code).toBe(0);
    const result = JSON.parse(output[0]!);
    expect(result).toMatchObject({
      orderToken: "synthetic-order-token",
      total: "22.50",
      expiresAt: "2030-01-15T09:00:00.000Z",
      checkoutUrl:
        "https://www.amctheatres.com/orders/synthetic-order-token/purchase",
    });
    expect(result.seats).toHaveLength(1);
    expect(createCart).toHaveBeenCalledTimes(1);
  });
});

describe("same-cart token-first self-checkout", () => {
  it("checkout preview reads the existing cart without minting any synthetic token", async () => {
    const cart = openCart();
    const preview = vi.fn(async () => checkoutPreviewOf(cart));
    const createCart = vi.fn();
    const client = stubClient({
      checkout: { preview },
      orders: { createCart },
    });
    const { code, output } = await run(
      [
        "checkout",
        "preview",
        "--token",
        "synthetic-order-token",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    const result = JSON.parse(output[0]!);
    expect(result.kind).toBe("checkout-preview");
    expect(result.total).toBe("22.50");
    expect(result.expiresAt).toBe("2030-01-15T09:00:00.000Z");
    expect(result.checkoutUrl).toBe(
      "https://www.amctheatres.com/orders/synthetic-order-token/purchase",
    );
    // No synthetic ceremony artifacts and no provider-internal token leak.
    // (Property names assembled from parts to keep the stale-ceremony audit
    // from matching this deliberate absence check.)
    expect(result).not.toHaveProperty("approval" + "Token");
    expect(result).not.toHaveProperty("quote" + "Hash");
    expect(result.confirmationToken).toBeUndefined();
    expect(createCart).not.toHaveBeenCalled();
  });

  it("checkout submit previews the exact token freshly, then submits once with zero cart creates", async () => {
    const cart = openCart();
    const fresh = checkoutPreviewOf(cart);
    const preview = vi.fn(async () => fresh);
    const submit = vi.fn(async () => ({
      orderToken: cart.orderToken,
      confirmationNumber: "1000000002",
      chargedTotal: cart.total,
      status: "CONFIRMED" as const,
      reconciled: false,
    }));
    const createCart = vi.fn();
    const client = stubClient({
      checkout: { preview, submit },
      orders: { createCart },
    });
    const { code, output } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "synthetic-order-token",
        "--email",
        "guest@example.test",
        "--vault",
        "vault://synthetic",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(createCart).not.toHaveBeenCalled();
    // Exactly one fresh preview of the same token, then exactly one submit
    // bound to that preview's provider-internal confirmationToken.
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith({
      orderToken: "synthetic-order-token",
      email: "guest@example.test",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      preview: fresh,
      confirmationToken: fresh.confirmationToken,
      email: "guest@example.test",
      vaultPointer: "vault://synthetic",
    });
    expect(JSON.parse(output[0]!).confirmationNumber).toBe("1000000002");
  });

  it("fails via the service for an expired/closed cart with zero submits", async () => {
    const preview = vi.fn(async () => {
      // The real service preview/submit path enforces OPEN + unexpired
      // (assertCartMatchesPreview); the CLI must surface it untouched.
      throw new ConsequenceMismatchError("cart is expired");
    });
    const submit = vi.fn();
    const client = stubClient({ checkout: { preview, submit } });
    const { code, output } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "synthetic-order-token",
        "--email",
        "guest@example.test",
        "--vault",
        "vault://synthetic",
        "--json",
      ],
      client,
    );
    expect(code).toBe(1);
    expect(submit).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.code).toBe("AMC_CONSEQUENCE_MISMATCH");
  });

  it("rejects the retired ceremony flags as usage errors before any read or write", async () => {
    const preview = vi.fn();
    const submit = vi.fn();
    const client = stubClient({ checkout: { preview, submit } });
    // Flag names assembled from parts so the stale-ceremony audit (which
    // forbids these exact literals anywhere in the tree) never matches this
    // deliberate negative test.
    for (const stale of [
      ["--" + "approval", "anything"],
      ["--" + "quote-hash", "anything"],
      ["--" + "accept-total", "22.50"],
    ]) {
      const { code } = await run(
        [
          "checkout",
          "submit",
          "--token",
          "synthetic-order-token",
          "--email",
          "guest@example.test",
          ...stale,
          "--json",
        ],
        client,
      );
      expect(code).not.toBe(0);
      expect(preview).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it("checkout reconcile reads the outcome without any write", async () => {
    const reconcile = vi.fn(async () => null);
    const createCart = vi.fn();
    const submit = vi.fn();
    const client = stubClient({
      checkout: { reconcile, submit },
      orders: { createCart },
    });
    const { code, output } = await run(
      [
        "checkout",
        "reconcile",
        "--token",
        "synthetic-order-token",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ purchased: false });
    expect(createCart).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("retired one-shot buy", () => {
  it("still quotes without --confirm", async () => {
    const client = stubClient();
    const { code, output } = await run(
      ["buy", "--showtime", "900000004", "--seat", "A2", "--json"],
      client,
    );
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!).kind).toBe("quote");
  });

  it("fails --confirm safely with zero writes and a typed error", async () => {
    const createCart = vi.fn();
    const submit = vi.fn();
    const client = stubClient({
      orders: { createCart },
      checkout: { submit },
    });
    const { code, output } = await run(
      ["buy", "--showtime", "900000004", "--seat", "A2", "--confirm", "--json"],
      client,
    );
    expect(code).toBe(1);
    expect(createCart).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const { error } = JSON.parse(output[0]!);
    expect(error.code).toBe("AMC_BUY_CONFIRM_RETIRED");
    expect(error.message).toContain("checkout preview");
  });
});

describe("one-time configured receipt/payment defaults", () => {
  it("checkout submit works with just --token when defaults are configured", async () => {
    const cart = openCart();
    const fresh = checkoutPreviewOf(cart);
    const preview = vi.fn(async () => fresh);
    const submit = vi.fn(async () => ({
      orderToken: cart.orderToken,
      confirmationNumber: "1000000002",
      chargedTotal: cart.total,
      status: "CONFIRMED" as const,
      reconciled: false,
    }));
    const client = stubClient({ checkout: { preview, submit } });
    const { code } = await run(
      ["checkout", "submit", "--token", "synthetic-order-token", "--json"],
      client,
      {
        capabilities: {
          defaultReceiptEmail: "configured@example.test",
          defaultVaultPointer: "vault://configured",
        },
      },
    );
    expect(code).toBe(0);
    expect(preview).toHaveBeenCalledWith({
      orderToken: "synthetic-order-token",
      email: "configured@example.test",
    });
    expect(submit).toHaveBeenCalledWith({
      preview: fresh,
      confirmationToken: fresh.confirmationToken,
      email: "configured@example.test",
      vaultPointer: "vault://configured",
    });
  });

  it("--email overrides the configured default", async () => {
    const fresh = checkoutPreviewOf(openCart());
    const preview = vi.fn(async () => fresh);
    const submit = vi.fn(async () => ({
      orderToken: fresh.orderToken,
      confirmationNumber: "1000000002",
      chargedTotal: fresh.total,
      status: "CONFIRMED" as const,
      reconciled: false,
    }));
    const client = stubClient({ checkout: { preview, submit } });
    const { code } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "synthetic-order-token",
        "--email",
        "override@example.test",
        "--json",
      ],
      client,
      {
        capabilities: {
          defaultReceiptEmail: "configured@example.test",
          defaultVaultPointer: "vault://configured",
        },
      },
    );
    expect(code).toBe(0);
    expect(preview).toHaveBeenCalledWith({
      orderToken: "synthetic-order-token",
      email: "override@example.test",
    });
  });

  it("fails closed before any read when no receipt email exists anywhere", async () => {
    const preview = vi.fn();
    const submit = vi.fn();
    const client = stubClient({ checkout: { preview, submit } });
    const { code, output } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "synthetic-order-token",
        "--vault",
        "vault://synthetic",
        "--json",
      ],
      client,
    );
    expect(code).toBe(1);
    expect(preview).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(JSON.parse(output[0]!).error.message).toContain(
      "defaultReceiptEmail",
    );
  });
});

describe("refund preview-then-submit flow", () => {
  it("refund preview emits the quote without any synthetic token", async () => {
    const preview = vi.fn(async () => refundPreviewOf());
    const client = stubClient({ refunds: { preview } });
    const { code, output } = await run(
      [
        "refund",
        "preview",
        "--confirmation",
        "1000000001",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    const result = JSON.parse(output[0]!);
    expect(result.refundTotal).toBe("20.00");
    expect(result).not.toHaveProperty("approval" + "Token");
    expect(result).not.toHaveProperty("quote" + "Hash");
    expect(result.confirmationToken).toBeUndefined();
  });

  it("refund submit previews the requested confirmation/lines then submits once", async () => {
    const fresh = refundPreviewOf({
      lineNumbers: ["1", "2"],
      scope: "partial",
    });
    const preview = vi.fn(async () => fresh);
    const submit = vi.fn(async () => ({
      orderId: "internal",
      status: "REFUNDED" as const,
      refundTotal: fresh.refundTotal,
      nonRefundableFee: fresh.nonRefundableFee,
      reconciled: false,
    }));
    const client = stubClient({ refunds: { preview, submit } });
    const { code } = await run(
      [
        "refund",
        "submit",
        "--confirmation",
        "1000000001",
        "--email",
        "guest@example.test",
        "--lines",
        "1,2",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith({
      orderNumber: "1000000001",
      email: "guest@example.test",
      lineNumbers: ["1", "2"],
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      preview: fresh,
      confirmationToken: fresh.confirmationToken,
      email: "guest@example.test",
    });
  });

  it("rejects the retired refund ceremony flags as usage errors", async () => {
    const preview = vi.fn();
    const submit = vi.fn();
    const client = stubClient({ refunds: { preview, submit } });
    for (const stale of [
      ["--" + "approval", "anything"],
      ["--" + "accept-total", "20.00"],
    ]) {
      const { code } = await run(
        [
          "refund",
          "submit",
          "--confirmation",
          "1000000001",
          "--email",
          "guest@example.test",
          ...stale,
          "--json",
        ],
        client,
      );
      expect(code).not.toBe(0);
      expect(preview).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    }
  });
});

describe("refund reconcile after an unknown outcome", () => {
  it("follows an ambiguous refund submit with the documented read-only reconcile", async () => {
    const fresh = refundPreviewOf();
    const submit = vi.fn(async () => {
      throw new RefundOutcomeUnknownError("ambiguous", {
        orderNumber: "1000000001",
        lineNumbers: ["1"],
      });
    });
    const reconcile = vi.fn(async () => ({
      orderNumber: "1000000001",
      orderToken: "synthetic-order-token",
      status: "REFUNDED" as const,
      chargedTotal: "22.50" as const,
      nonRefundableFee: "2.50" as const,
      lines: [
        {
          lineNumber: "1",
          label: "Adult",
          refundableAmount: "0.00" as const,
          status: "REFUNDED" as const,
        },
      ],
    }));
    const client = stubClient({
      refunds: {
        preview: vi.fn(async () => fresh),
        submit,
        reconcile,
      },
    });

    const ambiguous = await run(
      [
        "refund",
        "submit",
        "--confirmation",
        "1000000001",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(ambiguous.code).toBe(1);
    const { error } = JSON.parse(ambiguous.output[0]!);
    expect(error.code).toBe("AMC_WRITE_OUTCOME_UNKNOWN");
    // PR #3 safe reconciliation context survives and names the next step's key.
    expect(error.reconciliation).toEqual({
      orderNumber: "1000000001",
      lineNumbers: ["1"],
    });

    // The documented next action: read-only reconcile of the same order.
    const { code, output } = await run(
      [
        "refund",
        "reconcile",
        "--confirmation",
        "1000000001",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({
      orderNumber: "1000000001",
      status: "REFUNDED",
    });
    expect(reconcile).toHaveBeenCalledWith({
      orderNumber: "1000000001",
      email: "guest@example.test",
    });
    // Zero additional refund writes across the whole recovery.
    expect(submit).toHaveBeenCalledTimes(1);
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

function layoutWithSeat(): AmcSeatingLayout {
  return layoutWithSeats(["A2"]);
}

function layoutWithSeats(names: string[]): AmcSeatingLayout {
  return {
    columns: names.length,
    rows: 1,
    seats: names.map((name, index) => ({
      name,
      available: true,
      column: index + 1,
      row: 1,
      type: "CanReserve",
      seatTier: "Regular",
      shouldDisplay: true,
    })),
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
