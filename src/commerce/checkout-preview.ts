import { sha256 } from "./intent-identity";
import {
  CartCreateIntent,
  CartSnapshot,
  Money,
  PurchaseResult,
  RefundOrderSnapshot,
} from "./executor";
import {
  CheckoutChallengePreview,
  CheckoutPreview,
  CheckoutSessionOwnershipError,
  ConfirmationMismatchError,
  ConsequenceMismatchError,
  PostconditionVerificationError,
  RefundPreview,
} from "./service";

// Pure preview/confirmation/consequence-validation + money helpers for
// AmcCommerceService. Cross-imports with ./service are deferred (used only in
// function bodies), so the module cycle resolves cleanly.

const PREVIEW_MAX_AGE_MS = 2 * 60 * 1000;

export function isMissingCartIntent(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "AMC_ORDER_PROJECTION_ERROR" &&
    error.field === "cart.intent"
  );
}

export function assertCheckoutSessionOwner(
  record: { checkoutSessionId?: string },
  checkoutSessionId: string | undefined,
): void {
  if (checkoutSessionId === undefined && record.checkoutSessionId === undefined)
    return;
  if (record.checkoutSessionId !== checkoutSessionId)
    throw new CheckoutSessionOwnershipError();
}

export function checkoutPreview(
  cart: CartSnapshot,
  email: string,
  now: Date,
): CheckoutPreview {
  return buildCheckoutPreview("checkout", cart, email, now) as CheckoutPreview;
}

export function checkoutChallengePreview(
  cart: CartSnapshot,
  email: string,
  now: Date,
): CheckoutChallengePreview {
  return buildCheckoutPreview(
    "checkout-challenge",
    cart,
    email,
    now,
  ) as CheckoutChallengePreview;
}

function buildCheckoutPreview(
  kind: "checkout" | "checkout-challenge",
  cart: CartSnapshot,
  email: string,
  now: Date,
): CheckoutPreview | CheckoutChallengePreview {
  validateOpenCart(cart, now);
  const unsigned = {
    kind,
    orderToken: cart.orderToken,
    showtimeId: cart.showtimeId,
    seats: clone(cart.seats),
    tickets: clone(cart.tickets),
    total: cart.total,
    expiresAt: cart.expiresAt,
    emailBinding: sha256(email.trim().toLowerCase()),
    observedAt: now.toISOString(),
  };
  return { ...unsigned, confirmationToken: confirmation(kind, unsigned) };
}

export function refundPreview(
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
    emailBinding: sha256(email.trim().toLowerCase()),
    observedAt: now.toISOString(),
  };
  return { ...unsigned, confirmationToken: confirmation("refund", unsigned) };
}

export function validateCartIntent(intent: CartCreateIntent): void {
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

export function validateCartAgainstIntent(
  cart: CartSnapshot,
  intent: CartCreateIntent,
  now: Date,
): void {
  validateOpenCart(cart, now);
  const expectedSeats = intent.seats.map(
    ({ quantity: _quantity, ...seat }) => seat,
  );
  // The provider cart total is authoritative (differs from the estimate by
  // theater) and is NOT matched; seats/showtime/tickets/open status are.
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

export function validateOpenCart(cart: CartSnapshot, now: Date): void {
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

export function validateCheckoutConfirmation(
  preview: CheckoutPreview,
  provided: string,
  email: string,
  now: Date,
): void {
  assertCheckoutConfirmed("checkout", preview, provided, email, now);
}

export function validateCheckoutChallengeConfirmation(
  preview: CheckoutChallengePreview,
  provided: string,
  email: string,
  now: Date,
): void {
  assertCheckoutConfirmed("checkout-challenge", preview, provided, email, now);
}

/** Shared shape + confirmation-token + email + freshness + expiry gate. */
function assertCheckoutConfirmed(
  kind: "checkout" | "checkout-challenge",
  preview: CheckoutPreview | CheckoutChallengePreview,
  provided: string,
  email: string,
  now: Date,
): void {
  if (kind === "checkout")
    validateCheckoutPreviewShape(preview as CheckoutPreview);
  else
    validateCheckoutChallengePreviewShape(preview as CheckoutChallengePreview);
  const { confirmationToken: _token, ...unsigned } = preview;
  if (
    provided !== preview.confirmationToken ||
    provided !== confirmation(kind, unsigned) ||
    preview.emailBinding !== sha256(email.trim().toLowerCase()) ||
    stale(preview.observedAt, now) ||
    Date.parse(preview.expiresAt) <= now.valueOf()
  ) {
    throw new ConfirmationMismatchError(
      `${kind} confirmation is stale or mismatched`,
    );
  }
}

/** Shape + confirmation-token + email integrity, without freshness/expiry. */
export function validateCheckoutPreviewIntegrity(
  preview: CheckoutPreview,
  email: string,
): void {
  validateCheckoutPreviewShape(preview);
  const { confirmationToken: _token, ...unsigned } = preview;
  if (
    preview.confirmationToken !== confirmation("checkout", unsigned) ||
    preview.emailBinding !== sha256(email.trim().toLowerCase())
  ) {
    throw new ConfirmationMismatchError("checkout confirmation is mismatched");
  }
}

export function assertCartMatchesPreview(
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

export function validatePurchase(
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

export function validateRefundLookup(
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

export function validateRefundConfirmation(
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
    preview.emailBinding !== sha256(email.trim().toLowerCase()) ||
    stale(preview.observedAt, now)
  ) {
    throw new ConfirmationMismatchError(
      "refund confirmation is stale or mismatched",
    );
  }
}

export function assertRefundMatchesPreview(
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

export function verifyRefundPostcondition(
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

export function cartIntentBinding(intent: CartCreateIntent): string {
  return sha256(canonical(intent));
}

function confirmation(
  kind: "checkout" | "checkout-challenge" | "refund",
  value: unknown,
): string {
  return `${kind}:${sha256(canonical(value))}`;
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

export function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function requireEmail(value: string): void {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    throw new ConsequenceMismatchError("valid email is required");
  }
}

export function requireNonEmpty(value: string, label: string): void {
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
  validateCheckoutPreviewShape(checkoutBinding(preview));
  if (preview.kind !== "checkout-challenge") {
    throw new ConfirmationMismatchError(
      "checkout challenge preview shape drifted",
    );
  }
}

/** Normalize either preview kind to the checkout shape shared validators use. */
export function checkoutBinding(
  preview: CheckoutPreview | CheckoutChallengePreview,
): CheckoutPreview {
  return preview.kind === "checkout"
    ? preview
    : { ...preview, kind: "checkout" };
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

export function clone<T>(value: T): T {
  return structuredClone(value);
}
