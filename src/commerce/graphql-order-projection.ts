import { GraphqlEnvelope } from "./contracts";
import {
  CartCreateIntent,
  CartSnapshot,
  Money,
  PurchaseNotCompletedError,
  PurchaseResult,
  RefundLineSnapshot,
  RefundOrderSnapshot,
} from "./executor";
import { AmcCommerceProjectionProvider } from "./graphql-executor";

export const ORDER_PROJECTION_DOCUMENT = `query OrderProjection($token: String!) {
  viewer {
    order(token: $token) {
      token
      orderId
      status
      email
      paid
      total
      feesTotal
      refundableTotal
      refundableType
      remainingBalance
      expirationDateUtc
      isRefunded
      groups {
        confirmationCode
        reservedSeats
        feesTotal
        subtotal
        tax
        total
        type
        showtime { showtimeId }
        items {
          sku
          name
          quantity
          cost
          tax
          lineItems {
            lineNumber
            seatName
            cost
            tax
            refundableDiscount
            refundableStatus {
              isRefunded
              selfServiceRefundable
              nonSelfServiceRefundableReason
            }
          }
        }
      }
      refundedPaymentGroups {
        isPending
        refundStatus
        refundDateUtc
        refundedPayments { amount }
      }
      error { message }
    }
  }
}`;

export class AmcOrderProjectionError extends Error {
  readonly code = "AMC_ORDER_PROJECTION_ERROR";
  constructor(readonly field: string) {
    super(`AMC GraphQL order projection drifted (${field})`);
  }
}

export interface AmcGraphOrderReader {
  read(envelope: GraphqlEnvelope<{ token: string }>): Promise<unknown>;
}

export class AmcGraphqlOrderProjectionProvider implements AmcCommerceProjectionProvider {
  private readonly intents = new Map<string, CartCreateIntent>();

  constructor(private readonly graph: AmcGraphOrderReader) {}

  assertReady(): void {}

  async inspectCart(
    orderToken: string,
    email?: string,
    intent?: CartCreateIntent,
  ): Promise<CartSnapshot> {
    if (intent) this.intents.set(orderToken, cloneIntent(intent));
    const bound = intent ?? this.intents.get(orderToken);
    if (!bound) throw new AmcOrderProjectionError("cart.intent");
    const order = await this.readOrder(orderToken);
    return cartSnapshot(order, orderToken, bound);
  }

  reconcileCart(): Promise<CartSnapshot | null> {
    // OrderCreate does not accept a client token. A lost response cannot be
    // mapped to the generated provider token without inventing identity.
    return Promise.resolve(null);
  }

  async projectRefundOrder(input: {
    orderNumber: string;
    email: string;
    orderToken: string;
  }): Promise<RefundOrderSnapshot> {
    const order = await this.readOrder(input.orderToken);
    requireEmail(order, input.email);
    return refundSnapshot(order, input);
  }

  async projectPurchase(input: {
    orderToken: string;
    email: string;
    expectedTotal: Money;
  }): Promise<PurchaseResult> {
    const order = await this.readOrder(input.orderToken);
    requireEmail(order, input.email);
    const result = purchaseResult(order, input.orderToken);
    if (!result || result.chargedTotal !== input.expectedTotal) {
      throw new AmcOrderProjectionError("purchase.total");
    }
    return result;
  }

  async reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null> {
    const order = await this.readOrder(orderToken);
    requireEmail(order, email);
    return purchaseResult(order, orderToken);
  }

  async projectExpiration(orderToken: string): Promise<{ expiresAt: string }> {
    const order = await this.readOrder(orderToken);
    return { expiresAt: iso(order.expirationDateUtc, "expiration.date") };
  }

  async projectStatus(
    orderToken: string,
  ): Promise<"OPEN" | "FULFILLED" | "EXPIRED"> {
    const order = await this.readOrder(orderToken);
    return cartStatus(order.status);
  }

  private async readOrder(
    orderToken: string,
  ): Promise<Record<string, unknown>> {
    if (!nonEmpty(orderToken)) throw new AmcOrderProjectionError("token");
    const response = await this.graph.read({
      operationName: "OrderProjection",
      query: ORDER_PROJECTION_DOCUMENT,
      variables: { token: orderToken },
    });
    if (
      !isRecord(response) ||
      (Array.isArray(response.errors) && response.errors.length > 0)
    ) {
      throw new AmcOrderProjectionError("response");
    }
    const order = nestedRecord(response, ["data", "viewer", "order"]);
    if (!order || order.token !== orderToken || order.error !== null) {
      throw new AmcOrderProjectionError("order");
    }
    return order;
  }
}

function cartSnapshot(
  order: Record<string, unknown>,
  orderToken: string,
  intent: CartCreateIntent,
): CartSnapshot {
  const groups = oneGroup(order, "cart.groups");
  const showtime = record(groups.showtime, "cart.showtime");
  if (
    String(integer(showtime.showtimeId, "cart.showtimeId")) !==
    intent.showtimeId
  ) {
    throw new AmcOrderProjectionError("cart.showtimeId");
  }
  const names = commaList(groups.reservedSeats, "cart.reservedSeats");
  const intendedNames = intent.seats.map((seat) => seat.name);
  if (!sameSet(names, intendedNames))
    throw new AmcOrderProjectionError("cart.seats");
  const items = array(groups.items, "cart.items");
  const tickets = items.map((entry, index) => {
    const item = record(entry, `cart.items.${index}`);
    return {
      sku: string(item.sku, `cart.items.${index}.sku`),
      quantity: positiveInteger(item.quantity, `cart.items.${index}.quantity`),
    };
  });
  const intendedTickets = aggregateTickets(intent);
  if (
    JSON.stringify(sortTickets(tickets)) !==
    JSON.stringify(sortTickets(intendedTickets))
  ) {
    throw new AmcOrderProjectionError("cart.tickets");
  }
  // AMC's authoritative created-cart total is `remainingBalance`; it can differ
  // from the pre-cart seat-map estimate (`intent.expectedTotal`) by theater
  // (fee/tax schedules). Parse it as canonical money and return it as the
  // authoritative CartSnapshot.total — do NOT reject on an estimate mismatch.
  // Checkout submit still consents to this authoritative total from a fresh
  // preview before any payment.
  const total = money(order.remainingBalance, "cart.remainingBalance");
  return {
    orderToken,
    showtimeId: intent.showtimeId,
    seats: intent.seats.map(({ name, sku, row, column }) => ({
      name,
      sku,
      row,
      column,
    })),
    tickets,
    total,
    expiresAt: iso(order.expirationDateUtc, "cart.expirationDateUtc"),
    status: cartStatus(order.status),
  };
}

function purchaseResult(
  order: Record<string, unknown>,
  orderToken: string,
): PurchaseResult | null {
  if (order.status === "Pending") return null;
  if (order.status === "Expired" || order.status === "Cancelled") {
    const paid = money(order.paid, "purchase.paid");
    const total = money(order.total, "purchase.total");
    const remaining = money(
      order.remainingBalance,
      "purchase.remainingBalance",
    );
    if (
      paid === "0.00" &&
      remaining === total &&
      array(order.groups, "purchase.groups").length === 0
    ) {
      throw new PurchaseNotCompletedError(order.status);
    }
    throw new AmcOrderProjectionError("purchase.terminal-state");
  }
  if (order.status !== "Fulfilled" && order.status !== "Confirmed") {
    throw new AmcOrderProjectionError("purchase.status");
  }
  const group = oneGroup(order, "purchase.groups");
  return {
    orderToken,
    confirmationNumber: string(
      group.confirmationCode,
      "purchase.confirmationCode",
    ),
    chargedTotal: money(order.paid, "purchase.paid"),
    status: "CONFIRMED",
  };
}

function refundSnapshot(
  order: Record<string, unknown>,
  input: { orderNumber: string; email: string; orderToken: string },
): RefundOrderSnapshot {
  const group = oneGroup(order, "refund.groups");
  if (group.confirmationCode !== input.orderNumber) {
    throw new AmcOrderProjectionError("refund.confirmationCode");
  }
  const refundGroups = array(
    order.refundedPaymentGroups,
    "refund.refundedPaymentGroups",
  );
  const refundPending = refundGroups.some((entry, index) => {
    const value = record(entry, `refund.refundedPaymentGroups.${index}`);
    return value.isPending === true || value.refundStatus === "Pending";
  });
  const lines: RefundLineSnapshot[] = [];
  for (const [itemIndex, entry] of array(
    group.items,
    "refund.items",
  ).entries()) {
    const item = record(entry, `refund.items.${itemIndex}`);
    const label = string(item.name, `refund.items.${itemIndex}.name`);
    for (const [lineIndex, lineEntry] of array(
      item.lineItems,
      `refund.items.${itemIndex}.lineItems`,
    ).entries()) {
      const line = record(lineEntry, `refund.line.${lineIndex}`);
      const refundable = record(
        line.refundableStatus,
        `refund.line.${lineIndex}.status`,
      );
      const refunded = boolean(
        refundable.isRefunded,
        `refund.line.${lineIndex}.isRefunded`,
      );
      const selfService = boolean(
        refundable.selfServiceRefundable,
        `refund.line.${lineIndex}.selfServiceRefundable`,
      );
      if (!refunded && !selfService && !refundPending) {
        throw new AmcOrderProjectionError("refund.eligibility");
      }
      const amountCents =
        cents(line.cost, `refund.line.${lineIndex}.cost`) +
        cents(line.tax, `refund.line.${lineIndex}.tax`) -
        cents(line.refundableDiscount, `refund.line.${lineIndex}.discount`);
      lines.push({
        lineNumber: String(
          integer(line.lineNumber, `refund.line.${lineIndex}.lineNumber`),
        ),
        label: `${label} ${string(line.seatName, `refund.line.${lineIndex}.seatName`)}`,
        refundableAmount: centsMoney(amountCents),
        status: refunded
          ? refundPending
            ? "REFUND_REQUESTED"
            : "REFUNDED"
          : "PAID",
      });
    }
  }
  if (lines.length === 0) throw new AmcOrderProjectionError("refund.lines");
  const nonRefundableFee = money(order.feesTotal, "refund.feesTotal");
  const chargedTotal = centsMoney(
    lines.reduce((sum, line) => sum + moneyCents(line.refundableAmount), 0) +
      moneyCents(nonRefundableFee),
  );
  const allRefunded = lines.every((line) => line.status === "REFUNDED");
  const refundStarted = lines.some((line) => line.status !== "PAID");
  return {
    orderNumber: input.orderNumber,
    orderToken: input.orderToken,
    status:
      refundPending || (!allRefunded && refundStarted)
        ? "REFUND_REQUESTED"
        : allRefunded
          ? "REFUNDED"
          : "CONFIRMED",
    chargedTotal,
    nonRefundableFee,
    lines,
  };
}

function requireEmail(order: Record<string, unknown>, expected: string): void {
  if (order.email !== expected) throw new AmcOrderProjectionError("email");
}
function oneGroup(
  order: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const groups = array(order.groups, field);
  if (groups.length !== 1) throw new AmcOrderProjectionError(field);
  return record(groups[0], field);
}
function cartStatus(value: unknown): CartSnapshot["status"] {
  if (value === "Pending") return "OPEN";
  if (value === "Fulfilled" || value === "Confirmed") return "FULFILLED";
  if (value === "Expired" || value === "Cancelled") return "EXPIRED";
  throw new AmcOrderProjectionError("cart.status");
}
function aggregateTickets(
  intent: CartCreateIntent,
): Array<{ sku: string; quantity: number }> {
  const values = new Map<string, number>();
  for (const seat of intent.seats)
    values.set(seat.sku, (values.get(seat.sku) ?? 0) + seat.quantity);
  return [...values].map(([sku, quantity]) => ({ sku, quantity }));
}
function sortTickets(values: Array<{ sku: string; quantity: number }>) {
  return [...values].sort((a, b) => a.sku.localeCompare(b.sku));
}
function cloneIntent(intent: CartCreateIntent): CartCreateIntent {
  return { ...intent, seats: intent.seats.map((seat) => ({ ...seat })) };
}
function sameSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
function commaList(value: unknown, field: string): string[] {
  return string(value, field)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
function nestedRecord(
  value: unknown,
  path: string[],
): Record<string, unknown> | null {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return isRecord(current) ? current : null;
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AmcOrderProjectionError(field);
  return value;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new AmcOrderProjectionError(field);
  return value;
}
function string(value: unknown, field: string): string {
  if (!nonEmpty(value)) throw new AmcOrderProjectionError(field);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AmcOrderProjectionError(field);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new AmcOrderProjectionError(field);
  return value;
}
function positiveInteger(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (parsed < 1) throw new AmcOrderProjectionError(field);
  return parsed;
}
function iso(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!Number.isFinite(Date.parse(parsed)))
    throw new AmcOrderProjectionError(field);
  return parsed;
}
function money(value: unknown, field: string): Money {
  return centsMoney(cents(value, field));
}
function cents(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AmcOrderProjectionError(field);
  }
  return Math.round(value * 100);
}
function centsMoney(value: number): Money {
  return (value / 100).toFixed(2) as Money;
}
function moneyCents(value: Money): number {
  if (!/^\d+\.\d{2}$/.test(value)) throw new AmcOrderProjectionError("money");
  return Math.round(Number(value) * 100);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
