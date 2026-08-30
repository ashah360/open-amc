import { createHash } from "node:crypto";
import { SessionStore } from "../auth-session";
import {
  CartIntentRecord,
  CartIntentStore,
  readLegacyAttemptByToken,
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

const PREVIEW_MAX_AGE_MS = 2 * 60 * 1000;

/**
 * After an ambiguous fulfillment (money may have moved), a Pending+paid0 order
 * is only declared "not purchased" once this quiet window has elapsed AND a
 * fresh projection still shows Pending+paid0 — Cloudflare/edge settling can lag.
 */
export const PURCHASE_QUIET_WINDOW_MS = 60_000;

/**
 * A tokenless cart dispatch (CartCreateOrder whose response never yielded a
 * token) blocks a duplicate for the same seat selection for this long, the
 * documented provider hold assumption, after which it is lazily cleared.
 */
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
  // Typed as string so a subclass can specialize it to a more exact stable
  // code (e.g. a known-token cart hold) while still being an
  // UnknownWriteOutcomeError for envelope/reconciliation handling.
  readonly code: string = "AMC_WRITE_OUTCOME_UNKNOWN";
}

/**
 * Safe context an application can use to resume reconciliation with its own
 * durable state (Postgres/Temporal/SQLite/etc). It carries only non-secret
 * identifiers — never card, session, nonce, or device material.
 */
export interface UnknownOutcomeReconciliation {
  orderToken?: string;
  orderNumber?: string;
  showtimeId?: string;
  seatNames?: string[];
  lineNumbers?: string[];
}

/** A CartCreateOrder dispatch whose outcome could not be authoritatively read. */
export class CartCreationOutcomeUnknownError extends UnknownWriteOutcomeError {
  readonly operation = "cart" as const;
  constructor(
    message: string,
    readonly reconciliation: UnknownOutcomeReconciliation,
  ) {
    super(message);
  }
}

/**
 * A CartCreateOrder whose provider order token IS known (the cart EXISTS), but
 * whose details could not be read back (projection/validation failed after the
 * token was received). Unlike a truly unknown write, the safe recovery is exact:
 * inspect or release the known token; never create a second cart. It extends
 * {@link CartCreationOutcomeUnknownError} so the CLI JSON envelope still carries
 * `operation: "cart"` and the allowlisted `reconciliation` (now including
 * `orderToken`), but uses a distinct, non-"unknown" code and message.
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

/**
 * A cart/order token cannot be previewed or checked out because this CLI has no
 * durable record of the ORIGINAL cart intent for it. The projection needs the
 * original seat/SKU invariant and must never synthesize it from the provider
 * response, so this is the actionable, cross-process replacement for a
 * low-level projection drift (`cart.intent`): agent-driven checkout requires a
 * cart created (and journaled) by this CLI via `amc cart create ...`. The human
 * checkout URL returned by `cart create` is unaffected and usable independently.
 */
export class CartIntentUnavailableError extends Error {
  readonly code = "AMC_CART_INTENT_UNAVAILABLE";
  constructor(readonly orderToken: string) {
    super(
      "AMC cannot preview or check out this order token: no original cart intent is journaled for it by this CLI. Create the cart with `amc cart create ...` first (agent checkout requires a cart this CLI journaled); the checkout URL from `cart create` still works for a human.",
    );
  }
}

/**
 * The journaled attempt for this order token exists but is not in an
 * open/resumable cart state (e.g. it was released, not purchased, already
 * confirmed, or is mid-dispatch), so it must not be previewed as an open cart.
 */
export class CartNotResumableError extends Error {
  readonly code = "AMC_CART_NOT_OPEN";
  constructor(readonly state: string) {
    super(
      `AMC cart for this order token is ${state}, not an open cart; it cannot be previewed for checkout.`,
    );
  }
}

/**
 * A previously ambiguous fulfillment is still inside the bounded settling
 * window: the provider shows Pending + nothing paid, but not long enough has
 * elapsed since dispatch to declare it definitely not purchased. The
 * uncertainty marker is preserved; the caller must neither release nor
 * resubmit yet. This is a typed unknown (never a misleading "not purchased").
 */
export class CheckoutSettlingError extends UnknownWriteOutcomeError {
  override readonly code = "AMC_CHECKOUT_SETTLING";
  readonly operation = "checkout" as const;
  constructor(readonly reconciliation: UnknownOutcomeReconciliation) {
    super(
      "AMC fulfillment outcome is still settling (provider shows the order pending and unpaid, but the settle window has not elapsed); do not release or resubmit yet — reconcile again shortly.",
    );
  }
}

/** An OrderFulfill dispatch whose outcome could not be authoritatively read. */
export class CheckoutOutcomeUnknownError extends UnknownWriteOutcomeError {
  readonly operation = "checkout" as const;
  constructor(
    message: string,
    readonly reconciliation: UnknownOutcomeReconciliation,
  ) {
    super(message);
  }
}

/** An OrderRefund dispatch whose outcome could not be authoritatively read. */
export class RefundOutcomeUnknownError extends UnknownWriteOutcomeError {
  readonly operation = "refund" as const;
  constructor(
    message: string,
    readonly reconciliation: UnknownOutcomeReconciliation,
  ) {
    super(message);
  }
}

/** An OrderDelete dispatch whose released/not-released outcome could not be read. */
export class ReleaseOutcomeUnknownError extends UnknownWriteOutcomeError {
  readonly operation = "release" as const;
  constructor(
    message: string,
    readonly reconciliation: UnknownOutcomeReconciliation,
  ) {
    super(message);
  }
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
 * Durable recovery: the immutable cart-intent identity store, the uncertainty
 * ledger, and the backing SessionStore (used for a cross-process lock and the
 * transitional legacy-record read). There is NO lifecycle state machine — the
 * provider order projection is the sole truth.
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
  readiness?: {
    assertReady(binding?: string, vaultPointer?: string): void | Promise<void>;
    bind?(binding: string, orderToken: string): void | Promise<void>;
    assertPrepared?(
      binding: string,
      vaultPointer: string,
    ): void | Promise<void>;
    release?(binding: string): void | Promise<void>;
  };
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
  private readonly activeOrders = new Set<string>();

  constructor(private readonly options: AmcCommerceServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async prepareCheckout(
    binding = "__default__",
    vaultPointer?: string,
  ): Promise<void> {
    await this.options.readiness?.assertReady(binding, vaultPointer);
  }

  private async bindCheckout(
    binding: string,
    orderToken: string,
  ): Promise<void> {
    await this.options.readiness?.bind?.(binding, orderToken);
  }

  private async releaseCheckout(binding: string): Promise<void> {
    await this.options.readiness?.release?.(binding);
  }

  private recoveryLock<T>(
    rec: CheckoutRecovery,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return rec.store.withRefreshLock(
      { provider: "amc-recovery-lock", account: digest(key) },
      fn,
    );
  }

  /**
   * Resolve the durable cart-intent identity for a token, transparently
   * migrating a legacy journal record on first access (read-only; legacy bytes
   * are not deleted). Provider truth still decides the lifecycle afterward.
   */
  private async loadIntentRecord(
    rec: CheckoutRecovery,
    orderToken: string,
  ): Promise<CartIntentRecord | null> {
    const existing = await rec.intents.loadByToken(orderToken);
    if (existing) return existing;
    const legacy = await readLegacyAttemptByToken(rec.store, orderToken);
    if (!legacy) return null;
    // RELEASED holds carry no live identity; everything else keeps its intent
    // and the provider decides what the order now is.
    if (legacy.state === "RELEASED") return null;
    await rec.intents.record({
      orderToken: legacy.orderToken,
      intent: legacy.intent,
      createdAt: legacy.updatedAt,
    });
    if (
      legacy.state === "PURCHASE_DISPATCHING" ||
      legacy.state === "PURCHASE_CHALLENGE_DISPATCHING" ||
      legacy.state === "RELEASE_DISPATCHING"
    ) {
      await rec.pending.mark({
        operation:
          legacy.state === "PURCHASE_DISPATCHING"
            ? "purchase"
            : legacy.state === "PURCHASE_CHALLENGE_DISPATCHING"
              ? "purchase-challenge"
              : "release",
        key: orderToken,
        intentHash: intentHash(legacy.intent),
        dispatchedAt: legacy.updatedAt,
      });
    }
    return rec.intents.loadByToken(orderToken);
  }

  async recoverCheckout(input: {
    showtimeId: string;
    seatNames: string[];
    email: string;
    checkoutSessionId?: string;
  }): Promise<
    | { kind: "cart"; cart: CartSnapshot }
    | { kind: "confirmed"; purchase: PurchaseResult & { reconciled: true } }
    | null
  > {
    const rec = this.options.recovery;
    if (!rec) return null;
    requireEmail(input.email);
    const token = await rec.intents.newestTokenForSelection(
      input.showtimeId,
      input.seatNames,
    );
    if (!token) return null;
    const record = await this.loadIntentRecord(rec, token);
    if (!record) return null;
    assertCheckoutSessionOwner(record, input.checkoutSessionId);
    const life = await this.options.projections.projectLifecycle(token, {
      intent: record.intent,
      now: this.now(),
    });
    if (life.kind === "purchased") {
      return {
        kind: "confirmed" as const,
        purchase: { ...life.purchase, reconciled: true as const },
      };
    }
    if (life.kind === "open" && life.cart) {
      return { kind: "cart" as const, cart: clone(life.cart) };
    }
    return null;
  }

  async createCart(
    intent: CartCreateIntent,
    checkoutSessionId?: string,
  ): Promise<CartSnapshot> {
    validateCartIntent(intent);
    const binding = cartIntentBinding(intent);
    return this.singleFlight(`cart:${binding}`, async () => {
      const rec = this.options.recovery;
      if (!rec) {
        await this.prepareCheckout(binding);
        let knownToken: string | null = null;
        try {
          return await this.dispatchCart(intent, async (orderToken) => {
            knownToken = orderToken;
            await this.bindCheckout(binding, orderToken);
          });
        } catch (error) {
          if (knownToken === null) await this.releaseCheckout(binding);
          else throw this.cartHoldStranded(knownToken, intent);
          throw error;
        }
      }
      const seatNames = intent.seats.map((seat) => seat.name);
      const selKey = selectionHash(intent.showtimeId, seatNames);
      const hash = intentHash(intent);
      return this.recoveryLock(rec, `cart:${selKey}`, async () => {
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
        } else {
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
        }
        await rec.pending.mark({
          operation: "cart",
          key: selKey,
          intentHash: hash,
          dispatchedAt: this.now().toISOString(),
        });
        await this.prepareCheckout(binding);
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
            await this.bindCheckout(binding, orderToken);
          });
        } catch (error) {
          if (knownToken !== null)
            throw this.cartHoldStranded(knownToken, intent);
          // No token: clear the marker only on a DEFINITE rejection; an
          // ambiguous outcome (UnknownWriteOutcomeError) keeps it so no
          // duplicate cart is created before the provider resolves it.
          if (!(error instanceof UnknownWriteOutcomeError)) {
            await rec.pending.clear("cart", selKey);
          }
          await this.releaseCheckout(binding);
          throw error;
        }
      });
    });
  }

  /**
   * Build the typed cart-hold error for a KNOWN provider token whose cart
   * details could not be read back. Only the safe allowlisted identifiers
   * surface; the raw provider/projection error is intentionally not carried.
   */
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
   * The single provider-authoritative resolution used by reconcile, release,
   * and submit. One fresh projection decides the order's lifecycle; a still
   * open cart that carries an outstanding purchase marker is reported as
   * `settling` until the quiet window elapses, after which the resolved
   * (not-purchased) marker is cleared and the cart remains open. Any definite
   * resolution clears the relevant markers.
   */
  private async resolveLifecycle(
    rec: CheckoutRecovery,
    orderToken: string,
    record: CartIntentRecord,
  ): Promise<
    | { kind: "open"; cart?: CartSnapshot }
    | { kind: "purchased"; purchase: PurchaseResult }
    | { kind: "closed-unpaid" }
    | { kind: "settling" }
    | { kind: "blocked" }
  > {
    const life = await this.options.projections.projectLifecycle(orderToken, {
      intent: record.intent,
      now: this.now(),
    });
    const marker =
      (await rec.pending.load("purchase", orderToken)) ??
      (await rec.pending.load("purchase-challenge", orderToken));
    if (life.kind === "purchased") {
      await rec.pending.clear("purchase", orderToken);
      await rec.pending.clear("purchase-challenge", orderToken);
      return { kind: "purchased", purchase: life.purchase };
    }
    if (life.kind === "closed-unpaid") {
      await rec.pending.clear("purchase", orderToken);
      await rec.pending.clear("purchase-challenge", orderToken);
      return { kind: "closed-unpaid" };
    }
    if (life.kind === "ambiguous-paid" || life.kind === "drift") {
      return { kind: "blocked" };
    }
    // open
    if (marker) {
      const elapsed = this.now().getTime() - Date.parse(marker.dispatchedAt);
      if (elapsed < PURCHASE_QUIET_WINDOW_MS) return { kind: "settling" };
      // Quiet window elapsed and still Pending+unpaid: the fulfillment did not
      // execute. Clear the marker; the cart stays open for release or resubmit.
      await rec.pending.clear(marker.operation, orderToken);
    }
    return { kind: "open", cart: life.cart };
  }

  /**
   * Provider-authoritative checkout reconciliation for an order token. Replaces
   * the raw projection read the client used to call directly. Returns the
   * confirmed purchase (clearing markers) or null when the order is provably
   * not purchased; throws a typed settling error inside the quiet window.
   */
  async reconcileCheckoutByToken(
    orderToken: string,
    email: string,
    checkoutSessionId?: string,
  ): Promise<(PurchaseResult & { reconciled: true }) | null> {
    requireNonEmpty(orderToken, "order token");
    requireEmail(email);
    const rec = this.options.recovery;
    if (!rec) {
      const observed = await this.options.payment.reconcilePurchase(
        orderToken,
        email,
      );
      return observed ? { ...observed, reconciled: true as const } : null;
    }
    return this.recoveryLock(rec, `checkout:${orderToken}`, async () => {
      const record = await this.loadIntentRecord(rec, orderToken);
      if (!record) throw new CartIntentUnavailableError(orderToken);
      assertCheckoutSessionOwner(record, checkoutSessionId);
      const res = await this.resolveLifecycle(rec, orderToken, record);
      if (res.kind === "purchased") {
        return { ...res.purchase, reconciled: true as const };
      }
      if (res.kind === "settling") {
        throw new CheckoutSettlingError({ orderToken });
      }
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
    const rec = this.options.recovery;
    if (!rec) return this.releaseCartStateless(orderToken);
    return this.recoveryLock(rec, `release:${orderToken}`, async () => {
      const record = await this.loadIntentRecord(rec, orderToken);
      if (!record) return this.releaseCartStateless(orderToken);
      assertCheckoutSessionOwner(record, checkoutSessionId);
      const res = await this.resolveLifecycle(rec, orderToken, record);
      if (res.kind === "purchased") {
        throw new ConsequenceMismatchError(
          "cart was purchased and cannot be released",
        );
      }
      if (res.kind === "closed-unpaid") return { released: true as const };
      if (res.kind === "settling")
        throw new CheckoutSettlingError({ orderToken });
      if (res.kind === "blocked") {
        throw new UnknownWriteOutcomeError(
          "AMC cart state is unresolved; release will not be dispatched",
        );
      }
      // open: dispatch OrderDelete exactly once behind a release marker.
      await rec.pending.mark({
        operation: "release",
        key: orderToken,
        intentHash: record.intentHash,
        dispatchedAt: this.now().toISOString(),
      });
      try {
        await this.options.executor.deleteCart(orderToken);
        await rec.pending.clear("release", orderToken);
        return { released: true as const };
      } catch (error) {
        if (!(error instanceof AmbiguousWriteError)) {
          await rec.pending.clear("release", orderToken);
          throw error;
        }
        let released = false;
        try {
          released = await this.options.executor.reconcileRelease(orderToken);
        } catch {
          released = false;
        }
        if (released) {
          await rec.pending.clear("release", orderToken);
          return { released: true as const };
        }
        throw new ReleaseOutcomeUnknownError(
          "OrderDelete outcome remains unknown; release will not be redispatched",
          { orderToken },
        );
      } finally {
        await this.releaseCheckout(orderToken).catch(() => undefined);
      }
    });
  }

  /**
   * Stateless release used when no durable journal is configured. Dispatches
   * OrderDelete at most once; on an ambiguous response it performs a bounded
   * read-only reconciliation of provider order state and returns released only
   * when the order proves cancelled/expired, otherwise throws a typed
   * ReleaseOutcomeUnknownError carrying only the order token. It never
   * redispatches a consequential write.
   */
  private async releaseCartStateless(
    orderToken: string,
  ): Promise<{ released: true }> {
    return this.singleFlight(`release:${orderToken}`, async () => {
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
    });
  }

  async inspectCart(orderToken: string, email: string): Promise<CartSnapshot> {
    requireNonEmpty(orderToken, "order token");
    requireEmail(email);
    const rec = this.options.recovery;
    if (rec) {
      const record = await this.loadIntentRecord(rec, orderToken);
      if (record) {
        // Recover the ORIGINAL intent and let ONE provider projection decide the
        // lifecycle. This is what makes token-first `checkout preview` (and the
        // fresh preview inside `checkout submit`) work in a new CLI process.
        const life = await this.options.projections.projectLifecycle(
          orderToken,
          { intent: record.intent, now: this.now() },
        );
        if (life.kind === "open" && life.cart) return clone(life.cart);
        // Purchased / closed / paid-ambiguous / drift must never be previewed
        // as an open cart.
        throw new CartNotResumableError(life.kind);
      }
    }
    // No recovery store, or no durable intent for this token: fall back to the
    // executor's own (same-process) projection. A genuinely unavailable intent
    // surfaces the actionable typed error rather than a low-level drift.
    return this.inspectCartWithoutIntent(orderToken, email);
  }

  private async inspectCartWithoutIntent(
    orderToken: string,
    email: string,
  ): Promise<CartSnapshot> {
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

  /**
   * Extend an open order's expiration. Direct-only and self-reconciling: the
   * executor dispatches at most once and re-reads the current expiry rather than
   * redispatching on an ambiguous transport failure.
   */
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

  async submitCheckout(input: {
    preview: CheckoutPreview;
    confirmationToken: string;
    email: string;
    vaultPointer: string;
  }): Promise<PurchaseResult & { reconciled: boolean }> {
    return this.singleFlight(input.preview.orderToken, async () => {
      const rec = this.options.recovery;
      if (!rec) return this.submitCheckoutLocked(input);
      const orderToken = input.preview.orderToken;
      return this.recoveryLock(rec, `checkout:${orderToken}`, async () => {
        const record = await this.loadIntentRecord(rec, orderToken);
        if (!record) return this.submitCheckoutLocked(input);
        // Resolve any unresolved prior fulfillment before dispatching again.
        const marker =
          (await rec.pending.load("purchase", orderToken)) ??
          (await rec.pending.load("purchase-challenge", orderToken));
        if (marker) {
          const res = await this.resolveLifecycle(rec, orderToken, record);
          if (res.kind === "purchased") {
            validatePurchase(res.purchase, input.preview);
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
        return this.submitCheckoutLocked(input, rec, record);
      });
    });
  }

  private async submitCheckoutLocked(
    input: {
      preview: CheckoutPreview;
      confirmationToken: string;
      email: string;
      vaultPointer: string;
    },
    rec?: CheckoutRecovery,
    record?: CartIntentRecord,
  ): Promise<PurchaseResult & { reconciled: boolean }> {
    validateCheckoutConfirmation(
      input.preview,
      input.confirmationToken,
      input.email,
      this.now(),
    );
    requireNonEmpty(input.vaultPointer, "vault pointer");
    const orderToken = input.preview.orderToken;
    if (this.options.readiness?.assertPrepared) {
      await this.options.readiness.assertPrepared(
        orderToken,
        input.vaultPointer,
      );
    } else {
      await this.prepareCheckout(orderToken, input.vaultPointer);
    }

    // Thread the durable intent so these pre-dispatch re-reads project the cart
    // in a fresh CLI process too (submit runs after a token-first preview).
    const submitIntent = record ? structuredClone(record.intent) : undefined;
    const beforeCard = await this.options.executor.inspectCart(
      orderToken,
      input.email,
      submitIntent,
    );
    assertCartMatchesPreview(beforeCard, input.preview, this.now());
    const payment = await this.options.payment.secureFill({
      orderToken,
      vaultPointer: input.vaultPointer,
    });
    const card = await this.options.payment.addCard({ orderToken, payment });

    const beforePurchase = await this.options.executor.inspectCart(
      orderToken,
      input.email,
      submitIntent,
    );
    assertCartMatchesPreview(beforePurchase, input.preview, this.now());
    if (rec && record) {
      await rec.pending.mark({
        operation: "purchase",
        key: orderToken,
        intentHash: record.intentHash,
        dispatchedAt: this.now().toISOString(),
      });
    }

    let purchase: PurchaseResult;
    let reconciled = false;
    try {
      purchase = await this.options.payment.purchase({
        orderToken,
        email: input.email,
        expectedTotal: input.preview.total,
        card,
      });
    } catch (error) {
      if (error instanceof PurchaseNotCompletedError) {
        if (rec) await rec.pending.clear("purchase", orderToken);
        await this.releaseCheckout(orderToken).catch(() => undefined);
        throw error;
      }
      if (!(error instanceof AmbiguousWriteError)) {
        // A definite typed rejection (e.g. 4xx / challenge): nothing executed.
        if (rec) await rec.pending.clear("purchase", orderToken);
        throw error;
      }
      let observed: PurchaseResult | null;
      try {
        observed = await this.options.payment.reconcilePurchase(
          orderToken,
          input.email,
        );
      } catch (reconcileError) {
        if (!(reconcileError instanceof PurchaseNotCompletedError))
          throw reconcileError;
        if (rec) await rec.pending.clear("purchase", orderToken);
        await this.releaseCheckout(orderToken).catch(() => undefined);
        throw reconcileError;
      }
      if (!observed) {
        // Keep the purchase marker: the bounded quiet window governs a later
        // reconcile rather than declaring a misleading "not purchased" now.
        throw new CheckoutOutcomeUnknownError(
          "OrderFulfill outcome remains unknown after reconciliation",
          { orderToken },
        );
      }
      purchase = observed;
      reconciled = true;
    }
    validatePurchase(purchase, input.preview);
    if (rec) await rec.pending.clear("purchase", orderToken);
    return { ...purchase, reconciled };
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
    const rec = this.options.recovery;
    const record = rec
      ? await this.loadIntentRecord(rec, input.checkoutPreview.orderToken)
      : null;
    const cart = await this.options.executor.inspectCart(
      input.checkoutPreview.orderToken,
      input.email,
      record ? structuredClone(record.intent) : undefined,
    );
    assertCartMatchesPreview(cart, input.checkoutPreview, this.now());
    return checkoutChallengePreview(cart, input.email, this.now());
  }

  async submitCheckoutChallenge(input: {
    preview: CheckoutChallengePreview;
    confirmationToken: string;
    email: string;
    vaultPointer: string;
  }): Promise<PurchaseResult & { reconciled: boolean }> {
    return this.singleFlight(input.preview.orderToken, async () => {
      const rec = this.options.recovery;
      if (!rec) return this.submitCheckoutChallengeLocked(input);
      const orderToken = input.preview.orderToken;
      return this.recoveryLock(rec, `checkout:${orderToken}`, async () => {
        const record = await this.loadIntentRecord(rec, orderToken);
        if (!record) return this.submitCheckoutChallengeLocked(input);
        const marker =
          (await rec.pending.load("purchase-challenge", orderToken)) ??
          (await rec.pending.load("purchase", orderToken));
        if (marker) {
          const res = await this.resolveLifecycle(rec, orderToken, record);
          if (res.kind === "purchased") {
            validatePurchase(
              res.purchase,
              challengeAsCheckoutPreview(input.preview),
            );
            return { ...res.purchase, reconciled: true };
          }
          if (res.kind === "settling") {
            throw new CheckoutSettlingError({ orderToken });
          }
          if (res.kind === "blocked") {
            throw new CheckoutOutcomeUnknownError(
              "AMC order state is unresolved; challenge fulfillment will not be redispatched",
              { orderToken },
            );
          }
        }
        return this.submitCheckoutChallengeLocked(input, rec, record);
      });
    });
  }

  private async submitCheckoutChallengeLocked(
    input: {
      preview: CheckoutChallengePreview;
      confirmationToken: string;
      email: string;
      vaultPointer: string;
    },
    rec?: CheckoutRecovery,
    record?: CartIntentRecord,
  ): Promise<PurchaseResult & { reconciled: boolean }> {
    validateCheckoutChallengeConfirmation(
      input.preview,
      input.confirmationToken,
      input.email,
      this.now(),
    );
    requireNonEmpty(input.vaultPointer, "vault pointer");
    const orderToken = input.preview.orderToken;
    const checkoutBinding = challengeAsCheckoutPreview(input.preview);

    const alreadyPurchased = await this.options.payment.reconcilePurchase(
      orderToken,
      input.email,
    );
    if (alreadyPurchased) {
      validatePurchase(alreadyPurchased, checkoutBinding);
      if (rec) await rec.pending.clear("purchase-challenge", orderToken);
      return { ...alreadyPurchased, reconciled: true };
    }

    const challengePayment = this.options.challengePayment;
    if (!challengePayment) throw new ChallengePaymentSetupError();
    const submitIntent = record ? structuredClone(record.intent) : undefined;
    const current = await this.options.executor.inspectCart(
      orderToken,
      input.email,
      submitIntent,
    );
    assertCartMatchesPreview(current, checkoutBinding, this.now());
    const payment = await challengePayment.secureFill({
      orderToken,
      vaultPointer: input.vaultPointer,
    });
    const card = await challengePayment.addCard({ orderToken, payment });

    const immediatelyBeforePurchase = await this.options.executor.inspectCart(
      orderToken,
      input.email,
      submitIntent,
    );
    assertCartMatchesPreview(
      immediatelyBeforePurchase,
      checkoutBinding,
      this.now(),
    );
    if (rec && record) {
      await rec.pending.mark({
        operation: "purchase-challenge",
        key: orderToken,
        intentHash: record.intentHash,
        dispatchedAt: this.now().toISOString(),
      });
    }

    let purchase: PurchaseResult;
    let reconciled = false;
    try {
      purchase = await challengePayment.purchase({
        orderToken,
        email: input.email,
        expectedTotal: input.preview.total,
        card,
      });
    } catch (error) {
      if (!(error instanceof AmbiguousWriteError)) {
        if (rec) await rec.pending.clear("purchase-challenge", orderToken);
        throw error;
      }
      const observed = await challengePayment.reconcilePurchase(
        orderToken,
        input.email,
      );
      if (!observed) {
        throw new CheckoutOutcomeUnknownError(
          "Challenge OrderFulfill outcome remains unknown after reconciliation",
          { orderToken },
        );
      }
      purchase = observed;
      reconciled = true;
    }
    validatePurchase(purchase, checkoutBinding);
    if (rec) await rec.pending.clear("purchase-challenge", orderToken);
    return { ...purchase, reconciled };
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
    return this.singleFlight(input.preview.orderToken, async () => {
      validateRefundConfirmation(
        input.preview,
        input.confirmationToken,
        input.email,
        this.now(),
      );
      const rec = this.options.recovery;
      if (!rec) return this.submitRefundLocked(input);
      const key = refundHash(
        input.preview.orderToken,
        input.preview.lineNumbers,
      );
      return this.recoveryLock(rec, `refund:${key}`, async () => {
        const marker = await rec.pending.load("refund", key);
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
          await rec.pending.clear("refund", key);
          return {
            orderId: input.preview.orderToken,
            status: verified.status,
            refundTotal: input.preview.refundTotal,
            nonRefundableFee: input.preview.nonRefundableFee,
            reconciled: true,
          };
        }
        return this.submitRefundLocked(input, rec, key);
      });
    });
  }

  private async submitRefundLocked(
    input: { preview: RefundPreview; confirmationToken: string; email: string },
    rec?: CheckoutRecovery,
    key?: string,
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
    const currentPreview = refundPreview(
      current,
      input.email,
      input.preview.lineNumbers,
      this.now(),
    );
    assertRefundMatchesPreview(currentPreview, input.preview);
    if (rec && key) {
      await rec.pending.mark({
        operation: "refund",
        key,
        intentHash: sha256(key),
        dispatchedAt: this.now().toISOString(),
      });
    }

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
        if (error instanceof AmbiguousWriteError) {
          // Keep the marker: a later submit reconciles from provider truth.
          throw new UnknownWriteOutcomeError(
            "AMC refund outcome remains unknown after reconciliation",
          );
        }
        if (rec && key) await rec.pending.clear("refund", key);
        throw error;
      }
    }
    verifyRefundPostcondition(verified, input.preview.lineNumbers);
    if (rec && key) await rec.pending.clear("refund", key);
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

/**
 * Duck-typed detection of the projection's "no bound cart intent" drift
 * (`AMC_ORDER_PROJECTION_ERROR` on `cart.intent`), kept provider-agnostic so
 * the service does not import a concrete projection implementation.
 */
function isMissingCartIntent(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "AMC_ORDER_PROJECTION_ERROR" &&
    error.field === "cart.intent"
  );
}

function assertCheckoutSessionOwner(
  record: { checkoutSessionId?: string },
  checkoutSessionId: string | undefined,
): void {
  if (checkoutSessionId === undefined && record.checkoutSessionId === undefined)
    return;
  if (record.checkoutSessionId !== checkoutSessionId)
    throw new CheckoutSessionOwnershipError();
}

function checkoutPreview(
  cart: CartSnapshot,
  email: string,
  now: Date,
): CheckoutPreview {
  validateOpenCart(cart, now);
  const unsigned: Omit<CheckoutPreview, "confirmationToken"> = {
    kind: "checkout",
    orderToken: cart.orderToken,
    showtimeId: cart.showtimeId,
    seats: clone(cart.seats),
    tickets: clone(cart.tickets),
    total: cart.total,
    expiresAt: cart.expiresAt,
    emailBinding: digest(email.trim().toLowerCase()),
    observedAt: now.toISOString(),
  };
  return { ...unsigned, confirmationToken: confirmation("checkout", unsigned) };
}

function checkoutChallengePreview(
  cart: CartSnapshot,
  email: string,
  now: Date,
): CheckoutChallengePreview {
  validateOpenCart(cart, now);
  const unsigned: Omit<CheckoutChallengePreview, "confirmationToken"> = {
    kind: "checkout-challenge",
    orderToken: cart.orderToken,
    showtimeId: cart.showtimeId,
    seats: clone(cart.seats),
    tickets: clone(cart.tickets),
    total: cart.total,
    expiresAt: cart.expiresAt,
    emailBinding: digest(email.trim().toLowerCase()),
    observedAt: now.toISOString(),
  };
  return {
    ...unsigned,
    confirmationToken: confirmation("checkout-challenge", unsigned),
  };
}

function refundPreview(
  order: RefundOrderSnapshot,
  email: string,
  lineNumbers: string[],
  now: Date,
): RefundPreview {
  validateRefundOrder(order);
  const selected = new Set(lineNumbers);
  if (selected.size !== lineNumbers.length) {
    throw new ConsequenceMismatchError("refund line numbers must be unique");
  }
  const selectedLines = lineNumbers.map((lineNumber) => {
    const line = order.lines.find(
      (candidate) => candidate.lineNumber === lineNumber,
    );
    if (!line || line.status !== "PAID") {
      throw new ConsequenceMismatchError(
        `refund line ${lineNumber} is not refundable`,
      );
    }
    return line;
  });
  const refundableLines = order.lines.filter((line) => line.status === "PAID");
  const refundCents = selectedLines.reduce(
    (total, line) => total + moneyToCents(line.refundableAmount),
    0,
  );
  const remainingCents = refundableLines
    .filter((line) => !selected.has(line.lineNumber))
    .reduce((total, line) => total + moneyToCents(line.refundableAmount), 0);
  const unsigned: Omit<RefundPreview, "confirmationToken"> = {
    kind: "refund",
    orderNumber: order.orderNumber,
    orderToken: order.orderToken,
    lineNumbers: [...lineNumbers],
    scope: selectedLines.length === refundableLines.length ? "full" : "partial",
    refundTotal: centsToMoney(refundCents),
    remainingRefundableTotal: centsToMoney(remainingCents),
    nonRefundableFee: order.nonRefundableFee,
    chargedTotal: order.chargedTotal,
    status: order.status,
    emailBinding: digest(email.trim().toLowerCase()),
    observedAt: now.toISOString(),
  };
  return { ...unsigned, confirmationToken: confirmation("refund", unsigned) };
}

function validateCartIntent(intent: CartCreateIntent): void {
  if (
    !/^\d+$/.test(intent.showtimeId) ||
    intent.holdAcknowledgement !== "CREATE_HOLD" ||
    typeof intent.waiveSubscriptionDiscounts !== "boolean" ||
    !validMoney(intent.expectedTotal) ||
    !Array.isArray(intent.seats) ||
    intent.seats.length === 0
  ) {
    throw new ConsequenceMismatchError("cart create intent drifted");
  }
  const names = new Set<string>();
  const coordinates = new Set<string>();
  for (const seat of intent.seats) {
    if (
      !seat.name ||
      !seat.sku ||
      !positiveInteger(seat.quantity) ||
      !positiveInteger(seat.row) ||
      !positiveInteger(seat.column) ||
      names.has(seat.name) ||
      coordinates.has(`${seat.row}:${seat.column}`)
    ) {
      throw new ConsequenceMismatchError("cart seat array drifted");
    }
    names.add(seat.name);
    coordinates.add(`${seat.row}:${seat.column}`);
  }
}

function validateCartAgainstIntent(
  cart: CartSnapshot,
  intent: CartCreateIntent,
  now: Date,
): void {
  validateOpenCart(cart, now);
  const expectedSeats = intent.seats.map(
    ({ quantity: _quantity, ...seat }) => seat,
  );
  // The provider-created cart's canonical `total` (its `remainingBalance`) is
  // AUTHORITATIVE and becomes the returned CartSnapshot.total and the checkout
  // handoff total. `intent.expectedTotal` is only a pre-cart seat-map estimate,
  // and AMC's authoritative created-cart total legitimately differs by theater
  // (e.g. per-theater fee/tax schedules), so it is NOT required to match here.
  // Seats, showtime, ticket SKU/aggregate quantity, and open/unexpired status
  // are still enforced exactly, and checkout submit still re-reads and consents
  // to the authoritative current cart total before any payment.
  if (
    cart.showtimeId !== intent.showtimeId ||
    canonical(cart.seats) !== canonical(expectedSeats) ||
    canonical(cart.tickets) !== canonical(aggregateTickets(intent))
  ) {
    throw new ConsequenceMismatchError(
      "created cart does not match acknowledged intent",
    );
  }
}

function validateOpenCart(cart: CartSnapshot, now: Date): void {
  if (
    !isRecord(cart) ||
    !nonEmpty(cart.orderToken) ||
    !/^\d+$/.test(cart.showtimeId) ||
    !validMoney(cart.total) ||
    !validTimestamp(cart.expiresAt) ||
    !validCartSeats(cart.seats) ||
    !validTickets(cart.tickets) ||
    cart.status !== "OPEN"
  ) {
    throw new ConsequenceMismatchError("cart projection drifted");
  }
  if (Date.parse(cart.expiresAt) <= now.valueOf()) {
    throw new ConsequenceMismatchError("cart is expired");
  }
}

function validateCheckoutConfirmation(
  preview: CheckoutPreview,
  provided: string,
  email: string,
  now: Date,
): void {
  validateCheckoutPreviewIntegrity(preview, email);
  const { confirmationToken: _token, ...unsigned } = preview;
  if (
    provided !== preview.confirmationToken ||
    provided !== confirmation("checkout", unsigned) ||
    stale(preview.observedAt, now) ||
    Date.parse(preview.expiresAt) <= now.valueOf()
  ) {
    throw new ConfirmationMismatchError(
      "checkout confirmation is stale or mismatched",
    );
  }
}

function validateCheckoutPreviewIntegrity(
  preview: CheckoutPreview,
  email: string,
): void {
  validateCheckoutPreviewShape(preview);
  const { confirmationToken: _token, ...unsigned } = preview;
  if (
    preview.confirmationToken !== confirmation("checkout", unsigned) ||
    preview.emailBinding !== digest(email.trim().toLowerCase())
  ) {
    throw new ConfirmationMismatchError("checkout confirmation is mismatched");
  }
}

function validateCheckoutChallengeConfirmation(
  preview: CheckoutChallengePreview,
  provided: string,
  email: string,
  now: Date,
): void {
  validateCheckoutChallengePreviewShape(preview);
  const { confirmationToken: _token, ...unsigned } = preview;
  if (
    provided !== preview.confirmationToken ||
    provided !== confirmation("checkout-challenge", unsigned) ||
    preview.emailBinding !== digest(email.trim().toLowerCase()) ||
    stale(preview.observedAt, now) ||
    Date.parse(preview.expiresAt) <= now.valueOf()
  ) {
    throw new ConfirmationMismatchError(
      "checkout challenge confirmation is stale or mismatched",
    );
  }
}

function assertCartMatchesPreview(
  cart: CartSnapshot,
  preview: CheckoutPreview,
  now: Date,
): void {
  validateOpenCart(cart, now);
  if (
    cart.orderToken !== preview.orderToken ||
    cart.showtimeId !== preview.showtimeId ||
    cart.total !== preview.total ||
    cart.expiresAt !== preview.expiresAt ||
    canonical(cart.seats) !== canonical(preview.seats) ||
    canonical(cart.tickets) !== canonical(preview.tickets)
  ) {
    throw new ConsequenceMismatchError(
      "fresh cart no longer matches checkout preview",
    );
  }
}

function validatePurchase(
  purchase: PurchaseResult,
  preview: CheckoutPreview,
): void {
  if (
    purchase.status !== "CONFIRMED" ||
    purchase.orderToken !== preview.orderToken ||
    purchase.chargedTotal !== preview.total ||
    !purchase.confirmationNumber
  ) {
    throw new PostconditionVerificationError(
      "purchase confirmation does not match preview",
    );
  }
}

function validateRefundLookup(
  orderNumber: string,
  email: string,
  lineNumbers: string[],
): void {
  requireNonEmpty(orderNumber, "order number");
  requireEmail(email);
  if (
    !Array.isArray(lineNumbers) ||
    lineNumbers.length === 0 ||
    lineNumbers.some((line) => !line)
  ) {
    throw new ConsequenceMismatchError("refund line numbers are required");
  }
}

function validateRefundOrder(order: RefundOrderSnapshot): void {
  if (
    !isRecord(order) ||
    !nonEmpty(order.orderNumber) ||
    !nonEmpty(order.orderToken) ||
    (order.status !== "CONFIRMED" &&
      order.status !== "REFUND_REQUESTED" &&
      order.status !== "REFUNDED") ||
    !validMoney(order.chargedTotal) ||
    !validMoney(order.nonRefundableFee) ||
    !Array.isArray(order.lines) ||
    order.lines.length === 0 ||
    order.lines.some(
      (line) =>
        !isRecord(line) ||
        !nonEmpty(line.lineNumber) ||
        !nonEmpty(line.label) ||
        !validMoney(line.refundableAmount) ||
        (line.status !== "PAID" &&
          line.status !== "REFUND_REQUESTED" &&
          line.status !== "REFUNDED"),
    ) ||
    new Set(order.lines.map((line) => line.lineNumber)).size !==
      order.lines.length
  ) {
    throw new ConsequenceMismatchError("refund order projection drifted");
  }
  const refundableCents = order.lines.reduce(
    (total, line) => total + moneyToCents(line.refundableAmount),
    0,
  );
  if (
    refundableCents + moneyToCents(order.nonRefundableFee) !==
    moneyToCents(order.chargedTotal)
  ) {
    throw new ConsequenceMismatchError(
      "refund totals do not reconcile to charged total",
    );
  }
}

function validateRefundConfirmation(
  preview: RefundPreview,
  provided: string,
  email: string,
  now: Date,
): void {
  validateRefundPreviewShape(preview);
  const { confirmationToken: _token, ...unsigned } = preview;
  if (
    provided !== preview.confirmationToken ||
    provided !== confirmation("refund", unsigned) ||
    preview.emailBinding !== digest(email.trim().toLowerCase()) ||
    stale(preview.observedAt, now)
  ) {
    throw new ConfirmationMismatchError(
      "refund confirmation is stale or mismatched",
    );
  }
}

function assertRefundMatchesPreview(
  current: RefundPreview,
  acknowledged: RefundPreview,
): void {
  const currentBinding = {
    ...current,
    observedAt: acknowledged.observedAt,
    confirmationToken: acknowledged.confirmationToken,
  };
  if (canonical(currentBinding) !== canonical(acknowledged)) {
    throw new ConsequenceMismatchError(
      "fresh refund consequence no longer matches preview",
    );
  }
}

function verifyRefundPostcondition(
  order: RefundOrderSnapshot,
  lineNumbers: string[],
): asserts order is RefundOrderSnapshot & {
  status: "REFUND_REQUESTED" | "REFUNDED";
} {
  validateRefundOrder(order);
  if (order.status !== "REFUND_REQUESTED" && order.status !== "REFUNDED") {
    throw new PostconditionVerificationError("refund request was not observed");
  }
  for (const lineNumber of lineNumbers) {
    const line = order.lines.find(
      (candidate) => candidate.lineNumber === lineNumber,
    );
    if (
      !line ||
      (line.status !== "REFUND_REQUESTED" && line.status !== "REFUNDED")
    ) {
      throw new PostconditionVerificationError(
        "refunded line state was not observed",
      );
    }
  }
}

function aggregateTickets(intent: CartCreateIntent): CartSnapshot["tickets"] {
  const quantities = new Map<string, number>();
  for (const seat of intent.seats) {
    quantities.set(seat.sku, (quantities.get(seat.sku) ?? 0) + seat.quantity);
  }
  return [...quantities].map(([sku, quantity]) => ({ sku, quantity }));
}

function cartIntentBinding(intent: CartCreateIntent): string {
  return digest(canonical(intent));
}

function confirmation(
  kind: "checkout" | "checkout-challenge" | "refund",
  value: unknown,
): string {
  return `${kind}:${digest(canonical(value))}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function stale(observedAt: string, now: Date): boolean {
  if (!validTimestamp(observedAt)) return true;
  const age = now.valueOf() - Date.parse(observedAt);
  return age < 0 || age > PREVIEW_MAX_AGE_MS;
}

function moneyToCents(value: Money): number {
  if (!validMoney(value))
    throw new ConsequenceMismatchError(`invalid money value`);
  const [whole, fraction] = value.split(".");
  return Number.parseInt(whole!, 10) * 100 + Number.parseInt(fraction!, 10);
}

function centsToMoney(value: number): Money {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}` as Money;
}

function validMoney(value: unknown): value is Money {
  return typeof value === "string" && /^(?:0|[1-9]\d*)\.\d{2}$/.test(value);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function requireEmail(value: string): void {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new ConsequenceMismatchError("valid email is required");
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConsequenceMismatchError(`${label} is required`);
  }
}

function validateCheckoutPreviewShape(preview: CheckoutPreview): void {
  if (
    !isRecord(preview) ||
    preview.kind !== "checkout" ||
    !nonEmpty(preview.orderToken) ||
    typeof preview.showtimeId !== "string" ||
    !/^\d+$/.test(preview.showtimeId) ||
    !validCartSeats(preview.seats) ||
    !validTickets(preview.tickets) ||
    !validMoney(preview.total) ||
    !validTimestamp(preview.expiresAt) ||
    !/^[a-f0-9]{64}$/.test(preview.emailBinding) ||
    !validTimestamp(preview.observedAt) ||
    !nonEmpty(preview.confirmationToken)
  ) {
    throw new ConfirmationMismatchError("checkout preview shape drifted");
  }
}

function validateCheckoutChallengePreviewShape(
  preview: CheckoutChallengePreview,
): void {
  const checkout = challengeAsCheckoutPreview(preview);
  validateCheckoutPreviewShape(checkout);
  if (preview.kind !== "checkout-challenge") {
    throw new ConfirmationMismatchError(
      "checkout challenge preview shape drifted",
    );
  }
}

function challengeAsCheckoutPreview(
  preview: CheckoutChallengePreview,
): CheckoutPreview {
  return {
    ...preview,
    kind: "checkout",
    confirmationToken: preview.confirmationToken,
  };
}

function validateRefundPreviewShape(preview: RefundPreview): void {
  if (
    !isRecord(preview) ||
    preview.kind !== "refund" ||
    !nonEmpty(preview.orderNumber) ||
    !nonEmpty(preview.orderToken) ||
    !Array.isArray(preview.lineNumbers) ||
    preview.lineNumbers.length === 0 ||
    preview.lineNumbers.some((line) => !nonEmpty(line)) ||
    new Set(preview.lineNumbers).size !== preview.lineNumbers.length ||
    (preview.scope !== "full" && preview.scope !== "partial") ||
    !validMoney(preview.refundTotal) ||
    !validMoney(preview.remainingRefundableTotal) ||
    !validMoney(preview.nonRefundableFee) ||
    !validMoney(preview.chargedTotal) ||
    (preview.status !== "CONFIRMED" &&
      preview.status !== "REFUND_REQUESTED" &&
      preview.status !== "REFUNDED") ||
    !/^[a-f0-9]{64}$/.test(preview.emailBinding) ||
    !validTimestamp(preview.observedAt) ||
    !nonEmpty(preview.confirmationToken)
  ) {
    throw new ConfirmationMismatchError("refund preview shape drifted");
  }
}

function validCartSeats(value: unknown): value is CartSnapshot["seats"] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const names = new Set<string>();
  const coordinates = new Set<string>();
  for (const seat of value) {
    if (
      !isRecord(seat) ||
      !nonEmpty(seat.name) ||
      !nonEmpty(seat.sku) ||
      !positiveInteger(seat.row) ||
      !positiveInteger(seat.column) ||
      names.has(seat.name) ||
      coordinates.has(`${seat.row}:${seat.column}`)
    ) {
      return false;
    }
    names.add(seat.name);
    coordinates.add(`${seat.row}:${seat.column}`);
  }
  return true;
}

function validTickets(value: unknown): value is CartSnapshot["tickets"] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (ticket) =>
        isRecord(ticket) &&
        nonEmpty(ticket.sku) &&
        positiveInteger(ticket.quantity),
    ) &&
    new Set(value.map((ticket) => ticket.sku)).size === value.length
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
