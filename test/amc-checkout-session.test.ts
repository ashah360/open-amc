import { describe, expect, it } from "vitest";
import {
  AmcCheckoutSession,
  CheckoutSessionOwnershipError,
} from "../src/commerce/checkout-session";
import { CartCreateIntent, CartSnapshot } from "../src/commerce/executor";
import { AmcCommerceService } from "../src/commerce/service";

const intent: CartCreateIntent = {
  showtimeId: "900000006",
  seats: [
    {
      name: "J3",
      sku: "TICKET-RS-900000006-ADULT",
      quantity: 1,
      row: 10,
      column: 21,
    },
  ],
  waiveSubscriptionDiscounts: false,
  expectedTotal: "31.98",
  holdAcknowledgement: "CREATE_HOLD",
};

const cart: CartSnapshot = {
  orderToken: "00000000-0000-4000-8000-000000000002",
  showtimeId: intent.showtimeId,
  seats: [{ name: "J3", sku: intent.seats[0]!.sku, row: 10, column: 21 }],
  tickets: [{ sku: intent.seats[0]!.sku, quantity: 1 }],
  total: "31.98",
  expiresAt: "2099-08-15T23:30:00.000Z",
  status: "OPEN",
};

class FakeService {
  createCart = async () => structuredClone(cart);
  previewCheckout = async ({
    orderToken,
  }: {
    orderToken: string;
    email: string;
  }) => ({
    kind: "checkout" as const,
    orderToken,
    showtimeId: cart.showtimeId,
    seats: structuredClone(cart.seats),
    tickets: structuredClone(cart.tickets),
    total: cart.total,
    expiresAt: cart.expiresAt,
    emailBinding: "email-binding",
    observedAt: "2030-01-15T23:00:00.000Z",
    confirmationToken: "checkout:token",
  });
  submitCheckout = async ({
    preview,
  }: {
    preview: { orderToken: string };
  }) => ({
    orderToken: preview.orderToken,
    confirmationNumber: "0000000004",
    chargedTotal: "31.98" as const,
    status: "CONFIRMED" as const,
    reconciled: false,
  });
  recoverCheckout = async () => ({
    kind: "cart" as const,
    cart: structuredClone(cart),
  });
}

describe("AMC checkout sessions", () => {
  it("owns the order token it creates and carries it through checkout", async () => {
    const service = new FakeService();
    const session = new AmcCheckoutSession(
      service as unknown as AmcCommerceService,
      "conversation-a",
    );

    const created = await session.createCart(intent);
    const preview = await session.previewCheckout({
      orderToken: created.orderToken,
      email: "guest@example.test",
    });
    await expect(
      session.submitCheckout({
        preview,
        confirmationToken: preview.confirmationToken,
        email: "guest@example.test",
        vaultPointer: "vault://test-card",
      }),
    ).resolves.toMatchObject({ confirmationNumber: "0000000004" });
  });

  it("refuses another checkout session order token", async () => {
    const service = new FakeService();
    const first = new AmcCheckoutSession(
      service as unknown as AmcCommerceService,
      "conversation-a",
    );
    const second = new AmcCheckoutSession(
      service as unknown as AmcCommerceService,
      "conversation-b",
    );
    const created = await first.createCart(intent);

    await expect(
      second.previewCheckout({
        orderToken: created.orderToken,
        email: "guest@example.test",
      }),
    ).rejects.toBeInstanceOf(CheckoutSessionOwnershipError);
  });

  it("adopts only a cart returned by its own recovery request", async () => {
    const service = new FakeService();
    const session = new AmcCheckoutSession(
      service as unknown as AmcCommerceService,
      "conversation-a",
    );

    const recovered = await session.recoverCheckout({
      showtimeId: intent.showtimeId,
      seatNames: ["J3"],
      email: "guest@example.test",
    });
    expect(recovered).toMatchObject({ kind: "cart" });
    await expect(
      session.previewCheckout({
        orderToken: cart.orderToken,
        email: "guest@example.test",
      }),
    ).resolves.toMatchObject({ orderToken: cart.orderToken });
  });
});
