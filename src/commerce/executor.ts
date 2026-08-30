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

/**
 * The provider order's current lifecycle, decided from ONE fresh projection
 * (the sole source of truth): `open` (Pending+unpaid+unexpired; cart included
 * when intent supplied), `purchased` (Fulfilled/Confirmed), `closed-unpaid`
 * (Expired/Cancelled, unpaid, no groups — hold gone), `ambiguous-paid` (money
 * moved, not Fulfilled — do not write/release), or `drift` (partial terminal).
 */
export type OrderLifecycle =
  | { kind: "open"; cart?: CartSnapshot }
  | { kind: "purchased"; purchase: PurchaseResult }
  | { kind: "closed-unpaid" }
  | { kind: "ambiguous-paid" }
  | { kind: "drift" };

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
  /** Read-only check that an order is already released (cancelled/expired); false if open/fulfilled. */
  reconcileRelease(orderToken: string): Promise<boolean>;
  /** Extend expiration (OrderExpirationUpdate): dispatch once, re-read expiry on ambiguity. */
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
  /** Secure-fill transaction; card fields stay in hosted frames, only an opaque handle crosses. */
  secureFill(input: {
    orderToken: string;
    vaultPointer: string;
  }): Promise<EphemeralPaymentHandle>;

  /** A separate explicit Add Card browser transaction. */
  addCard(input: {
    orderToken: string;
    payment: EphemeralPaymentHandle;
  }): Promise<EphemeralCardHandle>;

  /** Purchase transaction; nonce/deviceData never cross, returns the typed confirmation. */
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

/**
 * A COMPLETE HTTP 429 on a write, twice (dispatch + one same-session retry): an
 * explicit rejection (not executed), so a definite typed failure, safe to rerun.
 */
export class WriteRateLimitedError extends Error {
  readonly code = "AMC_WRITE_RATE_LIMITED";
  constructor(
    readonly operation:
      "cart" | "purchase" | "refund" | "release" | "expiration",
  ) {
    super(
      `AMC ${operation} request was rate limited (HTTP 429) on both the original dispatch and its single immediate retry; the write was rejected, not executed — wait briefly and run the same command again`,
    );
  }
}

/**
 * A COMPLETE anti-bot challenge on a write, twice (dispatch + one bounded direct
 * re-admission): the edge blocked it before the origin mutation, so a definite
 * rejection (nothing executed). Persisting needs an explicit `amc auth repair`.
 */
export class WriteChallengedError extends Error {
  readonly code = "AMC_WRITE_CHALLENGED";
  constructor(
    readonly operation:
      "cart" | "purchase" | "refund" | "release" | "expiration",
  ) {
    super(
      `AMC ${operation} request was rejected by the anti-bot edge (HTTP challenge) on both the original dispatch and after a bounded direct session re-admission; the edge blocked it before the mutation ran (no mutation occurred). If this persists, run \`amc auth repair --listing-url <official theater URL>\`.`,
    );
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
