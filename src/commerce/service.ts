import { MemorySessionStore, SessionStore } from "../auth-session";
import {
  CartIntentRecord,
  CartIntentStore,
  migrateLegacyIntent,
} from "./cart-intent-store";
import { PendingWriteStore } from "./pending-write-store";
import {
  intentHash,
  refundHash,
  selectionHash,
  sha256,
} from "./intent-identity";
import { AmcCommerceProjectionProvider } from "./graphql-executor";
import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  CommerceExecutor,
  Money,
  PaymentExecutor,
  PurchaseNotCompletedError,
  PurchaseResult,
  RefundOrderSnapshot,
} from "./executor";

import {
  assertCartMatchesPreview,
  assertCheckoutSessionOwner,
  assertRefundMatchesPreview,
  cartIntentBinding,
  checkoutBinding,
  checkoutChallengePreview,
  checkoutPreview,
  clone,
  isMissingCartIntent,
  refundPreview,
  requireEmail,
  requireNonEmpty,
  validateCartAgainstIntent,
  validateCartIntent,
  validateCheckoutChallengeConfirmation,
  validateCheckoutConfirmation,
  validateCheckoutPreviewIntegrity,
  validateOpenCart,
  validatePurchase,
  validateRefundConfirmation,
  validateRefundLookup,
  validTimestamp,
  verifyRefundPostcondition,
} from "./checkout-preview";

// "Not purchased" is declared only after this settle window (Pending+unpaid).
export const PURCHASE_QUIET_WINDOW_MS = 60_000;

// A tokenless cart hold blocks a duplicate for the same seats this long.
export const CART_HOLD_TTL_MS = 30 * 60_000;

export class ConsequenceMismatchError extends Error {
  readonly code = "AMC_CONSEQUENCE_MISMATCH";
}
export class ConfirmationMismatchError extends Error {
  readonly code = "AMC_CONFIRMATION_MISMATCH";
}
export class SingleFlightError extends Error {
  readonly code = "AMC_SINGLE_FLIGHT";
}
export class UnknownWriteOutcomeError extends Error {
  // `string` so a subclass can specialize the stable code.
  readonly code: string = "AMC_WRITE_OUTCOME_UNKNOWN";
}

/** Non-secret identifiers for durable reconciliation (never card/session/device). */
export interface UnknownOutcomeReconciliation {
  orderToken?: string;
  orderNumber?: string;
  showtimeId?: string;
  seatNames?: string[];
  lineNumbers?: string[];
}

/** Base for typed unknown-outcome errors carrying safe reconciliation context. */
class ReconciliationOutcomeError extends UnknownWriteOutcomeError {
  constructor(
    message: string,
    readonly reconciliation: UnknownOutcomeReconciliation,
  ) {
    super(message);
  }
}

/** A CartCreateOrder dispatch whose outcome could not be authoritatively read. */
export class CartCreationOutcomeUnknownError extends ReconciliationOutcomeError {
  readonly operation = "cart" as const;
}

/**
 * A CartCreateOrder whose provider token IS known (the cart EXISTS) but whose
 * details could not be read back. Safe recovery is exact: inspect or release the
 * known token, never create a second cart. Distinct code, same envelope shape.
 */
export class CartHoldWithoutSnapshotError extends CartCreationOutcomeUnknownError {
  override readonly code = "AMC_CART_HOLD_UNCONFIRMED";
  constructor(reconciliation: UnknownOutcomeReconciliation) {
    super(
      "AMC cart hold was created and its order token is known, but the hold could not be confirmed (its details could not be read back or did not match the request). The cart EXISTS: release it with `amc order release --token <orderToken>` (or `amc checkout reconcile`) using error.reconciliation.orderToken. Do NOT create another cart.",
      reconciliation,
    );
  }
}

/** No durable original cart intent exists for this token; agent checkout needs a cart this CLI created. */
export class CartIntentUnavailableError extends Error {
  readonly code = "AMC_CART_INTENT_UNAVAILABLE";
  constructor(readonly orderToken: string) {
    super(
      "AMC cannot preview or check out this order token: no original cart intent is journaled for it by this CLI. Create the cart with `amc cart create ...` first (agent checkout requires a cart this CLI journaled); the checkout URL from `cart create` still works for a human.",
    );
  }
}

/** The token's order is not an open cart (purchased/closed/etc.), so it cannot be previewed. */
export class CartNotResumableError extends Error {
  readonly code = "AMC_CART_NOT_OPEN";
  constructor(readonly state: string) {
    super(
      `AMC cart for this order token is ${state}, not an open cart; it cannot be previewed for checkout.`,
    );
  }
}

/** Ambiguous fulfillment still inside the settle window (Pending+unpaid); do not release/resubmit yet. */
export class CheckoutSettlingError extends ReconciliationOutcomeError {
  override readonly code = "AMC_CHECKOUT_SETTLING";
  readonly operation = "checkout" as const;
  constructor(reconciliation: UnknownOutcomeReconciliation) {
    super(
      "AMC fulfillment outcome is still settling (provider shows the order pending and unpaid, but the settle window has not elapsed); do not release or resubmit yet — reconcile again shortly.",
      reconciliation,
    );
  }
}

/** An OrderFulfill dispatch whose outcome could not be authoritatively read. */
export class CheckoutOutcomeUnknownError extends ReconciliationOutcomeError {
  readonly operation = "checkout" as const;
}

/** An OrderRefund dispatch whose outcome could not be authoritatively read. */
export class RefundOutcomeUnknownError extends ReconciliationOutcomeError {
  readonly operation = "refund" as const;
}

/** An OrderDelete dispatch whose released/not-released outcome could not be read. */
export class ReleaseOutcomeUnknownError extends ReconciliationOutcomeError {
  readonly operation = "release" as const;
}
export class PostconditionVerificationError extends Error {
  readonly code = "AMC_POSTCONDITION_UNVERIFIED";
}
export class ChallengePaymentSetupError extends Error {
  readonly code = "AMC_CHALLENGE_PAYMENT_SETUP_REQUIRED";
  constructor() {
    super("AMC interactive payment challenge executor is not configured");
  }
}

export interface CheckoutPreview {
  kind: "checkout";
  orderToken: string;
  showtimeId: string;
  seats: CartSnapshot["seats"];
  tickets: CartSnapshot["tickets"];
  total: Money;
  expiresAt: string;
  emailBinding: string;
  observedAt: string;
  confirmationToken: string;
}

export interface RefundPreview {
  kind: "refund";
  orderNumber: string;
  orderToken: string;
  lineNumbers: string[];
  scope: "full" | "partial";
  refundTotal: Money;
  remainingRefundableTotal: Money;
  nonRefundableFee: Money;
  chargedTotal: Money;
  status: RefundOrderSnapshot["status"];
  emailBinding: string;
  observedAt: string;
  confirmationToken: string;
}

export interface CheckoutChallengePreview {
  kind: "checkout-challenge";
  orderToken: string;
  showtimeId: string;
  seats: CartSnapshot["seats"];
  tickets: CartSnapshot["tickets"];
  total: Money;
  expiresAt: string;
  emailBinding: string;
  observedAt: string;
  confirmationToken: string;
}

/**
 * Durable recovery: the immutable cart-intent store, the uncertainty ledger,
 * and the backing SessionStore (lock + legacy read). No lifecycle state
 * machine — the provider order projection is the sole truth.
 */
export interface CheckoutRecovery {
  intents: CartIntentStore;
  pending: PendingWriteStore;
  store: SessionStore;
}

export interface AmcCommerceServiceOptions {
  executor: CommerceExecutor;
  projections: AmcCommerceProjectionProvider;
  payment: PaymentExecutor;
  challengePayment?: PaymentExecutor;
  recovery?: CheckoutRecovery;
  now?: () => Date;
}

export class CheckoutSessionOwnershipError extends Error {
  readonly code = "AMC_CHECKOUT_SESSION_OWNERSHIP";
  constructor() {
    super("AMC checkout attempt belongs to another checkout session");
  }
}

export class AmcCommerceService {
  private readonly now: () => Date;
  private readonly recovery: CheckoutRecovery;
  private readonly activeOrders = new Set<string>();

  constructor(private readonly options: AmcCommerceServiceOptions) {
    this.now = options.now ?? (() => new Date());
    // Recovery is always present: an omitted one becomes an in-memory bundle
    // (no files), so same-process dedup/reconcile work with zero config.
    const store = new MemorySessionStore();
    this.recovery = options.recovery ?? {
      intents: new CartIntentStore(store),
      pending: new PendingWriteStore(store),
      store,
    };
  }

  private recoveryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.recovery.store.withRefreshLock(
      { provider: "amc-recovery-lock", account: sha256(key) },
      fn,
    );
  }

  /** Resolve the durable intent for a token, migrating a legacy record on first access. */
  private loadIntentRecord(
    orderToken: string,
  ): Promise<CartIntentRecord | null> {
    return migrateLegacyIntent(this.recovery, orderToken);
  }

  async createCart(
    intent: CartCreateIntent,
    checkoutSessionId?: string,
  ): Promise<CartSnapshot> {
    validateCartIntent(intent);
    const rec = this.recovery;
    const seatNames = intent.seats.map((seat) => seat.name);
    const selKey = selectionHash(intent.showtimeId, seatNames);
    return this.singleFlight(`cart:${cartIntentBinding(intent)}`, () =>
      this.recoveryLock(`cart:${selKey}`, async () => {
        // A fresh tokenless cart marker blocks a duplicate regardless of any
        // prior alias — checked FIRST so it is never overwritten.
        const marker = await rec.pending.load("cart", selKey);
        if (marker) {
          if (
            this.now().getTime() - Date.parse(marker.dispatchedAt) <
            CART_HOLD_TTL_MS
          ) {
            throw new UnknownWriteOutcomeError(
              "a prior cart dispatch for these seats is still unresolved; not creating a duplicate",
            );
          }
          await rec.pending.clear("cart", selKey);
        }
        // A prior cart for this exact selection: let provider truth decide.
        const priorToken = await rec.intents.newestTokenForSelection(
          intent.showtimeId,
          seatNames,
        );
        if (priorToken) {
          const life = await this.options.projections.projectLifecycle(
            priorToken,
            { intent, now: this.now() },
          );
          if (life.kind === "open" && life.cart) return clone(life.cart);
          if (life.kind === "purchased") {
            throw new ConsequenceMismatchError(
              "a cart for these seats was already purchased",
            );
          }
          if (life.kind === "ambiguous-paid" || life.kind === "drift") {
            throw new UnknownWriteOutcomeError(
              "the prior cart for these seats is unresolved; not creating a duplicate",
            );
          }
          // closed-unpaid: the hold is gone; a new cart is allowed.
        }
        await rec.pending.mark({
          operation: "cart",
          key: selKey,
          intentHash: intentHash(intent),
          dispatchedAt: this.now().toISOString(),
        });
        let knownToken: string | null = null;
        try {
          return await this.dispatchCart(intent, async (orderToken) => {
            knownToken = orderToken;
            await rec.intents.record({
              orderToken,
              intent,
              ...(checkoutSessionId ? { checkoutSessionId } : {}),
              createdAt: this.now().toISOString(),
            });
            await rec.pending.clear("cart", selKey);
          });
        } catch (error) {
          if (knownToken !== null)
            throw this.cartHoldStranded(knownToken, intent);
          // No token: clear the marker only on a DEFINITE rejection; an
          // ambiguous outcome keeps it so no duplicate cart is created.
          if (!(error instanceof UnknownWriteOutcomeError)) {
            await rec.pending.clear("cart", selKey);
          }
          throw error;
        }
      }),
    );
  }

  /** Typed cart-hold error for a KNOWN token whose cart could not be read back (safe ids only). */
  private cartHoldStranded(
    orderToken: string,
    intent: CartCreateIntent,
  ): CartHoldWithoutSnapshotError {
    return new CartHoldWithoutSnapshotError({
      orderToken,
      showtimeId: intent.showtimeId,
      seatNames: intent.seats.map((seat) => seat.name),
    });
  }

  private async dispatchCart(
    intent: CartCreateIntent,
    onToken?: (orderToken: string) => Promise<void>,
  ): Promise<CartSnapshot> {
    let cart: CartSnapshot;
    try {
      cart = await this.options.executor.createCart(intent, onToken);
    } catch (error) {
      if (!(error instanceof AmbiguousWriteError)) throw error;
      const reconciled = await this.options.executor.reconcileCart(intent);
      if (!reconciled) {
        throw new UnknownWriteOutcomeError(
          "CartCreateOrder outcome remains unknown after reconciliation",
        );
      }
      cart = reconciled;
      await onToken?.(cart.orderToken);
    }
    validateCartAgainstIntent(cart, intent, this.now());
    return clone(cart);
  }

  /**
   * The single provider-authoritative resolution used by reconcile/release/
   * submit: one fresh projection decides the lifecycle; an open cart with an
   * outstanding purchase marker is `settling` until the quiet window elapses,
   * then the marker clears and the cart stays open. Definite outcomes clear
   * their markers.
   */
  private async resolveLifecycle(
    orderToken: string,
    record: CartIntentRecord,
  ): Promise<
    | { kind: "open"; cart?: CartSnapshot }
    | { kind: "purchased"; purchase: PurchaseResult }
    | { kind: "closed-unpaid" }
    | { kind: "settling" }
    | { kind: "blocked" }
  > {
    const pending = this.recovery.pending;
    const life = await this.options.projections.projectLifecycle(orderToken, {
      intent: record.intent,
      now: this.now(),
    });
    const marker =
      (await pending.load("purchase", orderToken)) ??
      (await pending.load("purchase-challenge", orderToken));
    if (life.kind === "purchased") {
      await pending.clear("purchase", orderToken);
      await pending.clear("purchase-challenge", orderToken);
      return { kind: "purchased", purchase: life.purchase };
    }
    if (life.kind === "closed-unpaid") {
      await pending.clear("purchase", orderToken);
      await pending.clear("purchase-challenge", orderToken);
      return { kind: "closed-unpaid" };
    }
    if (life.kind === "ambiguous-paid" || life.kind === "drift") {
      return { kind: "blocked" };
    }
    // open: an outstanding marker is "settling" until the window elapses,
    // then the fulfillment provably did not execute — clear it, cart stays open.
    if (marker) {
      const elapsed = this.now().getTime() - Date.parse(marker.dispatchedAt);
      if (elapsed < PURCHASE_QUIET_WINDOW_MS) return { kind: "settling" };
      await pending.clear(marker.operation, orderToken);
    }
    return { kind: "open", cart: life.cart };
  }

  /**
   * Provider-authoritative checkout reconciliation: confirmed purchase (clears
   * markers), null when provably not purchased, or a typed settling error
   * inside the quiet window.
   */
  async reconcileCheckoutByToken(
    orderToken: string,
    email: string,
    checkoutSessionId?: string,
  ): Promise<(PurchaseResult & { reconciled: true }) | null> {
    requireNonEmpty(orderToken, "order token");
    requireEmail(email);
    return this.recoveryLock(`checkout:${orderToken}`, async () => {
      const record = await this.loadIntentRecord(orderToken);
      if (!record) {
        // No durable intent: a read-only PROJECTION check (not the payment
        // capability), so a no-card CLI can reconcile an external token.
        const observed = await this.options.projections.reconcilePurchase(
          orderToken,
          email,
        );
        return observed ? { ...observed, reconciled: true as const } : null;
      }
      assertCheckoutSessionOwner(record, checkoutSessionId);
      const res = await this.resolveLifecycle(orderToken, record);
      if (res.kind === "purchased") {
        return { ...res.purchase, reconciled: true as const };
      }
      if (res.kind === "settling")
        throw new CheckoutSettlingError({ orderToken });
      if (res.kind === "blocked") {
        throw new CheckoutOutcomeUnknownError(
          "AMC order state is unresolved (money may have moved); reconcile again shortly",
          { orderToken },
        );
      }
      // open or closed-unpaid: provably not purchased.
      return null;
    });
  }

  async releaseCart(
    orderToken: string,
    checkoutSessionId?: string,
  ): Promise<{ released: true }> {
    requireNonEmpty(orderToken, "order token");
    return this.recoveryLock(`release:${orderToken}`, async () => {
      const record = await this.loadIntentRecord(orderToken);
      // No durable intent: bounded stateless release (no ambiguous redispatch).
      if (!record) return this.releaseStateless(orderToken);
      assertCheckoutSessionOwner(record, checkoutSessionId);
      const res = await this.resolveLifecycle(orderToken, record);
      if (res.kind === "purchased") {
        await this.recovery.pending.clear("release", orderToken);
        throw new ConsequenceMismatchError(
          "cart was purchased and cannot be released",
        );
      }
      if (res.kind === "closed-unpaid") {
        // Provider proves the order is gone: any prior release is resolved.
        await this.recovery.pending.clear("release", orderToken);
        return { released: true as const };
      }
      if (res.kind === "settling")
        throw new CheckoutSettlingError({ orderToken });
      if (res.kind === "blocked") {
        throw new UnknownWriteOutcomeError(
          "AMC cart state is unresolved; release will not be dispatched",
        );
      }
      // open + a prior release marker: the earlier OrderDelete is unresolved —
      // do not redispatch a consequential write.
      if (await this.recovery.pending.load("release", orderToken)) {
        throw new ReleaseOutcomeUnknownError(
          "OrderDelete outcome remains unknown; release will not be redispatched",
          { orderToken },
        );
      }
      // open: dispatch OrderDelete exactly once behind a release marker.
      await this.recovery.pending.mark({
        operation: "release",
        key: orderToken,
        intentHash: record.intentHash,
        dispatchedAt: this.now().toISOString(),
      });
      try {
        const result = await this.releaseStateless(orderToken);
        await this.recovery.pending.clear("release", orderToken);
        return result;
      } catch (error) {
        // Ambiguous (ReleaseOutcomeUnknownError) keeps the marker; a definite
        // rejection clears it (nothing to reconcile).
        if (!(error instanceof ReleaseOutcomeUnknownError)) {
          await this.recovery.pending.clear("release", orderToken);
        }
        throw error;
      }
    });
  }

  /**
   * Dispatch OrderDelete at most once; on an ambiguous response reconcile
   * read-only and return released only if proven cancelled/expired, else throw
   * ReleaseOutcomeUnknownError. Never redispatches.
   */
  private async releaseStateless(
    orderToken: string,
  ): Promise<{ released: true }> {
    try {
      await this.options.executor.deleteCart(orderToken);
      return { released: true as const };
    } catch (error) {
      if (!(error instanceof AmbiguousWriteError)) throw error;
      let released = false;
      try {
        released = await this.options.executor.reconcileRelease(orderToken);
      } catch {
        released = false;
      }
      if (released) return { released: true as const };
      throw new ReleaseOutcomeUnknownError(
        "OrderDelete outcome remains unknown; release will not be redispatched",
        { orderToken },
      );
    }
  }

  async inspectCart(orderToken: string, email: string): Promise<CartSnapshot> {
    requireNonEmpty(orderToken, "order token");
    requireEmail(email);
    const record = await this.loadIntentRecord(orderToken);
    if (record) {
      // Recover the ORIGINAL intent and let ONE projection decide the lifecycle
      // (token-first preview/submit in a fresh process); non-open never previews.
      const life = await this.options.projections.projectLifecycle(orderToken, {
        intent: record.intent,
        now: this.now(),
      });
      if (life.kind === "open" && life.cart) return clone(life.cart);
      throw new CartNotResumableError(life.kind);
    }
    // No durable intent: fall back to the executor's same-process projection;
    // a genuinely unavailable intent surfaces the actionable typed error.
    try {
      const cart = await this.options.executor.inspectCart(orderToken, email);
      validateOpenCart(cart, this.now());
      return clone(cart);
    } catch (error) {
      if (isMissingCartIntent(error)) {
        throw new CartIntentUnavailableError(orderToken);
      }
      throw error;
    }
  }

  /** Extend expiration: the executor dispatches at most once and re-reads the expiry. */
  async extendOrderExpiration(
    orderToken: string,
  ): Promise<{ orderToken: string; expiresAt: string }> {
    requireNonEmpty(orderToken, "order token");
    const result =
      await this.options.executor.extendOrderExpiration(orderToken);
    if (!validTimestamp(result.expiresAt)) {
      throw new ConsequenceMismatchError(
        "extend expiration projection drifted",
      );
    }
    return { orderToken, expiresAt: result.expiresAt };
  }

  async previewCheckout(input: {
    orderToken: string;
    email: string;
  }): Promise<CheckoutPreview> {
    const cart = await this.inspectCart(input.orderToken, input.email);
    return checkoutPreview(cart, input.email, this.now());
  }

  submitCheckout(input: {
    preview: CheckoutPreview;
    confirmationToken: string;
    email: string;
    vaultPointer: string;
  }): Promise<PurchaseResult & { reconciled: boolean }> {
    return this.submitFulfillment("purchase", input);
  }

  /**
   * Shared fulfillment for the direct + challenge paths: resolve any prior
   * fulfillment from provider truth, then submit once behind an op marker.
   */
  private submitFulfillment(
    op: "purchase" | "purchase-challenge",
    input: {
      preview: CheckoutPreview | CheckoutChallengePreview;
      confirmationToken: string;
      email: string;
      vaultPointer: string;
    },
  ): Promise<PurchaseResult & { reconciled: boolean }> {
    const orderToken = input.preview.orderToken;
    return this.singleFlight(orderToken, () =>
      this.recoveryLock(`checkout:${orderToken}`, async () => {
        const record = await this.loadIntentRecord(orderToken);
        if (!record) return this.submitFulfillmentLocked(op, input);
        const marker =
          (await this.recovery.pending.load("purchase", orderToken)) ??
          (await this.recovery.pending.load("purchase-challenge", orderToken));
        if (marker) {
          const res = await this.resolveLifecycle(orderToken, record);
          if (res.kind === "purchased") {
            validatePurchase(res.purchase, checkoutBinding(input.preview));
            return { ...res.purchase, reconciled: true };
          }
          if (res.kind === "settling") {
            throw new CheckoutSettlingError({ orderToken });
          }
          if (res.kind === "blocked") {
            throw new CheckoutOutcomeUnknownError(
              "AMC order state is unresolved; fulfillment will not be redispatched",
              { orderToken },
            );
          }
          // open / closed-unpaid resolved as not purchased: fall through.
        }
        return this.submitFulfillmentLocked(op, input, record);
      }),
    );
  }

  private async submitFulfillmentLocked(
    op: "purchase" | "purchase-challenge",
    input: {
      preview: CheckoutPreview | CheckoutChallengePreview;
      confirmationToken: string;
      email: string;
      vaultPointer: string;
    },
    record?: CartIntentRecord,
  ): Promise<PurchaseResult & { reconciled: boolean }> {
    const orderToken = input.preview.orderToken;
    const binding = checkoutBinding(input.preview);
    const isChallenge = op === "purchase-challenge";
    if (isChallenge) {
      validateCheckoutChallengeConfirmation(
        input.preview as CheckoutChallengePreview,
        input.confirmationToken,
        input.email,
        this.now(),
      );
    } else {
      validateCheckoutConfirmation(
        input.preview as CheckoutPreview,
        input.confirmationToken,
        input.email,
        this.now(),
      );
    }
    requireNonEmpty(input.vaultPointer, "vault pointer");

    // Challenge continuation short-circuits if direct already purchased.
    if (isChallenge) {
      const already = await this.options.payment.reconcilePurchase(
        orderToken,
        input.email,
      );
      if (already) {
        validatePurchase(already, binding);
        await this.recovery.pending.clear(op, orderToken);
        return { ...already, reconciled: true };
      }
    }
    const executor = isChallenge
      ? this.requireChallengePayment()
      : this.options.payment;

    // Thread the durable intent so the pre-dispatch re-reads work fresh-process.
    const submitIntent = record ? structuredClone(record.intent) : undefined;
    const beforeCard = await this.options.executor.inspectCart(
      orderToken,
      input.email,
      submitIntent,
    );
    assertCartMatchesPreview(beforeCard, binding, this.now());
    const payment = await executor.secureFill({
      orderToken,
      vaultPointer: input.vaultPointer,
    });
    const card = await executor.addCard({ orderToken, payment });
    const beforePurchase = await this.options.executor.inspectCart(
      orderToken,
      input.email,
      submitIntent,
    );
    assertCartMatchesPreview(beforePurchase, binding, this.now());
    if (record) {
      await this.recovery.pending.mark({
        operation: op,
        key: orderToken,
        intentHash: record.intentHash,
        dispatchedAt: this.now().toISOString(),
      });
    }

    let purchase: PurchaseResult;
    let reconciled = false;
    try {
      purchase = await executor.purchase({
        orderToken,
        email: input.email,
        expectedTotal: input.preview.total,
        card,
      });
    } catch (error) {
      // PurchaseNotCompleted / any definite typed rejection: nothing executed.
      if (
        error instanceof PurchaseNotCompletedError ||
        !(error instanceof AmbiguousWriteError)
      ) {
        await this.recovery.pending.clear(op, orderToken);
        throw error;
      }
      let observed: PurchaseResult | null;
      try {
        observed = await executor.reconcilePurchase(orderToken, input.email);
      } catch (reconcileError) {
        if (!(reconcileError instanceof PurchaseNotCompletedError))
          throw reconcileError;
        await this.recovery.pending.clear(op, orderToken);
        throw reconcileError;
      }
      if (!observed) {
        // Keep the marker: the quiet window governs a later reconcile.
        throw new CheckoutOutcomeUnknownError(
          "OrderFulfill outcome remains unknown after reconciliation",
          { orderToken },
        );
      }
      purchase = observed;
      reconciled = true;
    }
    validatePurchase(purchase, binding);
    await this.recovery.pending.clear(op, orderToken);
    return { ...purchase, reconciled };
  }

  private requireChallengePayment(): PaymentExecutor {
    const challengePayment = this.options.challengePayment;
    if (!challengePayment) throw new ChallengePaymentSetupError();
    return challengePayment;
  }

  async previewCheckoutChallenge(input: {
    checkoutPreview: CheckoutPreview;
    email: string;
  }): Promise<
    | CheckoutChallengePreview
    | (PurchaseResult & { kind: "confirmed"; reconciled: true })
  > {
    validateCheckoutPreviewIntegrity(input.checkoutPreview, input.email);
    const reconciled = await this.options.payment.reconcilePurchase(
      input.checkoutPreview.orderToken,
      input.email,
    );
    if (reconciled) {
      validatePurchase(reconciled, input.checkoutPreview);
      return { kind: "confirmed", ...reconciled, reconciled: true };
    }
    const record = await this.loadIntentRecord(
      input.checkoutPreview.orderToken,
    );
    const cart = await this.options.executor.inspectCart(
      input.checkoutPreview.orderToken,
      input.email,
      record ? structuredClone(record.intent) : undefined,
    );
    assertCartMatchesPreview(cart, input.checkoutPreview, this.now());
    return checkoutChallengePreview(cart, input.email, this.now());
  }

  submitCheckoutChallenge(input: {
    preview: CheckoutChallengePreview;
    confirmationToken: string;
    email: string;
    vaultPointer: string;
  }): Promise<PurchaseResult & { reconciled: boolean }> {
    return this.submitFulfillment("purchase-challenge", input);
  }

  async previewFullRefund(input: {
    orderNumber: string;
    email: string;
  }): Promise<RefundPreview> {
    validateRefundLookup(input.orderNumber, input.email, ["all"]);
    const order = await this.options.executor.searchOrder(
      input.orderNumber,
      input.email,
    );
    const lineNumbers = order.lines
      .filter((line) => line.status === "PAID")
      .map((line) => line.lineNumber);
    if (lineNumbers.length === 0) {
      throw new ConsequenceMismatchError("order has no refundable lines");
    }
    return refundPreview(order, input.email, lineNumbers, this.now());
  }

  async previewRefund(input: {
    orderNumber: string;
    email: string;
    lineNumbers: string[];
  }): Promise<RefundPreview> {
    validateRefundLookup(input.orderNumber, input.email, input.lineNumbers);
    const order = await this.options.executor.searchOrder(
      input.orderNumber,
      input.email,
    );
    return refundPreview(order, input.email, input.lineNumbers, this.now());
  }

  async submitRefund(input: {
    preview: RefundPreview;
    confirmationToken: string;
    email: string;
  }): Promise<{
    orderId: string;
    status: "REFUND_REQUESTED" | "REFUNDED";
    refundTotal: Money;
    nonRefundableFee: Money;
    reconciled: boolean;
  }> {
    const key = refundHash(input.preview.orderToken, input.preview.lineNumbers);
    return this.singleFlight(input.preview.orderToken, () =>
      this.recoveryLock(`refund:${key}`, async () => {
        validateRefundConfirmation(
          input.preview,
          input.confirmationToken,
          input.email,
          this.now(),
        );
        const marker = await this.recovery.pending.load("refund", key);
        if (marker) {
          // A prior refund dispatch is unresolved: provider truth decides.
          const verified = await this.options.executor.searchOrder(
            input.preview.orderNumber,
            input.email,
          );
          try {
            verifyRefundPostcondition(verified, input.preview.lineNumbers);
          } catch {
            throw new UnknownWriteOutcomeError(
              "AMC refund outcome remains unknown; refund will not be redispatched",
            );
          }
          await this.recovery.pending.clear("refund", key);
          return {
            orderId: input.preview.orderToken,
            status: verified.status,
            refundTotal: input.preview.refundTotal,
            nonRefundableFee: input.preview.nonRefundableFee,
            reconciled: true,
          };
        }
        return this.submitRefundLocked(input, key);
      }),
    );
  }

  private async submitRefundLocked(
    input: { preview: RefundPreview; confirmationToken: string; email: string },
    key: string,
  ): Promise<{
    orderId: string;
    status: "REFUND_REQUESTED" | "REFUNDED";
    refundTotal: Money;
    nonRefundableFee: Money;
    reconciled: boolean;
  }> {
    const current = await this.options.executor.searchOrder(
      input.preview.orderNumber,
      input.email,
    );
    assertRefundMatchesPreview(
      refundPreview(
        current,
        input.email,
        input.preview.lineNumbers,
        this.now(),
      ),
      input.preview,
    );
    await this.recovery.pending.mark({
      operation: "refund",
      key,
      intentHash: sha256(key),
      dispatchedAt: this.now().toISOString(),
    });

    let orderId = input.preview.orderToken;
    let verified: RefundOrderSnapshot;
    let reconciled = false;
    try {
      const response = await this.options.executor.refund({
        token: current.orderToken,
        lineNumbers: [...input.preview.lineNumbers],
      });
      orderId = response.orderId;
      verified = await this.options.executor.searchOrder(
        input.preview.orderNumber,
        input.email,
      );
    } catch (error) {
      try {
        verified = await this.options.executor.searchOrder(
          input.preview.orderNumber,
          input.email,
        );
        verifyRefundPostcondition(verified, input.preview.lineNumbers);
        reconciled = true;
      } catch {
        // Ambiguous keeps the marker (a later submit reconciles); a definite
        // rejection clears it.
        if (error instanceof AmbiguousWriteError) {
          throw new UnknownWriteOutcomeError(
            "AMC refund outcome remains unknown after reconciliation",
          );
        }
        await this.recovery.pending.clear("refund", key);
        throw error;
      }
    }
    verifyRefundPostcondition(verified, input.preview.lineNumbers);
    await this.recovery.pending.clear("refund", key);
    return {
      orderId,
      status: verified.status,
      refundTotal: input.preview.refundTotal,
      nonRefundableFee: input.preview.nonRefundableFee,
      reconciled,
    };
  }

  private async singleFlight<T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.activeOrders.has(key)) {
      throw new SingleFlightError(
        "AMC operation already active for this order",
      );
    }
    this.activeOrders.add(key);
    try {
      return await action();
    } finally {
      this.activeOrders.delete(key);
    }
  }
}
