import { describe, expect, it } from "vitest";
import { AmcGraphqlOrderProjectionProvider } from "../src/commerce/graphql-order-projection";
import { GraphqlEnvelope } from "../src/commerce/contracts";
import { CartCreateIntent } from "../src/commerce/executor";

const TOKEN = "00000000-0000-4000-8000-000000000042";
const NOW = new Date("2030-01-15T08:30:00.000Z");

function intent(): CartCreateIntent {
  return {
    showtimeId: "146600823",
    seats: [
      {
        name: "A9",
        sku: "TICKET-RS-146600823-ADULT",
        quantity: 1,
        row: 1,
        column: 9,
      },
    ],
    waiveSubscriptionDiscounts: false,
    expectedTotal: "12.44",
    holdAcknowledgement: "CREATE_HOLD",
  };
}

function providerFor(order: Record<string, unknown>) {
  const reader = {
    read: (_envelope: GraphqlEnvelope<{ token: string }>) =>
      Promise.resolve({ data: { viewer: { order } } }),
  };
  return new AmcGraphqlOrderProjectionProvider(reader);
}

function order(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    token: TOKEN,
    orderId: null,
    status: "Pending",
    email: null,
    paid: 0,
    total: 12.44,
    feesTotal: 1.45,
    refundableTotal: 10.99,
    refundableType: "WHOLE",
    remainingBalance: 12.44,
    expirationDateUtc: "2099-08-15T22:04:35.163Z",
    isRefunded: false,
    groups: [
      {
        confirmationCode: null,
        reservedSeats: "A9",
        feesTotal: 1.45,
        subtotal: 12.44,
        tax: 0,
        total: 12.44,
        type: "TICKET-RS",
        showtime: { showtimeId: 146600823 },
        items: [
          {
            sku: "TICKET-RS-146600823-ADULT",
            name: "Adult",
            quantity: 1,
            cost: 10.99,
            tax: 0,
            lineItems: [],
          },
        ],
      },
    ],
    refundedPaymentGroups: [],
    error: null,
    ...overrides,
  };
}

describe("provider order lifecycle decision (single projection)", () => {
  it("classifies Pending + paid==0 + unexpired as an open cart with snapshot", async () => {
    const lifecycle = await providerFor(order({})).projectLifecycle(TOKEN, {
      intent: intent(),
      now: NOW,
    });
    expect(lifecycle.kind).toBe("open");
    if (lifecycle.kind === "open") {
      expect(lifecycle.cart?.total).toBe("12.44");
      expect(lifecycle.cart?.seats.map((s) => s.name)).toEqual(["A9"]);
    }
  });

  it("classifies Pending + paid>0 as ambiguous (money moved)", async () => {
    const lifecycle = await providerFor(
      order({ paid: 12.44, remainingBalance: 0 }),
    ).projectLifecycle(TOKEN, { intent: intent(), now: NOW });
    expect(lifecycle.kind).toBe("ambiguous-paid");
  });

  it("classifies Fulfilled as purchased with the provider charged total", async () => {
    const lifecycle = await providerFor(
      order({
        status: "Fulfilled",
        orderId: "0000000001",
        email: "guest@example.test",
        paid: 12.44,
        remainingBalance: 0,
        groups: [
          {
            confirmationCode: "0000000001",
            reservedSeats: "A9",
            feesTotal: 1.45,
            subtotal: 12.44,
            tax: 0,
            total: 12.44,
            type: "TICKET-RS",
            showtime: { showtimeId: 146600823 },
            items: [
              {
                sku: "TICKET-RS-146600823-ADULT",
                name: "Adult",
                quantity: 1,
                cost: 10.99,
                tax: 0,
                lineItems: [],
              },
            ],
          },
        ],
      }),
    ).projectLifecycle(TOKEN, { now: NOW });
    expect(lifecycle.kind).toBe("purchased");
    if (lifecycle.kind === "purchased") {
      expect(lifecycle.purchase.chargedTotal).toBe("12.44");
      expect(lifecycle.purchase.confirmationNumber).toBe("0000000001");
    }
  });

  it("classifies Expired + paid==0 + empty groups as closed-unpaid (hold gone)", async () => {
    const lifecycle = await providerFor(
      order({
        status: "Expired",
        paid: 0,
        remainingBalance: 12.44,
        groups: [],
      }),
    ).projectLifecycle(TOKEN, { now: NOW });
    expect(lifecycle.kind).toBe("closed-unpaid");
  });

  it("classifies Cancelled with residual groups as drift (keep marker)", async () => {
    const lifecycle = await providerFor(
      order({ status: "Cancelled", paid: 0 }),
    ).projectLifecycle(TOKEN, { now: NOW });
    expect(lifecycle.kind).toBe("drift");
  });

  it("classifies Pending + paid==0 but expired timestamp as drift (not open)", async () => {
    const lifecycle = await providerFor(
      order({ expirationDateUtc: "2000-01-01T00:00:00.000Z" }),
    ).projectLifecycle(TOKEN, { intent: intent(), now: NOW });
    expect(lifecycle.kind).toBe("drift");
  });

  it("propagates a read failure (caller keeps the marker)", async () => {
    const reader = {
      read: () => Promise.reject(new Error("network")),
    };
    await expect(
      new AmcGraphqlOrderProjectionProvider(reader).projectLifecycle(TOKEN, {
        now: NOW,
      }),
    ).rejects.toThrow();
  });
});
