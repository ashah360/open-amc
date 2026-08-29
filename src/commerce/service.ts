import { createHash } from "node:crypto";
import {
  CheckoutAttempt,
  CheckoutJournal,
  RefundAttempt,
} from "./checkout-journal";
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

export interface AmcCommerceServiceOptions {
  executor: CommerceExecutor;
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
  journal?: CheckoutJournal;
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
    const journal = this.options.journal;
    if (!journal) return null;
    requireEmail(input.email);
    const attempt = await journal.loadBySelection(
      input.showtimeId,
      input.seatNames,
    );
    if (!attempt) return null;
    assertCheckoutSessionOwner(attempt, input.checkoutSessionId);
    return journal.withIntentLock(attempt.intent, async () => {
      const current = await journal.loadBySelection(
        input.showtimeId,
        input.seatNames,
      );
      if (!current)
        throw new UnknownWriteOutcomeError(
          "AMC checkout journal entry disappeared",
        );
      assertCheckoutSessionOwner(current, input.checkoutSessionId);
      if (current.orderToken) {
        let purchased: PurchaseResult | null;
        try {
          purchased = await this.options.payment.reconcilePurchase(
            current.orderToken,
            input.email,
          );
        } catch (error) {
          if (!(error instanceof PurchaseNotCompletedError)) throw error;
          await journal.save({
            ...current,
            state: "NOT_PURCHASED",
            updatedAt: this.now().toISOString(),
          });
          await this.releaseCheckout(current.orderToken).catch(() => undefined);
          throw error;
        }
        if (purchased) {
          if (
            purchased.orderToken !== current.orderToken ||
            purchased.chargedTotal !== current.intent.expectedTotal ||
            !purchased.confirmationNumber
          ) {
            throw new ConsequenceMismatchError(
              "recovered purchase does not match journal intent",
            );
          }
          await journal.save({
            ...current,
            state: "CONFIRMED",
            confirmationNumber: purchased.confirmationNumber,
            chargedTotal: purchased.chargedTotal,
            updatedAt: this.now().toISOString(),
          });
          return {
            kind: "confirmed" as const,
            purchase: { ...purchased, reconciled: true as const },
          };
        }
      }
      if (
        (current.state === "CART_TOKEN_RECEIVED" ||
          current.state === "CART_OPEN") &&
        current.orderToken
      ) {
        const cart = await this.options.executor.inspectCart(
          current.orderToken,
          input.email,
          current.intent,
        );
        validateCartAgainstIntent(cart, current.intent, this.now());
        await journal.save({
          ...current,
          state: "CART_OPEN",
          updatedAt: this.now().toISOString(),
        });
        return { kind: "cart" as const, cart: clone(cart) };
      }
      if (current.state === "PREPARED") return null;
      throw new UnknownWriteOutcomeError(
        `AMC checkout attempt is ${current.state}; no write will be repeated`,
      );
    });
  }

  async createCart(
    intent: CartCreateIntent,
    checkoutSessionId?: string,
  ): Promise<CartSnapshot> {
    validateCartIntent(intent);
    const binding = cartIntentBinding(intent);
    const key = `cart:${binding}`;
    return this.singleFlight(key, async () => {
      const journal = this.options.journal;
      if (!journal) {
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
      return journal.withIntentLock(intent, async () => {
        let existing =
          (await journal.load(intent)) ??
          (await journal.loadByMutation(intent));
        if (existing?.state === "RELEASED") {
          await journal.resetReleased(existing);
          existing = null;
        } else if (existing?.state === "NOT_PURCHASED") {
          await journal.resetNotPurchased(existing);
          existing = null;
        }
        if (existing) assertCheckoutSessionOwner(existing, checkoutSessionId);
        if (
          (existing?.state === "CART_TOKEN_RECEIVED" ||
            existing?.state === "CART_OPEN") &&
          existing.orderToken
        ) {
          const recovered = await this.options.executor.inspectCart(
            existing.orderToken,
            "",
            intent,
          );
          validateCartAgainstIntent(recovered, intent, this.now());
          await journal.save({
            ...existing,
            state: "CART_OPEN",
            updatedAt: this.now().toISOString(),
          });
          return clone(recovered);
        }
        if (existing && existing.state !== "PREPARED") {
          throw new UnknownWriteOutcomeError(
            `AMC checkout attempt is ${existing.state}; cart creation will not be repeated`,
          );
        }
        const attemptBinding = journal.attemptId(intent);
        await this.prepareCheckout(attemptBinding);
        const base: CheckoutAttempt = existing ?? {
          version: 1,
          attemptId: journal.attemptId(intent),
          state: "PREPARED",
          intent: clone(intent),
          updatedAt: this.now().toISOString(),
          ...(checkoutSessionId ? { checkoutSessionId } : {}),
        };
        if (!existing) await journal.save(base);
        await journal.save({
          ...base,
          state: "CART_DISPATCHING",
          updatedAt: this.now().toISOString(),
        });
        let knownToken: string | null = null;
        try {
          const cart = await this.dispatchCart(intent, async (orderToken) => {
            knownToken = orderToken;
            await this.bindCheckout(attemptBinding, orderToken);
            await journal.save({
              ...base,
              state: "CART_TOKEN_RECEIVED",
              orderToken,
              updatedAt: this.now().toISOString(),
            });
          });
          await journal.save({
            ...base,
            state: "CART_OPEN",
            orderToken: cart.orderToken,
            updatedAt: this.now().toISOString(),
          });
          return cart;
        } catch (error) {
          if (knownToken === null) await this.releaseCheckout(attemptBinding);
          await journal.save({
            ...base,
            state: knownToken ? "CART_TOKEN_RECEIVED" : "UNKNOWN",
            ...(knownToken ? { orderToken: knownToken } : {}),
            updatedAt: this.now().toISOString(),
          });
          if (knownToken !== null)
            throw this.cartHoldStranded(knownToken, intent);
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

  async releaseCart(
    orderToken: string,
    checkoutSessionId?: string,
  ): Promise<{ released: true }> {
    requireNonEmpty(orderToken, "order token");
    const journal = this.options.journal;
    if (!journal) return this.releaseCartStateless(orderToken);
    const attempt = await journal.loadByOrderToken(orderToken);
    if (!attempt)
      throw new UnknownWriteOutcomeError("AMC cart is not journaled");
    assertCheckoutSessionOwner(attempt, checkoutSessionId);
    return journal.withIntentLock(attempt.intent, async () => {
      const current = await journal.loadByOrderToken(orderToken);
      if (!current)
        throw new UnknownWriteOutcomeError(
          "AMC checkout journal entry disappeared",
        );
      assertCheckoutSessionOwner(current, checkoutSessionId);
      if (current.state === "RELEASED") return { released: true as const };
      if (current.state === "RELEASE_DISPATCHING") {
        throw new UnknownWriteOutcomeError(
          "OrderDelete outcome remains unknown; release will not be redispatched",
        );
      }
      if (
        current.state !== "CART_OPEN" &&
        current.state !== "CART_TOKEN_RECEIVED"
      ) {
        throw new ConsequenceMismatchError(
          `AMC cart cannot be released from checkout state ${current.state}`,
        );
      }
      await journal.save({
        ...current,
        state: "RELEASE_DISPATCHING",
        updatedAt: this.now().toISOString(),
      });
      try {
        await this.options.executor.deleteCart(orderToken);
        await journal.save({
          ...current,
          state: "RELEASED",
          updatedAt: this.now().toISOString(),
        });
        return { released: true as const };
      } catch {
        throw new UnknownWriteOutcomeError(
          "OrderDelete outcome remains unknown; release will not be redispatched",
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
    const cart = await this.options.executor.inspectCart(orderToken, email);
    validateOpenCart(cart, this.now());
    return clone(cart);
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
      const journal = this.options.journal;
      if (!journal) return this.submitCheckoutLocked(input);
      const attempt = await journal.loadByOrderToken(input.preview.orderToken);
      if (!attempt) return this.submitCheckoutLocked(input);
      return journal.withIntentLock(attempt.intent, async () => {
        const current = await journal.loadByOrderToken(
          input.preview.orderToken,
        );
        if (!current)
          throw new UnknownWriteOutcomeError(
            "AMC checkout journal entry disappeared",
          );
        if (current.state === "CONFIRMED") {
          const observed = await this.options.payment.reconcilePurchase(
            input.preview.orderToken,
            input.email,
          );
          if (!observed) {
            throw new UnknownWriteOutcomeError(
              "Recorded AMC purchase is not provider-confirmed",
            );
          }
          validatePurchase(observed, input.preview);
          return { ...observed, reconciled: true };
        }
        if (current.state === "PURCHASE_DISPATCHING") {
          let observed: PurchaseResult | null;
          try {
            observed = await this.options.payment.reconcilePurchase(
              input.preview.orderToken,
              input.email,
            );
          } catch (error) {
            if (!(error instanceof PurchaseNotCompletedError)) throw error;
            await journal.save({
              ...current,
              state: "NOT_PURCHASED",
              updatedAt: this.now().toISOString(),
            });
            await this.releaseCheckout(input.preview.orderToken).catch(
              () => undefined,
            );
            throw error;
          }
          if (!observed) {
            throw new UnknownWriteOutcomeError(
              "OrderFulfill outcome remains unknown after restart reconciliation",
            );
          }
          validatePurchase(observed, input.preview);
          await journal.save({
            ...current,
            state: "CONFIRMED",
            confirmationNumber: observed.confirmationNumber,
            chargedTotal: observed.chargedTotal,
            updatedAt: this.now().toISOString(),
          });
          return { ...observed, reconciled: true };
        }
        if (current.state !== "CART_OPEN") {
          throw new UnknownWriteOutcomeError(
            `AMC checkout attempt is ${current.state}; fulfillment will not be dispatched`,
          );
        }
        return this.submitCheckoutLocked(input, journal, current);
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
    journal?: CheckoutJournal,
    attempt?: CheckoutAttempt,
  ): Promise<PurchaseResult & { reconciled: boolean }> {
    validateCheckoutConfirmation(
      input.preview,
      input.confirmationToken,
      input.email,
      this.now(),
    );
    requireNonEmpty(input.vaultPointer, "vault pointer");
    if (this.options.readiness?.assertPrepared) {
      await this.options.readiness.assertPrepared(
        input.preview.orderToken,
        input.vaultPointer,
      );
    } else {
      await this.prepareCheckout(input.preview.orderToken, input.vaultPointer);
    }

    const beforeCard = await this.options.executor.inspectCart(
      input.preview.orderToken,
      input.email,
    );
    assertCartMatchesPreview(beforeCard, input.preview, this.now());
    const payment = await this.options.payment.secureFill({
      orderToken: input.preview.orderToken,
      vaultPointer: input.vaultPointer,
    });
    const card = await this.options.payment.addCard({
      orderToken: input.preview.orderToken,
      payment,
    });

    const beforePurchase = await this.options.executor.inspectCart(
      input.preview.orderToken,
      input.email,
    );
    assertCartMatchesPreview(beforePurchase, input.preview, this.now());
    if (journal && attempt) {
      await journal.save({
        ...attempt,
        state: "PURCHASE_DISPATCHING",
        updatedAt: this.now().toISOString(),
      });
    }

    let purchase: PurchaseResult;
    let reconciled = false;
    try {
      purchase = await this.options.payment.purchase({
        orderToken: input.preview.orderToken,
        email: input.email,
        expectedTotal: input.preview.total,
        card,
      });
    } catch (error) {
      if (error instanceof PurchaseNotCompletedError) {
        if (journal && attempt) {
          await journal.save({
            ...attempt,
            state: "NOT_PURCHASED",
            orderToken: input.preview.orderToken,
            updatedAt: this.now().toISOString(),
          });
        }
        await this.releaseCheckout(input.preview.orderToken).catch(
          () => undefined,
        );
        throw error;
      }
      if (!(error instanceof AmbiguousWriteError)) throw error;
      let observed: PurchaseResult | null;
      try {
        observed = await this.options.payment.reconcilePurchase(
          input.preview.orderToken,
          input.email,
        );
      } catch (reconcileError) {
        if (!(reconcileError instanceof PurchaseNotCompletedError))
          throw reconcileError;
        if (journal && attempt) {
          await journal.save({
            ...attempt,
            state: "NOT_PURCHASED",
            orderToken: input.preview.orderToken,
            updatedAt: this.now().toISOString(),
          });
        }
        await this.releaseCheckout(input.preview.orderToken).catch(
          () => undefined,
        );
        throw reconcileError;
      }
      if (!observed) {
        throw new UnknownWriteOutcomeError(
          "OrderFulfill outcome remains unknown after reconciliation",
        );
      }
      purchase = observed;
      reconciled = true;
    }
    validatePurchase(purchase, input.preview);
    if (journal && attempt) {
      await journal.save({
        ...attempt,
        state: "CONFIRMED",
        confirmationNumber: purchase.confirmationNumber,
        chargedTotal: purchase.chargedTotal,
        updatedAt: this.now().toISOString(),
      });
    }
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
    const cart = await this.options.executor.inspectCart(
      input.checkoutPreview.orderToken,
      input.email,
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
      const journal = this.options.journal;
      if (!journal) return this.submitCheckoutChallengeLocked(input);
      const attempt = await journal.loadByOrderToken(input.preview.orderToken);
      if (!attempt) return this.submitCheckoutChallengeLocked(input);
      return journal.withIntentLock(attempt.intent, async () => {
        const current = await journal.loadByOrderToken(
          input.preview.orderToken,
        );
        if (!current)
          throw new UnknownWriteOutcomeError(
            "AMC checkout journal entry disappeared",
          );
        const challengePayment = this.options.challengePayment;
        if (!challengePayment) throw new ChallengePaymentSetupError();
        if (current.state === "PURCHASE_CHALLENGE_DISPATCHING") {
          const observed = await challengePayment.reconcilePurchase(
            input.preview.orderToken,
            input.email,
          );
          if (!observed) {
            throw new UnknownWriteOutcomeError(
              "Challenge OrderFulfill outcome remains unknown after restart reconciliation",
            );
          }
          validatePurchase(observed, challengeAsCheckoutPreview(input.preview));
          await journal.save({
            ...current,
            state: "CONFIRMED",
            confirmationNumber: observed.confirmationNumber,
            chargedTotal: observed.chargedTotal,
            updatedAt: this.now().toISOString(),
          });
          return { ...observed, reconciled: true };
        }
        if (current.state !== "CART_OPEN") {
          throw new UnknownWriteOutcomeError(
            `AMC checkout attempt is ${current.state}; challenge fulfillment will not be dispatched`,
          );
        }
        return this.submitCheckoutChallengeLocked(input, journal, current);
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
    journal?: CheckoutJournal,
    attempt?: CheckoutAttempt,
  ): Promise<PurchaseResult & { reconciled: boolean }> {
    validateCheckoutChallengeConfirmation(
      input.preview,
      input.confirmationToken,
      input.email,
      this.now(),
    );
    requireNonEmpty(input.vaultPointer, "vault pointer");

    const alreadyPurchased = await this.options.payment.reconcilePurchase(
      input.preview.orderToken,
      input.email,
    );
    const checkoutBinding = challengeAsCheckoutPreview(input.preview);
    if (alreadyPurchased) {
      validatePurchase(alreadyPurchased, checkoutBinding);
      return { ...alreadyPurchased, reconciled: true };
    }

    const challengePayment = this.options.challengePayment;
    if (!challengePayment) throw new ChallengePaymentSetupError();
    const current = await this.options.executor.inspectCart(
      input.preview.orderToken,
      input.email,
    );
    assertCartMatchesPreview(current, checkoutBinding, this.now());
    const payment = await challengePayment.secureFill({
      orderToken: input.preview.orderToken,
      vaultPointer: input.vaultPointer,
    });
    const card = await challengePayment.addCard({
      orderToken: input.preview.orderToken,
      payment,
    });

    const immediatelyBeforePurchase = await this.options.executor.inspectCart(
      input.preview.orderToken,
      input.email,
    );
    assertCartMatchesPreview(
      immediatelyBeforePurchase,
      checkoutBinding,
      this.now(),
    );
    if (journal && attempt) {
      await journal.save({
        ...attempt,
        state: "PURCHASE_CHALLENGE_DISPATCHING",
        updatedAt: this.now().toISOString(),
      });
    }

    let purchase: PurchaseResult;
    let reconciled = false;
    try {
      purchase = await challengePayment.purchase({
        orderToken: input.preview.orderToken,
        email: input.email,
        expectedTotal: input.preview.total,
        card,
      });
    } catch (error) {
      if (!(error instanceof AmbiguousWriteError)) throw error;
      const observed = await challengePayment.reconcilePurchase(
        input.preview.orderToken,
        input.email,
      );
      if (!observed) {
        throw new UnknownWriteOutcomeError(
          "Challenge OrderFulfill outcome remains unknown after reconciliation",
        );
      }
      purchase = observed;
      reconciled = true;
    }
    validatePurchase(purchase, checkoutBinding);
    if (journal && attempt) {
      await journal.save({
        ...attempt,
        state: "CONFIRMED",
        confirmationNumber: purchase.confirmationNumber,
        chargedTotal: purchase.chargedTotal,
        updatedAt: this.now().toISOString(),
      });
    }
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
      const journal = this.options.journal;
      if (!journal) return this.submitRefundLocked(input);
      return journal.withRefundLock(
        input.preview.orderToken,
        input.preview.lineNumbers,
        async () => {
          const existing = await journal.loadRefund(
            input.preview.orderToken,
            input.preview.lineNumbers,
          );
          if (
            existing?.state === "REFUND_DISPATCHING" ||
            existing?.state === "REFUND_OBSERVED"
          ) {
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
            await journal.saveRefund({
              ...existing,
              state: "REFUND_OBSERVED",
              updatedAt: this.now().toISOString(),
            });
            return {
              orderId: input.preview.orderToken,
              status: verified.status,
              refundTotal: existing.refundTotal,
              nonRefundableFee: existing.nonRefundableFee,
              reconciled: true,
            };
          }
          const attempt: RefundAttempt = existing ?? {
            version: 1,
            state: "REFUND_PREPARED",
            orderToken: input.preview.orderToken,
            orderNumber: input.preview.orderNumber,
            lineNumbers: [...input.preview.lineNumbers],
            refundTotal: input.preview.refundTotal,
            nonRefundableFee: input.preview.nonRefundableFee,
            updatedAt: this.now().toISOString(),
          };
          return this.submitRefundLocked(input, journal, attempt);
        },
      );
    });
  }

  private async submitRefundLocked(
    input: { preview: RefundPreview; confirmationToken: string; email: string },
    journal?: CheckoutJournal,
    attempt?: RefundAttempt,
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
    if (journal && attempt) {
      await journal.saveRefund({
        ...attempt,
        state: "REFUND_DISPATCHING",
        updatedAt: this.now().toISOString(),
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
          throw new UnknownWriteOutcomeError(
            "AMC refund outcome remains unknown after reconciliation",
          );
        }
        throw error;
      }
    }
    verifyRefundPostcondition(verified, input.preview.lineNumbers);
    if (journal && attempt) {
      await journal.saveRefund({
        ...attempt,
        state: "REFUND_OBSERVED",
        updatedAt: this.now().toISOString(),
      });
    }
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

function assertCheckoutSessionOwner(
  attempt: CheckoutAttempt,
  checkoutSessionId: string | undefined,
): void {
  if (
    checkoutSessionId === undefined &&
    attempt.checkoutSessionId === undefined
  )
    return;
  if (attempt.checkoutSessionId !== checkoutSessionId)
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
  if (
    cart.showtimeId !== intent.showtimeId ||
    cart.total !== intent.expectedTotal ||
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
