import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  CommerceExecutor,
  EphemeralCardHandle,
  EphemeralPaymentHandle,
  Money,
  PaymentExecutor,
  PaymentSecurityChallengeError,
  PurchaseResult,
  RefundOrderSnapshot,
} from "./executor";

export class BrowserCommerceExecutionError extends Error {
  readonly code = "AMC_BROWSER_COMMERCE_FAILED";

  constructor(readonly operation: string) {
    super(`AMC browser commerce execution failed (${operation})`);
  }
}

/**
 * Trusted, in-process Aside bridge. Implementations own browser navigation and
 * DOM/GraphQL projection, and must classify uncertain writes with
 * AmbiguousWriteError. Raw helper output must never be returned or logged.
 */
export interface AsideCommerceTransactionAdapter {
  createCart(intent: CartCreateIntent): Promise<CartSnapshot>;
  reconcileCart(intent: CartCreateIntent): Promise<CartSnapshot | null>;
  inspectCart(orderToken: string, email: string): Promise<CartSnapshot>;
  deleteCart(orderToken: string): Promise<void>;
  reconcileRelease(orderToken: string): Promise<boolean>;
  extendOrderExpiration(orderToken: string): Promise<{ expiresAt: string }>;
  searchOrder(orderNumber: string, email: string): Promise<RefundOrderSnapshot>;
  refund(input: {
    token: string;
    lineNumbers: string[];
  }): Promise<{ orderId: string }>;
}

/**
 * Thin fail-closed boundary around the trusted Aside bridge. It deliberately
 * performs no retry; service-level reconciliation is the only recovery path.
 */
export class AsideCommerceExecutor implements CommerceExecutor {
  constructor(private readonly adapter: AsideCommerceTransactionAdapter) {}

  async createCart(
    intent: CartCreateIntent,
    onToken?: (orderToken: string) => Promise<void>,
  ): Promise<CartSnapshot> {
    const cart = await this.invoke("cart-create", () =>
      this.adapter.createCart(clone(intent)),
    );
    await onToken?.(cart.orderToken);
    return cart;
  }

  reconcileCart(intent: CartCreateIntent): Promise<CartSnapshot | null> {
    return this.invoke("cart-reconcile", () =>
      this.adapter.reconcileCart(clone(intent)),
    );
  }

  inspectCart(orderToken: string, email: string): Promise<CartSnapshot> {
    return this.invoke("cart-inspect", () =>
      this.adapter.inspectCart(orderToken, email),
    );
  }

  deleteCart(orderToken: string): Promise<void> {
    return this.invoke("order-delete", () =>
      this.adapter.deleteCart(orderToken),
    );
  }

  reconcileRelease(orderToken: string): Promise<boolean> {
    return this.invoke("order-reconcile-release", () =>
      this.adapter.reconcileRelease(orderToken),
    );
  }

  extendOrderExpiration(orderToken: string): Promise<{ expiresAt: string }> {
    return this.invoke("order-extend-expiration", () =>
      this.adapter.extendOrderExpiration(orderToken),
    );
  }

  searchOrder(
    orderNumber: string,
    email: string,
  ): Promise<RefundOrderSnapshot> {
    return this.invoke("order-search", () =>
      this.adapter.searchOrder(orderNumber, email),
    );
  }

  refund(input: {
    token: string;
    lineNumbers: string[];
  }): Promise<{ orderId: string }> {
    return this.invoke("order-refund", () => this.adapter.refund(clone(input)));
  }

  private async invoke<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return clone(await action());
    } catch (error) {
      if (error instanceof AmbiguousWriteError) throw error;
      throw new BrowserCommerceExecutionError(operation);
    }
  }
}

/**
 * The secure-fill handle may internally reference hosted-frame state. A future
 * direct Braintree executor can instead keep nonce/deviceData in a private
 * WeakMap keyed by the same opaque handle, without changing the domain service.
 */
export interface AsidePaymentTransactionAdapter {
  secureFill(input: {
    orderToken: string;
    vaultPointer: string;
  }): Promise<EphemeralPaymentHandle>;
  addCard(input: {
    orderToken: string;
    payment: EphemeralPaymentHandle;
  }): Promise<EphemeralCardHandle>;
  purchase(input: {
    orderToken: string;
    email: string;
    expectedTotal: Money;
    card: EphemeralCardHandle;
  }): Promise<PurchaseResult>;
  reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null>;
}

export class AsidePaymentExecutor implements PaymentExecutor {
  constructor(private readonly adapter: AsidePaymentTransactionAdapter) {}

  secureFill(input: {
    orderToken: string;
    vaultPointer: string;
  }): Promise<EphemeralPaymentHandle> {
    return this.invoke("secure-fill", () => this.adapter.secureFill(input));
  }

  addCard(input: {
    orderToken: string;
    payment: EphemeralPaymentHandle;
  }): Promise<EphemeralCardHandle> {
    return this.invoke("add-card", () => this.adapter.addCard(input));
  }

  purchase(input: {
    orderToken: string;
    email: string;
    expectedTotal: Money;
    card: EphemeralCardHandle;
  }): Promise<PurchaseResult> {
    return this.invoke("purchase", () => this.adapter.purchase(input));
  }

  reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null> {
    return this.invoke("purchase-reconcile", () =>
      this.adapter.reconcilePurchase(orderToken, email),
    );
  }

  private async invoke<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (
        error instanceof AmbiguousWriteError ||
        error instanceof PaymentSecurityChallengeError
      ) {
        throw error;
      }
      throw new BrowserCommerceExecutionError(operation);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
