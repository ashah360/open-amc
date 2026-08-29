export type Money = `${number}.${number}`;

export interface CartSeatIntent {
  name: string;
  sku: string;
  quantity: number;
  row: number;
  column: number;
}

export interface CartCreateIntent {
  showtimeId: string;
  seats: CartSeatIntent[];
  waiveSubscriptionDiscounts: boolean;
  /**
   * Pre-cart seat-map ESTIMATE only. AMC's authoritative total is the one on
   * the created cart (`CartSnapshot.total`), which can differ by theater (fee /
   * tax schedules); cart creation does not require this to match. Checkout
   * submit consents to the authoritative current cart total from a fresh
   * preview.
   */
  expectedTotal: Money;
  holdAcknowledgement: "CREATE_HOLD";
}

export interface CartSnapshot {
  orderToken: string;
  showtimeId: string;
  seats: Array<Omit<CartSeatIntent, "quantity">>;
  tickets: Array<{ sku: string; quantity: number }>;
  total: Money;
  expiresAt: string;
  status: "OPEN" | "FULFILLED" | "EXPIRED";
}

export interface RefundLineSnapshot {
  lineNumber: string;
  label: string;
  refundableAmount: Money;
  status: "PAID" | "REFUND_REQUESTED" | "REFUNDED";
}

export interface RefundOrderSnapshot {
  orderNumber: string;
  orderToken: string;
  status: "CONFIRMED" | "REFUND_REQUESTED" | "REFUNDED";
  chargedTotal: Money;
  nonRefundableFee: Money;
  lines: RefundLineSnapshot[];
}

export interface CommerceExecutor {
  /** First inventory mutation. Implementations must dispatch at most once. */
  createCart(
    intent: CartCreateIntent,
    onToken?: (orderToken: string) => Promise<void>,
  ): Promise<CartSnapshot>;
  /** Read-only reconciliation after an ambiguous CartCreateOrder outcome. */
  reconcileCart(intent: CartCreateIntent): Promise<CartSnapshot | null>;
  /** Fresh browser-backed cart/order projection; no captured direct replay is claimed. */
  inspectCart(
    orderToken: string,
    email: string,
    intent?: CartCreateIntent,
  ): Promise<CartSnapshot>;
  /** Consequential OrderDelete mutation. Implementations must dispatch at most once. */
  deleteCart(orderToken: string): Promise<void>;
  /**
   * Read-only authoritative check of whether an order is already released
   * (cancelled/expired). Used to reconcile an ambiguous OrderDelete without
   * redispatching. Returns false when the order is still open or fulfilled.
   */
  reconcileRelease(orderToken: string): Promise<boolean>;
  /**
   * Extend an open order's expiration (OrderExpirationUpdate). Monotonic and
   * self-reconciling: implementations dispatch at most once and, on an ambiguous
   * transport failure, re-read the current expiry rather than redispatching.
   */
  extendOrderExpiration(orderToken: string): Promise<{ expiresAt: string }>;
  /** Browser-backed OrderSearch plus refund consequence projection. */
  searchOrder(orderNumber: string, email: string): Promise<RefundOrderSnapshot>;
  /** Consequential OrderRefund mutation. Implementations must dispatch at most once. */
  refund(input: {
    token: string;
    lineNumbers: string[];
  }): Promise<{ orderId: string }>;
}

export interface EphemeralPaymentHandle {
  readonly opaque: symbol;
}

export interface EphemeralCardHandle {
  readonly opaque: symbol;
}

export class PurchaseNotCompletedError extends Error {
  readonly code = "AMC_PURCHASE_NOT_COMPLETED";
  constructor(
    readonly providerStatus: "Expired" | "Cancelled" | "Declined",
    readonly providerCode?: number,
  ) {
    super(
      `AMC order was not purchased (${providerStatus}${
        providerCode === undefined ? "" : `:${providerCode}`
      })`,
    );
  }
}

export interface PurchaseResult {
  orderToken: string;
  confirmationNumber: string;
  chargedTotal: Money;
  status: "CONFIRMED";
}

export interface PaymentExecutor {
  /**
   * One secure-fill browser transaction. Card fields remain in hosted frames;
   * only an in-memory opaque handle crosses this interface.
   */
  secureFill(input: {
    orderToken: string;
    vaultPointer: string;
  }): Promise<EphemeralPaymentHandle>;

  /** A separate explicit Add Card browser transaction. */
  addCard(input: {
    orderToken: string;
    payment: EphemeralPaymentHandle;
  }): Promise<EphemeralCardHandle>;

  /**
   * A separate Purchase browser transaction. Nonce/deviceData never cross this
   * boundary and the method returns only the typed confirmation projection.
   */
  purchase(input: {
    orderToken: string;
    email: string;
    expectedTotal: Money;
    card: EphemeralCardHandle;
  }): Promise<PurchaseResult>;

  /** Read-only provider-state reconciliation after an ambiguous purchase. */
  reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null>;
}

export class AmbiguousWriteError extends Error {
  readonly code = "AMC_WRITE_OUTCOME_UNKNOWN";
  constructor(
    readonly operation:
      "cart" | "purchase" | "refund" | "release" | "expiration",
  ) {
    super(`AMC ${operation} outcome is ambiguous`);
  }
}

export class PaymentSecurityChallengeError extends Error {
  readonly code = "AMC_PAYMENT_SECURITY_CHALLENGE";
  constructor(readonly challengeContext?: { readonly opaque: symbol }) {
    super("AMC payment requires an interactive security challenge");
  }
}

export class CommerceExecutionUnavailableError extends Error {
  readonly code = "AMC_COMMERCE_EXECUTION_UNAVAILABLE";
  constructor() {
    super("AMC browser-backed commerce execution is not configured");
  }
}

/**
 * Raised when an operation needs an explicitly-injected capability that was not
 * configured (for example, submitting checkout without a card provider, or a
 * 3DS/hosted-frame challenge without an interactive challenge handler).
 */
export class AmcCapabilityUnavailableError extends Error {
  readonly code = "AMC_CAPABILITY_UNAVAILABLE";
  constructor(
    readonly capability: "payment" | "session-repair" | "browser" | "challenge",
  ) {
    super(`AMC ${capability} capability is not configured`);
  }
}

/** PaymentExecutor placeholder used when no card provider is wired. */
export class PaymentCapabilityUnavailableExecutor implements PaymentExecutor {
  secureFill(): Promise<EphemeralPaymentHandle> {
    return Promise.reject(new AmcCapabilityUnavailableError("payment"));
  }
  addCard(): Promise<EphemeralCardHandle> {
    return Promise.reject(new AmcCapabilityUnavailableError("payment"));
  }
  purchase(): Promise<PurchaseResult> {
    return Promise.reject(new AmcCapabilityUnavailableError("payment"));
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.reject(new AmcCapabilityUnavailableError("payment"));
  }
}

export class UnavailableCommerceExecutor implements CommerceExecutor {
  createCart(): Promise<CartSnapshot> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  reconcileCart(): Promise<CartSnapshot | null> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  inspectCart(): Promise<CartSnapshot> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  deleteCart(): Promise<void> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  reconcileRelease(): Promise<boolean> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  extendOrderExpiration(): Promise<{ expiresAt: string }> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  searchOrder(): Promise<RefundOrderSnapshot> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  refund(): Promise<{ orderId: string }> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
}

export class UnavailablePaymentExecutor implements PaymentExecutor {
  secureFill(): Promise<EphemeralPaymentHandle> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  addCard(): Promise<EphemeralCardHandle> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  purchase(): Promise<PurchaseResult> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.reject(new CommerceExecutionUnavailableError());
  }
}
