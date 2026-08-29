import { createHash } from "node:crypto";
import { SessionKey, SessionStore } from "../auth-session";
import { CartCreateIntent, Money } from "./executor";

export type CheckoutAttemptState =
  | "PREPARED"
  | "CART_DISPATCHING"
  | "CART_TOKEN_RECEIVED"
  | "CART_OPEN"
  | "RELEASE_DISPATCHING"
  | "RELEASED"
  | "PURCHASE_DISPATCHING"
  | "PURCHASE_CHALLENGE_DISPATCHING"
  | "CONFIRMED"
  | "NOT_PURCHASED"
  | "UNKNOWN";

export interface CheckoutAttempt {
  version: 1;
  attemptId: string;
  state: CheckoutAttemptState;
  intent: CartCreateIntent;
  updatedAt: string;
  checkoutSessionId?: string;
  orderToken?: string;
  confirmationNumber?: string;
  chargedTotal?: Money;
}

export interface RefundAttempt {
  version: 1;
  state: "REFUND_PREPARED" | "REFUND_DISPATCHING" | "REFUND_OBSERVED";
  orderToken: string;
  orderNumber: string;
  lineNumbers: string[];
  refundTotal: Money;
  nonRefundableFee: Money;
  updatedAt: string;
}

export class CheckoutJournalCorruptError extends Error {
  readonly code = "AMC_CHECKOUT_JOURNAL_CORRUPT";
  constructor() {
    super("AMC checkout journal is malformed or incompatible");
  }
}

export interface CheckoutJournal {
  attemptId(intent: CartCreateIntent): string;
  load(intent: CartCreateIntent): Promise<CheckoutAttempt | null>;
  loadByMutation(intent: CartCreateIntent): Promise<CheckoutAttempt | null>;
  loadByOrderToken(orderToken: string): Promise<CheckoutAttempt | null>;
  loadBySelection(
    showtimeId: string,
    seatNames: string[],
  ): Promise<CheckoutAttempt | null>;
  save(attempt: CheckoutAttempt): Promise<void>;
  resetReleased(attempt: CheckoutAttempt): Promise<void>;
  resetNotPurchased(attempt: CheckoutAttempt): Promise<void>;
  withIntentLock<T>(intent: CartCreateIntent, fn: () => Promise<T>): Promise<T>;
  loadRefund(
    orderToken: string,
    lineNumbers: string[],
  ): Promise<RefundAttempt | null>;
  saveRefund(attempt: RefundAttempt): Promise<void>;
  withRefundLock<T>(
    orderToken: string,
    lineNumbers: string[],
    fn: () => Promise<T>,
  ): Promise<T>;
}

export class FileCheckoutJournal implements CheckoutJournal {
  constructor(private readonly store: SessionStore) {}

  attemptId(intent: CartCreateIntent): string {
    return createHash("sha256").update(canonicalIntent(intent)).digest("hex");
  }

  key(intent: CartCreateIntent): SessionKey {
    return { provider: "amc-checkout", account: this.attemptId(intent) };
  }

  async load(intent: CartCreateIntent): Promise<CheckoutAttempt | null> {
    return this.loadById(this.attemptId(intent));
  }

  async loadByMutation(
    intent: CartCreateIntent,
  ): Promise<CheckoutAttempt | null> {
    const aliasBytes = await this.store.load(mutationAliasKey(intent));
    if (aliasBytes === null) return null;
    return this.loadById(decodeAlias(aliasBytes));
  }

  async loadByOrderToken(orderToken: string): Promise<CheckoutAttempt | null> {
    if (!nonEmpty(orderToken)) throw new CheckoutJournalCorruptError();
    const aliasBytes = await this.store.load(orderAliasKey(orderToken));
    if (aliasBytes === null) return null;
    let alias: unknown;
    try {
      alias = JSON.parse(Buffer.from(aliasBytes).toString("utf8"));
    } catch {
      throw new CheckoutJournalCorruptError();
    }
    if (
      !isRecord(alias) ||
      alias.version !== 1 ||
      typeof alias.attemptId !== "string" ||
      !/^[a-f0-9]{64}$/.test(alias.attemptId) ||
      Object.keys(alias).some((key) => !["version", "attemptId"].includes(key))
    ) {
      throw new CheckoutJournalCorruptError();
    }
    const attempt = await this.loadById(alias.attemptId);
    if (!attempt || attempt.orderToken !== orderToken)
      throw new CheckoutJournalCorruptError();
    return attempt;
  }

  async loadBySelection(
    showtimeId: string,
    seatNames: string[],
  ): Promise<CheckoutAttempt | null> {
    const aliasBytes = await this.store.load(
      selectionAliasKey(showtimeId, seatNames),
    );
    if (aliasBytes === null) return null;
    const attemptId = decodeAlias(aliasBytes);
    const attempt = await this.loadById(attemptId);
    if (
      !attempt ||
      attempt.intent.showtimeId !== showtimeId ||
      !sameStrings(
        attempt.intent.seats.map((seat) => seat.name),
        seatNames,
      )
    ) {
      throw new CheckoutJournalCorruptError();
    }
    return attempt;
  }

  private async loadById(attemptId: string): Promise<CheckoutAttempt | null> {
    const bytes = await this.store.load({
      provider: "amc-checkout",
      account: attemptId,
    });
    if (bytes === null) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      return validateAttempt(parsed, attemptId);
    } catch (error) {
      if (error instanceof CheckoutJournalCorruptError) throw error;
      throw new CheckoutJournalCorruptError();
    }
  }

  async save(attempt: CheckoutAttempt): Promise<void> {
    const validated = validateAttempt(attempt, attempt.attemptId);
    await this.store.save(
      { provider: "amc-checkout", account: attempt.attemptId },
      Buffer.from(JSON.stringify(validated), "utf8"),
    );
    await this.store.save(
      mutationAliasKey(validated.intent),
      Buffer.from(
        JSON.stringify({ version: 1, attemptId: validated.attemptId }),
        "utf8",
      ),
    );
    if (validated.orderToken) {
      await this.store.save(
        orderAliasKey(validated.orderToken),
        Buffer.from(
          JSON.stringify({ version: 1, attemptId: validated.attemptId }),
          "utf8",
        ),
      );
    }
    await this.store.save(
      selectionAliasKey(
        validated.intent.showtimeId,
        validated.intent.seats.map((seat) => seat.name),
      ),
      Buffer.from(
        JSON.stringify({ version: 1, attemptId: validated.attemptId }),
        "utf8",
      ),
    );
  }

  async resetReleased(attempt: CheckoutAttempt): Promise<void> {
    const validated = validateAttempt(attempt, attempt.attemptId);
    if (validated.state !== "RELEASED" || !validated.orderToken) {
      throw new CheckoutJournalCorruptError();
    }
    await this.removeAliasIfOwned(
      orderAliasKey(validated.orderToken),
      validated.attemptId,
    );
    await this.removeAliasIfOwned(
      selectionAliasKey(
        validated.intent.showtimeId,
        validated.intent.seats.map((seat) => seat.name),
      ),
      validated.attemptId,
    );
    await this.removeAliasIfOwned(
      mutationAliasKey(validated.intent),
      validated.attemptId,
    );
    await this.store.remove(this.key(validated.intent));
  }

  async resetNotPurchased(attempt: CheckoutAttempt): Promise<void> {
    const validated = validateAttempt(attempt, attempt.attemptId);
    if (validated.state !== "NOT_PURCHASED" || !validated.orderToken) {
      throw new CheckoutJournalCorruptError();
    }
    await this.removeAliasIfOwned(
      orderAliasKey(validated.orderToken),
      validated.attemptId,
    );
    await this.removeAliasIfOwned(
      selectionAliasKey(
        validated.intent.showtimeId,
        validated.intent.seats.map((seat) => seat.name),
      ),
      validated.attemptId,
    );
    await this.removeAliasIfOwned(
      mutationAliasKey(validated.intent),
      validated.attemptId,
    );
    await this.store.remove(this.key(validated.intent));
  }

  private async removeAliasIfOwned(
    key: SessionKey,
    attemptId: string,
  ): Promise<void> {
    const bytes = await this.store.load(key);
    if (bytes === null) return;
    if (decodeAlias(bytes) === attemptId) await this.store.remove(key);
  }

  withIntentLock<T>(
    intent: CartCreateIntent,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.store.withRefreshLock(mutationLockKey(intent), fn);
  }

  async loadRefund(
    orderToken: string,
    lineNumbers: string[],
  ): Promise<RefundAttempt | null> {
    const bytes = await this.store.load(refundKey(orderToken, lineNumbers));
    if (bytes === null) return null;
    try {
      return validateRefundAttempt(
        JSON.parse(Buffer.from(bytes).toString("utf8")),
      );
    } catch (error) {
      if (error instanceof CheckoutJournalCorruptError) throw error;
      throw new CheckoutJournalCorruptError();
    }
  }

  async saveRefund(attempt: RefundAttempt): Promise<void> {
    const validated = validateRefundAttempt(attempt);
    await this.store.save(
      refundKey(validated.orderToken, validated.lineNumbers),
      Buffer.from(JSON.stringify(validated), "utf8"),
    );
  }

  withRefundLock<T>(
    orderToken: string,
    lineNumbers: string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.store.withRefreshLock(refundKey(orderToken, lineNumbers), fn);
  }
}

function refundKey(orderToken: string, lineNumbers: string[]): SessionKey {
  if (
    !nonEmpty(orderToken) ||
    lineNumbers.length === 0 ||
    !lineNumbers.every(nonEmpty)
  ) {
    throw new CheckoutJournalCorruptError();
  }
  return {
    provider: "amc-refund",
    account: createHash("sha256")
      .update(
        JSON.stringify({ orderToken, lineNumbers: [...lineNumbers].sort() }),
      )
      .digest("hex"),
  };
}

function validateRefundAttempt(value: unknown): RefundAttempt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !["REFUND_PREPARED", "REFUND_DISPATCHING", "REFUND_OBSERVED"].includes(
      value.state,
    ) ||
    !nonEmpty(value.orderToken) ||
    !/^\d+$/.test(String(value.orderNumber ?? "")) ||
    !Array.isArray(value.lineNumbers) ||
    value.lineNumbers.length === 0 ||
    !value.lineNumbers.every(nonEmpty) ||
    new Set(value.lineNumbers).size !== value.lineNumbers.length ||
    !isMoney(value.refundTotal) ||
    !isMoney(value.nonRefundableFee) ||
    !isIso(value.updatedAt)
  ) {
    throw new CheckoutJournalCorruptError();
  }
  const allowed = new Set([
    "version",
    "state",
    "orderToken",
    "orderNumber",
    "lineNumbers",
    "refundTotal",
    "nonRefundableFee",
    "updatedAt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CheckoutJournalCorruptError();
  }
  return {
    version: 1,
    state: value.state,
    orderToken: value.orderToken,
    orderNumber: value.orderNumber,
    lineNumbers: [...value.lineNumbers],
    refundTotal: value.refundTotal,
    nonRefundableFee: value.nonRefundableFee,
    updatedAt: value.updatedAt,
  };
}

function mutationAliasKey(intent: CartCreateIntent): SessionKey {
  return {
    provider: "amc-checkout-mutation",
    account: createHash("sha256")
      .update(canonicalProviderMutation(intent))
      .digest("hex"),
  };
}

function mutationLockKey(intent: CartCreateIntent): SessionKey {
  return {
    provider: "amc-checkout-mutation-lock",
    account: createHash("sha256")
      .update(canonicalProviderMutation(intent))
      .digest("hex"),
  };
}

function canonicalProviderMutation(intent: CartCreateIntent): string {
  validateIntent(intent);
  return JSON.stringify({
    products: intent.seats
      .map(({ sku, quantity, row, column }) => ({ sku, quantity, row, column }))
      .sort((left, right) =>
        `${left.sku}:${left.row}:${left.column}:${left.quantity}`.localeCompare(
          `${right.sku}:${right.row}:${right.column}:${right.quantity}`,
        ),
      ),
    waiveSubscriptionDiscounts: intent.waiveSubscriptionDiscounts,
  });
}

function orderAliasKey(orderToken: string): SessionKey {
  return {
    provider: "amc-checkout-order",
    account: createHash("sha256").update(orderToken).digest("hex"),
  };
}

function selectionAliasKey(
  showtimeId: string,
  seatNames: string[],
): SessionKey {
  if (
    !/^\d+$/.test(showtimeId) ||
    seatNames.length === 0 ||
    !seatNames.every(nonEmpty)
  ) {
    throw new CheckoutJournalCorruptError();
  }
  const selection = JSON.stringify({
    showtimeId,
    seatNames: [...seatNames].map((name) => name.toUpperCase()).sort(),
  });
  return {
    provider: "amc-checkout-selection",
    account: createHash("sha256").update(selection).digest("hex"),
  };
}

function decodeAlias(bytes: Uint8Array): string {
  let alias: unknown;
  try {
    alias = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new CheckoutJournalCorruptError();
  }
  if (
    !isRecord(alias) ||
    alias.version !== 1 ||
    typeof alias.attemptId !== "string" ||
    !/^[a-f0-9]{64}$/.test(alias.attemptId) ||
    Object.keys(alias).some((key) => !["version", "attemptId"].includes(key))
  ) {
    throw new CheckoutJournalCorruptError();
  }
  return alias.attemptId;
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left
      .map((value) => value.toUpperCase())
      .sort()
      .every(
        (value, index) =>
          value === right.map((item) => item.toUpperCase()).sort()[index],
      )
  );
}

function canonicalIntent(intent: CartCreateIntent): string {
  validateIntent(intent);
  return JSON.stringify({
    showtimeId: intent.showtimeId,
    seats: intent.seats
      .map((seat) => ({
        name: seat.name,
        sku: seat.sku,
        quantity: seat.quantity,
        row: seat.row,
        column: seat.column,
      }))
      .sort((left, right) =>
        `${left.row}:${left.column}:${left.name}`.localeCompare(
          `${right.row}:${right.column}:${right.name}`,
        ),
      ),
    waiveSubscriptionDiscounts: intent.waiveSubscriptionDiscounts,
    expectedTotal: intent.expectedTotal,
    holdAcknowledgement: intent.holdAcknowledgement,
  });
}

function validateAttempt(value: unknown, expectedId: string): CheckoutAttempt {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.attemptId !== expectedId ||
    !isState(value.state) ||
    !isIso(value.updatedAt)
  ) {
    throw new CheckoutJournalCorruptError();
  }
  validateIntent(value.intent);
  if (
    createHash("sha256").update(canonicalIntent(value.intent)).digest("hex") !==
    expectedId
  ) {
    throw new CheckoutJournalCorruptError();
  }
  const orderToken = optionalString(value.orderToken);
  const checkoutSessionId = optionalString(value.checkoutSessionId);
  if (
    value.checkoutSessionId !== undefined &&
    !validCheckoutSessionId(value.checkoutSessionId)
  ) {
    throw new CheckoutJournalCorruptError();
  }
  const confirmationNumber = optionalString(value.confirmationNumber);
  const chargedTotal = optionalMoney(value.chargedTotal);
  if (
    ([
      "CART_TOKEN_RECEIVED",
      "CART_OPEN",
      "RELEASE_DISPATCHING",
      "RELEASED",
      "PURCHASE_DISPATCHING",
      "PURCHASE_CHALLENGE_DISPATCHING",
      "CONFIRMED",
      "NOT_PURCHASED",
    ].includes(value.state) &&
      !orderToken) ||
    (value.state === "CONFIRMED" && (!confirmationNumber || !chargedTotal)) ||
    (value.state !== "CONFIRMED" && (confirmationNumber || chargedTotal))
  ) {
    throw new CheckoutJournalCorruptError();
  }
  const allowed = new Set([
    "version",
    "attemptId",
    "state",
    "intent",
    "updatedAt",
    "checkoutSessionId",
    "orderToken",
    "confirmationNumber",
    "chargedTotal",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CheckoutJournalCorruptError();
  }
  return {
    version: 1,
    attemptId: expectedId,
    state: value.state,
    intent: structuredClone(value.intent),
    updatedAt: value.updatedAt,
    ...(checkoutSessionId ? { checkoutSessionId } : {}),
    ...(orderToken ? { orderToken } : {}),
    ...(confirmationNumber ? { confirmationNumber } : {}),
    ...(chargedTotal ? { chargedTotal } : {}),
  };
}

function validateIntent(value: unknown): asserts value is CartCreateIntent {
  if (
    !isRecord(value) ||
    !/^\d+$/.test(String(value.showtimeId ?? "")) ||
    !Array.isArray(value.seats) ||
    value.seats.length === 0 ||
    typeof value.waiveSubscriptionDiscounts !== "boolean" ||
    !isMoney(value.expectedTotal) ||
    value.holdAcknowledgement !== "CREATE_HOLD"
  ) {
    throw new CheckoutJournalCorruptError();
  }
  const names = new Set<string>();
  const coordinates = new Set<string>();
  for (const seat of value.seats) {
    if (
      !isRecord(seat) ||
      !nonEmpty(seat.name) ||
      !nonEmpty(seat.sku) ||
      seat.quantity !== 1 ||
      !positiveInteger(seat.row) ||
      !positiveInteger(seat.column)
    ) {
      throw new CheckoutJournalCorruptError();
    }
    const coordinate = `${seat.row}:${seat.column}`;
    if (names.has(seat.name) || coordinates.has(coordinate)) {
      throw new CheckoutJournalCorruptError();
    }
    names.add(seat.name);
    coordinates.add(coordinate);
  }
}

function isState(value: unknown): value is CheckoutAttemptState {
  return [
    "PREPARED",
    "CART_DISPATCHING",
    "CART_TOKEN_RECEIVED",
    "CART_OPEN",
    "RELEASE_DISPATCHING",
    "RELEASED",
    "PURCHASE_DISPATCHING",
    "PURCHASE_CHALLENGE_DISPATCHING",
    "CONFIRMED",
    "NOT_PURCHASED",
    "UNKNOWN",
  ].includes(String(value));
}
function validCheckoutSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
function optionalString(value: unknown): string | null {
  if (value === undefined) return null;
  if (!nonEmpty(value)) throw new CheckoutJournalCorruptError();
  return value;
}
function optionalMoney(value: unknown): Money | null {
  if (value === undefined) return null;
  if (!isMoney(value)) throw new CheckoutJournalCorruptError();
  return value;
}
function isMoney(value: unknown): value is Money {
  return typeof value === "string" && /^\d+\.\d{2}$/.test(value);
}
function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
