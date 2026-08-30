import { SessionKey, SessionStore } from "../auth-session";
import { CartCreateIntent } from "./executor";
import {
  canonicalIntent,
  intentHash as computeIntentHash,
  selectionHash,
  sha256,
} from "./intent-identity";

/**
 * Immutable identity of a cart hold. This is the ONLY durable record the
 * commerce layer keeps about a created cart: the original intent (needed to
 * project the provider order by exact seats/SKU) keyed by the provider order
 * token. It carries NO lifecycle state, total, or confirmation — the provider
 * order projection is the sole source of truth for what a cart/order currently
 * is. Append-only and version-stamped.
 */
export interface CartIntentRecord {
  version: 2;
  orderToken: string;
  intent: CartCreateIntent;
  intentHash: string;
  checkoutSessionId?: string;
  createdAt: string;
}

/** Raised when a stored recovery record is malformed, tampered, or mismatched. */
export class RecoveryStoreCorruptError extends Error {
  readonly code = "AMC_CHECKOUT_JOURNAL_CORRUPT";
  constructor() {
    super("AMC checkout recovery record is malformed or incompatible");
  }
}

function tokenKey(orderToken: string): SessionKey {
  return { provider: "amc-cart-intent", account: sha256(orderToken) };
}

function selectionAliasKey(
  showtimeId: string,
  seatNames: string[],
): SessionKey {
  return {
    provider: "amc-cart-intent-selection",
    account: selectionHash(showtimeId, seatNames),
  };
}

/**
 * Append-only store of {@link CartIntentRecord}s over the atomic mode-0600
 * SessionStore. A token-hash primary key holds the record; a selection alias
 * (showtime + sorted seats) points at the NEWEST token for that selection so a
 * tokenless recovery can find the last cart for a physical seat set.
 */
export class CartIntentStore {
  constructor(private readonly store: SessionStore) {}

  /**
   * Persist the immutable intent identity for a freshly created cart. Called
   * synchronously in cart-create `onToken`, BEFORE the projection read, so the
   * identity survives a later projection failure (AMC_CART_HOLD_UNCONFIRMED).
   */
  async record(input: {
    orderToken: string;
    intent: CartCreateIntent;
    checkoutSessionId?: string;
    createdAt: string;
  }): Promise<void> {
    if (!nonEmpty(input.orderToken)) throw new RecoveryStoreCorruptError();
    const record: CartIntentRecord = {
      version: 2,
      orderToken: input.orderToken,
      intent: structuredClone(input.intent),
      intentHash: computeIntentHash(input.intent),
      ...(input.checkoutSessionId
        ? { checkoutSessionId: input.checkoutSessionId }
        : {}),
      createdAt: input.createdAt,
    };
    await this.store.save(tokenKey(input.orderToken), encode(validate(record)));
    await this.store.save(
      selectionAliasKey(input.intent.showtimeId, seatNamesOf(input.intent)),
      encode({ version: 2, orderToken: input.orderToken }),
    );
  }

  /** Load the immutable intent for a token, tamper-checking token + hash. */
  async loadByToken(orderToken: string): Promise<CartIntentRecord | null> {
    if (!nonEmpty(orderToken)) throw new RecoveryStoreCorruptError();
    const bytes = await this.store.load(tokenKey(orderToken));
    if (bytes === null) return null;
    const record = decodeRecord(bytes);
    if (
      record.orderToken !== orderToken ||
      record.intentHash !== computeIntentHash(record.intent) ||
      record.intentHash !== sha256(canonicalIntent(record.intent))
    ) {
      throw new RecoveryStoreCorruptError();
    }
    return record;
  }

  /** Resolve the newest order token recorded for a physical seat selection. */
  async newestTokenForSelection(
    showtimeId: string,
    seatNames: string[],
  ): Promise<string | null> {
    const bytes = await this.store.load(
      selectionAliasKey(showtimeId, seatNames),
    );
    if (bytes === null) return null;
    const alias = decodeAlias(bytes);
    return alias.orderToken;
  }
}

function seatNamesOf(intent: CartCreateIntent): string[] {
  return intent.seats.map((seat) => seat.name);
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function decodeRecord(bytes: Uint8Array): CartIntentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new RecoveryStoreCorruptError();
  }
  return validate(parsed);
}

function decodeAlias(bytes: Uint8Array): { version: 2; orderToken: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new RecoveryStoreCorruptError();
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 2 ||
    !nonEmpty(parsed.orderToken) ||
    Object.keys(parsed).some((k) => !["version", "orderToken"].includes(k))
  ) {
    throw new RecoveryStoreCorruptError();
  }
  return { version: 2, orderToken: parsed.orderToken };
}

function validate(value: unknown): CartIntentRecord {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !nonEmpty(value.orderToken) ||
    typeof value.intentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.intentHash) ||
    !isIso(value.createdAt)
  ) {
    throw new RecoveryStoreCorruptError();
  }
  validateIntent(value.intent);
  if (sha256(canonicalIntent(value.intent)) !== value.intentHash) {
    throw new RecoveryStoreCorruptError();
  }
  if (
    value.checkoutSessionId !== undefined &&
    !validCheckoutSessionId(value.checkoutSessionId)
  ) {
    throw new RecoveryStoreCorruptError();
  }
  const allowed = new Set([
    "version",
    "orderToken",
    "intent",
    "intentHash",
    "checkoutSessionId",
    "createdAt",
  ]);
  if (Object.keys(value).some((k) => !allowed.has(k))) {
    throw new RecoveryStoreCorruptError();
  }
  return {
    version: 2,
    orderToken: value.orderToken,
    intent: structuredClone(value.intent),
    intentHash: value.intentHash,
    ...(value.checkoutSessionId
      ? { checkoutSessionId: value.checkoutSessionId }
      : {}),
    createdAt: value.createdAt,
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
    throw new RecoveryStoreCorruptError();
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
      throw new RecoveryStoreCorruptError();
    }
    const coordinate = `${seat.row}:${seat.column}`;
    if (names.has(seat.name) || coordinates.has(coordinate)) {
      throw new RecoveryStoreCorruptError();
    }
    names.add(seat.name);
    coordinates.add(coordinate);
  }
}

function validCheckoutSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
function isMoney(value: unknown): value is string {
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
