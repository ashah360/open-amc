import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import {
  AmcCheckoutSession,
  CheckoutSessionOwnershipError,
} from "../src/commerce/checkout-session";
import {
  ADD_CREDIT_CARD_MODAL_DOCUMENT,
  BRAINTREE_AUTHORIZATION_DOCUMENT,
  CART_CREATE_ORDER_DOCUMENT,
  ORDER_DELETE_DOCUMENT,
  ORDER_FULFILL_DOCUMENT,
  ORDER_REFUND_DOCUMENT,
  ORDER_SEARCH_DOCUMENT,
  buildAddCreditCardModalEnvelope,
  buildBraintreeAuthorizationEnvelope,
  buildCartCreateEnvelope,
  buildOrderDeleteEnvelope,
  buildOrderFulfillEnvelope,
  buildOrderRefundEnvelope,
  buildOrderSearchEnvelope,
  parseCartCreateResponse,
  parseOrderDeleteResponse,
  parseOrderSearchResponse,
} from "../src/commerce/contracts";
import {
  AsideCommerceExecutor,
  AsidePaymentExecutor,
  BrowserCommerceExecutionError,
} from "../src/commerce/browser-executor";
import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  CommerceExecutor,
  EphemeralCardHandle,
  EphemeralPaymentHandle,
  PaymentExecutor,
  PurchaseNotCompletedError,
  PurchaseResult,
  RefundOrderSnapshot,
} from "../src/commerce/executor";
import { OrderLifecycle } from "../src/commerce/executor";
import { AmcCommerceProjectionProvider } from "../src/commerce/graphql-executor";
import { CartIntentStore } from "../src/commerce/cart-intent-store";
import { PendingWriteStore } from "../src/commerce/pending-write-store";
import {
  AmcCommerceService,
  CartHoldWithoutSnapshotError,
  CheckoutRecovery,
  CheckoutSettlingError,
  ConfirmationMismatchError,
  ConsequenceMismatchError,
  SingleFlightError,
  UnknownWriteOutcomeError,
} from "../src/commerce/service";

const journalRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    journalRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("AMC captured GraphQL contracts", () => {
  it("preserves exact two-product seat array semantics and exact documents", () => {
    const products = [
      { sku: "TICKET-RS-900000005-ADULT", quantity: 1, column: 17, row: 9 },
      { sku: "TICKET-RS-900000005-ADULT", quantity: 1, column: 16, row: 9 },
    ];

    expect(
      buildCartCreateEnvelope({ products, waiveSubscriptionDiscounts: false }),
    ).toEqual({
      operationName: "CartCreateOrder",
      query: CART_CREATE_ORDER_DOCUMENT,
      variables: { input: { products, waiveSubscriptionDiscounts: false } },
    });
    expect(
      buildOrderRefundEnvelope({
        token: "order-token",
        lineNumbers: ["1", "2"],
      }),
    ).toEqual({
      operationName: "OrderRefund",
      query: ORDER_REFUND_DOCUMENT,
      variables: {
        refundInput: { token: "order-token", lineNumbers: ["1", "2"] },
      },
    });
    expect(buildOrderDeleteEnvelope("order-token")).toEqual({
      operationName: "OrderDelete",
      query: ORDER_DELETE_DOCUMENT,
      variables: { input: { token: "order-token" } },
    });
    expect(
      parseOrderDeleteResponse({ data: { orderDelete: { success: true } } }),
    ).toEqual({
      success: true,
    });
    expect([
      BRAINTREE_AUTHORIZATION_DOCUMENT,
      ADD_CREDIT_CARD_MODAL_DOCUMENT,
      ORDER_FULFILL_DOCUMENT,
      ORDER_SEARCH_DOCUMENT,
    ]).toEqual([
      expect.stringContaining("query BraintreeAuthorization"),
      expect.stringContaining("query AddCreditCardModal"),
      expect.stringContaining("mutation OrderFulfill"),
      expect.stringContaining(
        "query OrderSearch($orderNumber: String!, $email: String!)",
      ),
    ]);
  });

  it("keeps leading-zero order numbers and rejects drifted OrderSearch responses", () => {
    expect(
      buildOrderSearchEnvelope({
        orderNumber: "0000000001",
        email: "guest@example.test",
      }).variables.orderNumber,
    ).toBe("0000000001");
    expect(
      parseOrderSearchResponse({
        data: {
          viewer: {
            order: { accountId: null, error: null, token: "order-token" },
          },
        },
      }),
    ).toEqual({ accountId: null, error: null, token: "order-token" });
    expect(() =>
      parseOrderSearchResponse({
        data: {
          viewer: { order: { accountId: null, error: null, token: 123 } },
        },
      }),
    ).toThrow(/OrderSearch response drifted/);
  });

  it("builds captured payment envelopes and rejects GraphQL error envelopes", () => {
    expect(buildBraintreeAuthorizationEnvelope()).toEqual({
      operationName: "BraintreeAuthorization",
      query: BRAINTREE_AUTHORIZATION_DOCUMENT,
    });
    expect(buildAddCreditCardModalEnvelope()).toEqual({
      operationName: "AddCreditCardModal",
      query: ADD_CREDIT_CARD_MODAL_DOCUMENT,
    });
    expect(
      buildOrderFulfillEnvelope({
        token: "order-token",
        email: "guest@example.test",
        nonce: "test-nonce-not-captured",
        deviceData: '{"correlation_id":"test-only"}',
        paymentMethodType: "creditCard",
        postalCode: "00000",
      }),
    ).toEqual({
      operationName: "OrderFulfill",
      query: ORDER_FULFILL_DOCUMENT,
      variables: {
        input: {
          token: "order-token",
          email: "guest@example.test",
          paymentMethodType: "creditCard",
          nonce: "test-nonce-not-captured",
          deviceData: '{"correlation_id":"test-only"}',
          postalCode: "00000",
        },
      },
    });
    expect(() =>
      parseCartCreateResponse({
        data: { orderCreate: { order: { token: "must-not-be-accepted" } } },
        errors: [{ message: "provider rejected mutation" }],
      }),
    ).toThrow(/GraphQL errors/);
  });
});

describe("AMC consequential commerce lifecycle", () => {
  it("runs checkout readiness before the first inventory mutation", async () => {
    const executor = new FakeCommerceExecutor();
    const service = new AmcCommerceService({
      executor,
      projections: new FakeProjectionProvider(),
      payment: new FakePaymentExecutor(),
      readiness: {
        assertReady: () =>
          Promise.reject(new Error("risk context unavailable")),
      },
      now: () => new Date("2030-01-15T08:30:00.000Z"),
    });

    await expect(service.createCart(createIntent())).rejects.toThrow(
      "risk context unavailable",
    );
    expect(executor.createCalls).toBe(0);
  });

  it("accepts the authoritative provider cart total when it differs from the pre-cart estimate", async () => {
    // Reproduced River East 21: the pre-cart seat-map estimate (56.04) differs
    // from AMC's authoritative created-cart total (51.93) by theater. The exact
    // valid cart (same showtime, seats, SKU/quantity, open) must succeed and
    // return the provider total, not be stranded on a total mismatch.
    const executor = new FakeCommerceExecutor();
    const service = serviceWith(executor);
    executor.cart.total = "51.93";
    const intent = { ...createIntent(), expectedTotal: "56.04" as const };

    await expect(service.createCart(intent)).resolves.toMatchObject({
      orderToken: executor.cart.orderToken,
      showtimeId: "900000005",
      status: "OPEN",
      total: "51.93",
    });
    expect(executor.createCalls).toBe(1);
  });

  it("still fails closed (token surfaced) on an expired created cart", async () => {
    const executor = new FakeCommerceExecutor();
    const service = serviceWith(executor);
    executor.cart.expiresAt = "2030-01-15T08:29:00.000Z";
    const expired = await service
      .createCart(createIntent())
      .catch((error: unknown) => error);
    expect(expired).toBeInstanceOf(CartHoldWithoutSnapshotError);
    expect(expired).toMatchObject({
      reconciliation: { orderToken: executor.cart.orderToken },
    });
    expect(executor.createCalls).toBe(1);
  });

  it("requires checkout confirmation binding and enforces single-flight per order", async () => {
    const executor = new FakeCommerceExecutor();
    const payment = new FakePaymentExecutor();
    const service = serviceWith(executor, payment);
    const preview = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });

    await expect(
      service.submitCheckout({
        preview,
        confirmationToken: "checkout:wrong",
        email: "guest@example.test",
        vaultPointer: "vault://test-card",
      }),
    ).rejects.toBeInstanceOf(ConfirmationMismatchError);

    payment.blockPurchase = true;
    const first = service.submitCheckout({
      preview,
      confirmationToken: preview.confirmationToken,
      email: "guest@example.test",
      vaultPointer: "vault://test-card",
    });
    await payment.purchaseStarted;
    await expect(
      service.submitCheckout({
        preview,
        confirmationToken: preview.confirmationToken,
        email: "guest@example.test",
        vaultPointer: "vault://test-card",
      }),
    ).rejects.toBeInstanceOf(SingleFlightError);
    payment.releasePurchase();

    await expect(first).resolves.toMatchObject({
      confirmationNumber: "0000000001",
      chargedTotal: "55.56",
    });
    expect(payment.secureFillCalls).toBe(1);
    expect(payment.addCardCalls).toBe(1);
    expect(payment.purchaseCalls).toBe(1);
    expect(executor.inspectCalls).toBe(3);
  });

  it("reconciles an ambiguous purchase without retrying the write", async () => {
    const executor = new FakeCommerceExecutor();
    const payment = new FakePaymentExecutor();
    payment.purchaseError = new AmbiguousWriteError("purchase");
    payment.reconciledPurchase = {
      orderToken: executor.cart.orderToken,
      confirmationNumber: "0000000001",
      chargedTotal: "55.56",
      status: "CONFIRMED",
    };
    const service = serviceWith(executor, payment);
    const preview = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });

    const result = await service.submitCheckout({
      preview,
      confirmationToken: preview.confirmationToken,
      email: "guest@example.test",
      vaultPointer: "vault://test-card",
    });

    expect(result.reconciled).toBe(true);
    expect(payment.purchaseCalls).toBe(1);
    expect(payment.reconcileCalls).toBe(1);
  });

  it("reconciles a direct challenge to a confirmed purchase without browser calls", async () => {
    const executor = new FakeCommerceExecutor();
    const direct = new FakePaymentExecutor();
    const challenge = new FakePaymentExecutor();
    direct.reconciledPurchase = {
      orderToken: executor.cart.orderToken,
      confirmationNumber: "0000000001",
      chargedTotal: "55.56",
      status: "CONFIRMED",
    };
    const service = serviceWith(executor, direct, challenge);
    const preview = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });

    await expect(
      service.previewCheckoutChallenge({
        checkoutPreview: preview,
        email: "guest@example.test",
      }),
    ).resolves.toMatchObject({
      kind: "confirmed",
      confirmationNumber: "0000000001",
      reconciled: true,
    });
    expect(challenge.secureFillCalls).toBe(0);
    expect(executor.inspectCalls).toBe(1);
  });

  it("rejects challenge continuation when reconciliation is absent and cart changed", async () => {
    const executor = new FakeCommerceExecutor();
    const direct = new FakePaymentExecutor();
    const challenge = new FakePaymentExecutor();
    const service = serviceWith(executor, direct, challenge);
    const preview = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });
    executor.cart.total = "55.57";

    await expect(
      service.previewCheckoutChallenge({
        checkoutPreview: preview,
        email: "guest@example.test",
      }),
    ).rejects.toBeInstanceOf(ConsequenceMismatchError);
    expect(challenge.secureFillCalls).toBe(0);
  });

  it("rejects challenge continuation when the cart expired during handoff", async () => {
    const executor = new FakeCommerceExecutor();
    const direct = new FakePaymentExecutor();
    const challenge = new FakePaymentExecutor();
    const service = serviceWith(executor, direct, challenge);
    const preview = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });
    executor.cart.expiresAt = "2030-01-15T08:29:00.000Z";

    await expect(
      service.previewCheckoutChallenge({
        checkoutPreview: preview,
        email: "guest@example.test",
      }),
    ).rejects.toThrow(/expired/);
    expect(challenge.secureFillCalls).toBe(0);
  });

  it("returns only a new challenge preview for an unchanged fresh cart", async () => {
    const executor = new FakeCommerceExecutor();
    const direct = new FakePaymentExecutor();
    const challenge = new FakePaymentExecutor();
    const service = serviceWith(executor, direct, challenge);
    const preview = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });

    const resumed = await service.previewCheckoutChallenge({
      checkoutPreview: preview,
      email: "guest@example.test",
    });

    expect(resumed).toMatchObject({
      kind: "checkout-challenge",
      orderToken: executor.cart.orderToken,
      total: "55.56",
      confirmationToken: expect.stringMatching(/^checkout-challenge:/),
    });
    expect(challenge.secureFillCalls).toBe(0);
    expect(challenge.purchaseCalls).toBe(0);
  });

  it("rereads immediately before one explicitly confirmed challenge purchase", async () => {
    const executor = new FakeCommerceExecutor();
    const direct = new FakePaymentExecutor();
    const challenge = new FakePaymentExecutor();
    const service = serviceWith(executor, direct, challenge);
    const checkout = await service.previewCheckout({
      orderToken: executor.cart.orderToken,
      email: "guest@example.test",
    });
    const preview = await service.previewCheckoutChallenge({
      checkoutPreview: checkout,
      email: "guest@example.test",
    });
    if (preview.kind !== "checkout-challenge")
      throw new Error("expected challenge preview");

    await expect(
      service.submitCheckoutChallenge({
        preview,
        confirmationToken: preview.confirmationToken,
        email: "guest@example.test",
        vaultPointer: "vault://test-card",
      }),
    ).resolves.toMatchObject({
      confirmationNumber: "0000000001",
      reconciled: false,
    });
    expect(challenge.secureFillCalls).toBe(1);
    expect(challenge.addCardCalls).toBe(1);
    expect(challenge.purchaseCalls).toBe(1);
    expect(executor.inspectCalls).toBe(4);
  });

  it("shows full and partial refund consequences without claiming the fee is refundable", async () => {
    const executor = new FakeCommerceExecutor();
    const service = serviceWith(executor);

    const full = await service.previewRefund({
      orderNumber: "0000000001",
      email: "guest@example.test",
      lineNumbers: ["1", "2"],
    });
    const partial = await service.previewRefund({
      orderNumber: "0000000001",
      email: "guest@example.test",
      lineNumbers: ["1"],
    });

    expect(full).toMatchObject({
      scope: "full",
      refundTotal: "49.58",
      nonRefundableFee: "5.98",
      chargedTotal: "55.56",
      remainingRefundableTotal: "0.00",
    });
    expect(partial).toMatchObject({
      scope: "partial",
      refundTotal: "24.79",
      nonRefundableFee: "5.98",
      remainingRefundableTotal: "24.79",
    });
  });

  it("binds refund confirmation and reconciles an unknown outcome without retry", async () => {
    const executor = new FakeCommerceExecutor();
    const service = serviceWith(executor);
    const preview = await service.previewRefund({
      orderNumber: "0000000001",
      email: "guest@example.test",
      lineNumbers: ["1", "2"],
    });

    await expect(
      service.submitRefund({
        preview,
        confirmationToken: "refund:wrong",
        email: "guest@example.test",
      }),
    ).rejects.toBeInstanceOf(ConfirmationMismatchError);

    executor.refundError = new AmbiguousWriteError("refund");
    executor.searchResults.push(refundableOrder(), refundedOrder());
    const result = await service.submitRefund({
      preview,
      confirmationToken: preview.confirmationToken,
      email: "guest@example.test",
    });

    expect(result).toMatchObject({
      status: "REFUND_REQUESTED",
      refundTotal: "49.58",
      nonRefundableFee: "5.98",
      reconciled: true,
    });
    expect(executor.refundCalls).toBe(1);
  });

  it("binds prepared payment material when ambiguous cart creation reconciles to a token", async () => {
    const executor = new FakeCommerceExecutor();
    executor.createError = new AmbiguousWriteError("cart");
    executor.reconciledCart = structuredClone(executor.cart);
    const bindings: Array<{ binding: string; orderToken: string }> = [];
    const service = new AmcCommerceService({
      executor,
      projections: new FakeProjectionProvider(),
      payment: new FakePaymentExecutor(),
      readiness: {
        assertReady: async () => undefined,
        bind: async (binding, orderToken) => {
          bindings.push({ binding, orderToken });
        },
      },
      now: () => new Date("2030-01-15T08:30:00.000Z"),
    });

    await expect(service.createCart(createIntent())).resolves.toMatchObject({
      orderToken: executor.cart.orderToken,
    });
    expect(bindings).toEqual([
      { binding: expect.any(String), orderToken: executor.cart.orderToken },
    ]);
  });

  it("never retries CartCreateOrder after an ambiguous outcome", async () => {
    const executor = new FakeCommerceExecutor();
    executor.createError = new AmbiguousWriteError("cart");
    executor.reconciledCart = null;
    const service = serviceWith(executor);

    await expect(service.createCart(createIntent())).rejects.toBeInstanceOf(
      UnknownWriteOutcomeError,
    );
    expect(executor.createCalls).toBe(1);
    expect(executor.reconcileCartCalls).toBe(1);
  });

  it("fails closed when the refund postcondition is not observed", async () => {
    const executor = new FakeCommerceExecutor();
    const service = serviceWith(executor);
    const preview = await service.previewRefund({
      orderNumber: "0000000001",
      email: "guest@example.test",
      lineNumbers: ["1", "2"],
    });
    executor.searchResults.push(refundableOrder(), refundableOrder());

    await expect(
      service.submitRefund({
        preview,
        confirmationToken: preview.confirmationToken,
        email: "guest@example.test",
      }),
    ).rejects.toThrow(/refund request was not observed/);
    expect(executor.refundCalls).toBe(1);
  });

  it("uses the fresh OrderSearch token rather than false cart lineage", async () => {
    const executor = new FakeCommerceExecutor();
    const service = serviceWith(executor);
    const initial = refundableOrder();
    initial.orderToken = "fresh-search-token";
    const current = refundableOrder();
    current.orderToken = "fresh-search-token";
    const after = refundedOrder();
    after.orderToken = "fresh-search-token";
    executor.searchResults.push(initial, current, after);
    const preview = await service.previewRefund({
      orderNumber: "0000000001",
      email: "guest@example.test",
      lineNumbers: ["1", "2"],
    });

    await service.submitRefund({
      preview,
      confirmationToken: preview.confirmationToken,
      email: "guest@example.test",
    });

    expect(executor.lastRefundInput?.token).toBe("fresh-search-token");
  });
});

describe("AMC browser-backed execution boundaries", () => {
  it("preserves classified ambiguity but redacts unknown helper failures", async () => {
    const commerce = new AsideCommerceExecutor({
      createCart: async () => {
        throw new AmbiguousWriteError("cart");
      },
      reconcileCart: async () => null,
      inspectCart: async () => {
        throw new Error("helper leaked secret-cookie-value");
      },
      deleteCart: async () => undefined,
      reconcileRelease: async () => false,
      extendOrderExpiration: async () => ({
        expiresAt: "2030-01-15T09:00:00.000Z",
      }),
      searchOrder: async () => refundableOrder(),
      refund: async () => ({ orderId: "order-token" }),
    });

    await expect(commerce.createCart(createIntent())).rejects.toBeInstanceOf(
      AmbiguousWriteError,
    );
    const failure = await commerce
      .inspectCart("order-token", "guest@example.test")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BrowserCommerceExecutionError);
    expect(String(failure)).not.toContain("secret-cookie-value");
  });

  it("keeps secure-fill, Add Card, and purchase as separate in-process transactions", async () => {
    const calls: string[] = [];
    const payment = new AsidePaymentExecutor({
      secureFill: async () => {
        calls.push("secure-fill");
        return { opaque: Symbol("payment") };
      },
      addCard: async () => {
        calls.push("add-card");
        return { opaque: Symbol("card") };
      },
      purchase: async (input) => {
        calls.push("purchase");
        return {
          orderToken: input.orderToken,
          confirmationNumber: "0000000001",
          chargedTotal: input.expectedTotal,
          status: "CONFIRMED",
        };
      },
      reconcilePurchase: async () => null,
    });
    const secure = await payment.secureFill({
      orderToken: "order-token",
      vaultPointer: "vault://private-card",
    });
    const card = await payment.addCard({
      orderToken: "order-token",
      payment: secure,
    });
    await payment.purchase({
      orderToken: "order-token",
      email: "guest@example.test",
      expectedTotal: "55.56",
      card,
    });

    expect(calls).toEqual(["secure-fill", "add-card", "purchase"]);
  });
});

class FakeCommerceExecutor implements CommerceExecutor {
  createCalls = 0;
  inspectCalls = 0;
  refundCalls = 0;
  deleteCalls = 0;
  reconcileCartCalls = 0;
  createError: Error | null = null;
  deleteError: Error | null = null;
  reportTokenBeforeError = false;
  refundError: Error | null = null;
  lastRefundInput: { token: string; lineNumbers: string[] } | null = null;
  reconciledCart: CartSnapshot | null = null;
  searchResults: Array<RefundOrderSnapshot | Error> = [];
  cart: CartSnapshot = {
    orderToken: "00000000-0000-4000-8000-000000000003",
    showtimeId: "900000005",
    seats: [
      { name: "H7", sku: "TICKET-RS-900000005-ADULT", row: 9, column: 17 },
      { name: "H8", sku: "TICKET-RS-900000005-ADULT", row: 9, column: 16 },
    ],
    tickets: [{ sku: "TICKET-RS-900000005-ADULT", quantity: 2 }],
    total: "55.56",
    expiresAt: "2030-01-15T08:45:00.000Z",
    status: "OPEN",
  };

  async createCart(
    _intent: CartCreateIntent,
    onToken?: (orderToken: string) => Promise<void>,
  ): Promise<CartSnapshot> {
    this.createCalls += 1;
    if (this.reportTokenBeforeError) await onToken?.(this.cart.orderToken);
    if (this.createError) throw this.createError;
    if (!this.reportTokenBeforeError) await onToken?.(this.cart.orderToken);
    return structuredClone(this.cart);
  }

  async reconcileCart(_intent: CartCreateIntent): Promise<CartSnapshot | null> {
    this.reconcileCartCalls += 1;
    return this.reconciledCart ? structuredClone(this.reconciledCart) : null;
  }

  async inspectCart(
    _orderToken: string,
    _email: string,
  ): Promise<CartSnapshot> {
    this.inspectCalls += 1;
    return structuredClone(this.cart);
  }

  async searchOrder(
    _orderNumber: string,
    _email: string,
  ): Promise<RefundOrderSnapshot> {
    const result = this.searchResults.shift() ?? refundableOrder();
    if (result instanceof Error) throw result;
    return structuredClone(result);
  }

  async deleteCart(_orderToken: string): Promise<void> {
    this.deleteCalls += 1;
    if (this.deleteError) throw this.deleteError;
  }

  reconcileReleaseResult = false;
  async reconcileRelease(_orderToken: string): Promise<boolean> {
    return this.reconcileReleaseResult;
  }

  async extendOrderExpiration(
    _orderToken: string,
  ): Promise<{ expiresAt: string }> {
    return { expiresAt: this.cart.expiresAt };
  }

  async refund(_input: {
    token: string;
    lineNumbers: string[];
  }): Promise<{ orderId: string }> {
    this.refundCalls += 1;
    this.lastRefundInput = structuredClone(_input);
    if (this.refundError) throw this.refundError;
    return { orderId: this.cart.orderToken };
  }
}

class FakePaymentExecutor implements PaymentExecutor {
  secureFillCalls = 0;
  addCardCalls = 0;
  purchaseCalls = 0;
  reconcileCalls = 0;
  purchaseError: Error | null = null;
  reconcileError: Error | null = null;
  reconciledPurchase: PurchaseResult | null = null;
  blockPurchase = false;
  private markPurchaseStarted!: () => void;
  private release!: () => void;
  private readonly purchaseRelease = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  readonly purchaseStarted = new Promise<void>((resolve) => {
    this.markPurchaseStarted = resolve;
  });

  async secureFill(): Promise<EphemeralPaymentHandle> {
    this.secureFillCalls += 1;
    return { opaque: Symbol("payment") };
  }

  async addCard(): Promise<EphemeralCardHandle> {
    this.addCardCalls += 1;
    return { opaque: Symbol("card") };
  }

  async purchase(input: { orderToken: string }): Promise<PurchaseResult> {
    this.purchaseCalls += 1;
    if (this.blockPurchase) {
      this.markPurchaseStarted();
      await this.purchaseRelease;
    }
    if (this.purchaseError) throw this.purchaseError;
    return {
      orderToken: input.orderToken,
      confirmationNumber: "0000000001",
      chargedTotal: "55.56",
      status: "CONFIRMED",
    };
  }

  reconcilePurchase(): Promise<PurchaseResult | null> {
    this.reconcileCalls += 1;
    if (this.reconcileError) return Promise.reject(this.reconcileError);
    return Promise.resolve(this.reconciledPurchase);
  }

  releasePurchase(): void {
    this.release();
  }
}

class FakeProjectionProvider implements AmcCommerceProjectionProvider {
  lifecycle: OrderLifecycle = { kind: "open" };
  assertReady(): void {}
  inspectCart(): Promise<CartSnapshot> {
    return Promise.reject(new Error("not used"));
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
    return Promise.resolve({ expiresAt: "2030-01-15T08:45:00.000Z" });
  }
  projectStatus(): Promise<"OPEN" | "FULFILLED" | "EXPIRED"> {
    return Promise.resolve("OPEN");
  }
}

function serviceWith(
  executor: CommerceExecutor,
  payment: PaymentExecutor = new FakePaymentExecutor(),
  challengePayment?: PaymentExecutor,
): AmcCommerceService {
  return new AmcCommerceService({
    executor,
    projections: new FakeProjectionProvider(),
    payment,
    ...(challengePayment ? { challengePayment } : {}),
    now: () => new Date("2030-01-15T08:30:00.000Z"),
  });
}

/** In-memory recovery bundle for behavioral recovery tests. */
function memoryRecovery(store: FileSessionStore): CheckoutRecovery {
  return {
    intents: new CartIntentStore(store),
    pending: new PendingWriteStore(store),
    store,
  };
}

function createIntent(): CartCreateIntent {
  return {
    showtimeId: "900000005",
    seats: [
      {
        name: "H7",
        sku: "TICKET-RS-900000005-ADULT",
        quantity: 1,
        row: 9,
        column: 17,
      },
      {
        name: "H8",
        sku: "TICKET-RS-900000005-ADULT",
        quantity: 1,
        row: 9,
        column: 16,
      },
    ],
    waiveSubscriptionDiscounts: false,
    expectedTotal: "55.56",
    holdAcknowledgement: "CREATE_HOLD",
  };
}

function refundableOrder(): RefundOrderSnapshot {
  return {
    orderNumber: "0000000001",
    orderToken: "00000000-0000-4000-8000-000000000003",
    status: "CONFIRMED",
    chargedTotal: "55.56",
    nonRefundableFee: "5.98",
    lines: [
      {
        lineNumber: "1",
        label: "Adult H7",
        refundableAmount: "24.79",
        status: "PAID",
      },
      {
        lineNumber: "2",
        label: "Adult H8",
        refundableAmount: "24.79",
        status: "PAID",
      },
    ],
  };
}

function refundedOrder(): RefundOrderSnapshot {
  const order = refundableOrder();
  order.status = "REFUND_REQUESTED";
  order.lines = order.lines.map((line) => ({
    ...line,
    status: "REFUND_REQUESTED",
  }));
  return order;
}
