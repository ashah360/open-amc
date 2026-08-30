import { SessionKey, SessionStore } from "../auth-session";
import type { PendingWriteStore } from "./pending-write-store";
import { CartCreateIntent } from "./executor";
import {
  canonicalIntent,
  intentHash as computeIntentHash,
  selectionHash,
  sha256,
} from "./intent-identity";

/**
 * Immutable identity of a cart hold: the original intent (to project the
 * provider order by exact seats/SKU) keyed by the order token. No lifecycle
 * state/total/confirmation — the provider projection is the sole truth.
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
 * Append-only store of {@link CartIntentRecord}s over the atomic SessionStore.
 * Token-hash primary key; a selection alias points at the NEWEST token so a
 * tokenless recovery can find the last cart for a physical seat set.
 */
export class CartIntentStore {
  constructor(private readonly store: SessionStore) {}

  /**
   * Persist the immutable intent for a fresh cart, synchronously in cart-create
   * `onToken` (before the projection read) so identity survives a later failure.
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
    // decodeRecord validates the shape and that intentHash === hash(intent);
    // here we only additionally tamper-check the token matches its key.
    const record = decodeRecord(bytes);
    if (record.orderToken !== orderToken) throw new RecoveryStoreCorruptError();
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

/** A legacy checkout-journal record, read-only, for transitional migration. */
export interface LegacyCheckoutAttempt {
  orderToken: string;
  intent: CartCreateIntent;
  state: string;
  updatedAt: string;
}

/**
 * Read a legacy journal record for a token from the raw SessionStore WITHOUT
 * deleting it (so an in-flight legacy hold resolves under the new model).
 * Returns null when absent; throws the typed corrupt error on tamper.
 */
export async function readLegacyAttemptByToken(
  store: SessionStore,
  orderToken: string,
): Promise<LegacyCheckoutAttempt | null> {
  if (!nonEmpty(orderToken)) throw new RecoveryStoreCorruptError();
  const aliasBytes = await store.load({
    provider: "amc-checkout-order",
    account: sha256(orderToken),
  });
  if (aliasBytes === null) return null;
  const alias = parseJson(aliasBytes);
  if (
    !isRecord(alias) ||
    alias.version !== 1 ||
    typeof alias.attemptId !== "string" ||
    !/^[a-f0-9]{64}$/.test(alias.attemptId)
  ) {
    throw new RecoveryStoreCorruptError();
  }
  const recordBytes = await store.load({
    provider: "amc-checkout",
    account: alias.attemptId,
  });
  if (recordBytes === null) return null;
  const legacy = parseJson(recordBytes);
  if (
    !isRecord(legacy) ||
    legacy.version !== 1 ||
    legacy.orderToken !== orderToken ||
    typeof legacy.state !== "string" ||
    !isIso(legacy.updatedAt)
  ) {
    throw new RecoveryStoreCorruptError();
  }
  return {
    orderToken,
    intent: legacy.intent as CartCreateIntent,
    state: legacy.state,
    updatedAt: legacy.updatedAt,
  };
}

/**
 * Resolve the immutable intent for a token, lazily migrating a legacy record on
 * first access (read-only). RELEASED carries no identity; a mid-dispatch legacy
 * state seeds the matching uncertainty marker for the provider to resolve.
 */
export async function migrateLegacyIntent(
  rec: {
    intents: CartIntentStore;
    pending: PendingWriteStore;
    store: SessionStore;
  },
  orderToken: string,
): Promise<CartIntentRecord | null> {
  const existing = await rec.intents.loadByToken(orderToken);
  if (existing) return existing;
  const legacy = await readLegacyAttemptByToken(rec.store, orderToken);
  if (!legacy) return null;
  if (legacy.state === "RELEASED") return null;
  await rec.intents.record({
    orderToken: legacy.orderToken,
    intent: legacy.intent,
    createdAt: legacy.updatedAt,
  });
  const marker =
    legacy.state === "PURCHASE_DISPATCHING"
      ? "purchase"
      : legacy.state === "PURCHASE_CHALLENGE_DISPATCHING"
        ? "purchase-challenge"
        : legacy.state === "RELEASE_DISPATCHING"
          ? "release"
          : null;
  if (marker) {
    await rec.pending.mark({
      operation: marker,
      key: orderToken,
      intentHash: computeIntentHash(legacy.intent),
      dispatchedAt: legacy.updatedAt,
    });
  }
  return rec.intents.loadByToken(orderToken);
}

function encode(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

/** Parse stored JSON, mapping any malformed payload to the typed corrupt error. */
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new RecoveryStoreCorruptError();
  }
}

function decodeRecord(bytes: Uint8Array): CartIntentRecord {
  return validate(parseJson(bytes));
}

function decodeAlias(bytes: Uint8Array): { version: 2; orderToken: string } {
  const parsed = parseJson(bytes);
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
  return structuredClone(value) as unknown as CartIntentRecord;
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
