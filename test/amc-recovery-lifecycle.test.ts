import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import {
  AmcCommerceService,
  CheckoutRecovery,
  CheckoutSettlingError,
} from "../src/commerce/service";
import { CartIntentStore } from "../src/commerce/cart-intent-store";
import { PendingWriteStore } from "../src/commerce/pending-write-store";
import { sha256 } from "../src/commerce/intent-identity";
import { AmcCommerceProjectionProvider } from "../src/commerce/graphql-executor";
import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  OrderLifecycle,
  PaymentExecutor,
  PurchaseResult,
  RefundOrderSnapshot,
} from "../src/commerce/executor";

const TOKEN = "00000000-0000-4000-8000-000000000042";
const NOW = new Date("2030-01-15T09:00:00.000Z");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-recovery-lifecycle-"));
  roots.push(root);
  return new FileSessionStore({ root: path.join(root, "s"), lockPollMs: 5 });
}

function recoveryOver(store: FileSessionStore): CheckoutRecovery {
  return {
    intents: new CartIntentStore(store),
    pending: new PendingWriteStore(store),
    store,
  };
}

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

function openCart(): CartSnapshot {
  return {
    orderToken: TOKEN,
    showtimeId: "146600823",
    seats: [
      { name: "A9", sku: "TICKET-RS-146600823-ADULT", row: 1, column: 9 },
    ],
    tickets: [{ sku: "TICKET-RS-146600823-ADULT", quantity: 1 }],
    total: "12.44",
    expiresAt: "2099-08-15T09:45:00.000Z",
    status: "OPEN",
  };
}

class FakeExecutor {
  createCalls = 0;
  deleteCalls = 0;
  async createCart(
    _intent: CartCreateIntent,
    onToken?: (orderToken: string) => Promise<void>,
  ): Promise<CartSnapshot> {
    this.createCalls += 1;
    await onToken?.(TOKEN);
    return openCart();
  }
  reconcileCart(): Promise<CartSnapshot | null> {
    return Promise.resolve(null);
  }
  async inspectCart(): Promise<CartSnapshot> {
    return openCart();
  }
  async deleteCart(): Promise<void> {
    this.deleteCalls += 1;
  }
  async reconcileRelease(): Promise<boolean> {
    return false;
  }
  async extendOrderExpiration(): Promise<{ expiresAt: string }> {
    return { expiresAt: openCart().expiresAt };
  }
  async searchOrder(): Promise<RefundOrderSnapshot> {
    throw new Error("not used");
  }
  async refund(): Promise<{ orderId: string }> {
    throw new Error("not used");
  }
}

class FakeProjections implements AmcCommerceProjectionProvider {
  lifecycle: OrderLifecycle = { kind: "open", cart: openCart() };
  assertReady(): void {}
  inspectCart(): Promise<CartSnapshot> {
    return Promise.resolve(openCart());
  }
  projectLifecycle(): Promise<OrderLifecycle> {
    return Promise.resolve(this.lifecycle);
  }
  reconcileCart(): Promise<CartSnapshot | null> {
    return Promise.resolve(null);
  }
  projectRefundOrder(): Promise<RefundOrderSnapshot> {
    return Promise.reject(new Error("not used"));
  }
  projectPurchase(): Promise<PurchaseResult> {
    return Promise.reject(new Error("not used"));
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.resolve(null);
  }
  projectExpiration(): Promise<{ expiresAt: string }> {
    return Promise.resolve({ expiresAt: openCart().expiresAt });
  }
  projectStatus(): Promise<"OPEN" | "FULFILLED" | "EXPIRED"> {
    return Promise.resolve("OPEN");
  }
}

class FakePayment implements PaymentExecutor {
  reconciledPurchase: PurchaseResult | null = null;
  secureFill(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  addCard(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  purchase(): Promise<PurchaseResult> {
    return Promise.reject(new AmbiguousWriteError("purchase"));
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.resolve(this.reconciledPurchase);
  }
}

function serviceWith(store: FileSessionStore) {
  const executor = new FakeExecutor();
  const projections = new FakeProjections();
  const payment = new FakePayment();
  const service = new AmcCommerceService({
    executor: executor as never,
    projections,
    payment,
    recovery: recoveryOver(store),
    now: () => NOW,
  });
  return { service, executor, projections, payment };
}

/** Seed a legacy journal PURCHASE_DISPATCHING record (A9 shape) for TOKEN. */
async function seedLegacyPurchaseDispatching(
  store: FileSessionStore,
  updatedAt: string,
): Promise<void> {
  const attemptId = "a".repeat(64);
  await store.save(
    { provider: "amc-checkout-order", account: sha256(TOKEN) },
    Buffer.from(JSON.stringify({ version: 1, attemptId }), "utf8"),
  );
  await store.save(
    { provider: "amc-checkout", account: attemptId },
    Buffer.from(
      JSON.stringify({
        version: 1,
        attemptId,
        state: "PURCHASE_DISPATCHING",
        intent: intent(),
        orderToken: TOKEN,
        updatedAt,
      }),
      "utf8",
    ),
  );
}

describe("provider-authoritative recovery lifecycle", () => {
  it("A9: legacy PURCHASE_DISPATCHING + provider open past the quiet window reconciles to null, clears the marker, and releases the SAME cart with no new cart", async () => {
    const store = await newStore();
    // Legacy dispatch an hour ago (well past the 60s quiet window).
    await seedLegacyPurchaseDispatching(store, "2030-01-15T08:00:00.000Z");
    const { service, executor } = serviceWith(store);

    const reconciled = await service.reconcileCheckoutByToken(
      TOKEN,
      "guest@example.test",
    );
    expect(reconciled).toBeNull();

    // The purchase marker was cleared, so the still-open cart can be released
    // with the SAME token and NO new cart mutation.
    await expect(service.releaseCart(TOKEN)).resolves.toEqual({
      released: true,
    });
    expect(executor.createCalls).toBe(0);
    expect(executor.deleteCalls).toBe(1);
  });

  it("reports settling (typed, never not-purchased) inside the quiet window and blocks release", async () => {
    const store = await newStore();
    // Legacy dispatch 20s ago (inside the 60s quiet window).
    await seedLegacyPurchaseDispatching(store, "2030-01-15T08:59:40.000Z");
    const { service, executor } = serviceWith(store);

    await expect(
      service.reconcileCheckoutByToken(TOKEN, "guest@example.test"),
    ).rejects.toBeInstanceOf(CheckoutSettlingError);
    await expect(service.releaseCart(TOKEN)).rejects.toBeInstanceOf(
      CheckoutSettlingError,
    );
    expect(executor.deleteCalls).toBe(0);
  });

  it("reconciles a genuinely purchased order to a confirmed result and clears the marker", async () => {
    const store = await newStore();
    await seedLegacyPurchaseDispatching(store, "2030-01-15T08:00:00.000Z");
    const { service, projections } = serviceWith(store);
    projections.lifecycle = {
      kind: "purchased",
      purchase: {
        orderToken: TOKEN,
        confirmationNumber: "0000000001",
        chargedTotal: "12.44",
        status: "CONFIRMED",
      },
    };

    const reconciled = await service.reconcileCheckoutByToken(
      TOKEN,
      "guest@example.test",
    );
    expect(reconciled).toMatchObject({
      confirmationNumber: "0000000001",
      reconciled: true,
    });
    // A purchased order cannot be released.
    await expect(service.releaseCart(TOKEN)).rejects.toThrow(/purchased/);
  });

  it("does not create a duplicate cart when an open hold already exists for the selection", async () => {
    const store = await newStore();
    const { service, executor } = serviceWith(store);

    const first = await service.createCart(intent());
    expect(first.orderToken).toBe(TOKEN);
    expect(executor.createCalls).toBe(1);

    // A second create for the same selection recovers the open cart instead of
    // dispatching another CartCreateOrder.
    const second = await service.createCart(intent());
    expect(second.orderToken).toBe(TOKEN);
    expect(executor.createCalls).toBe(1);
  });
});
