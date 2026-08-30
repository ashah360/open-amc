import { SessionKey, SessionStore } from "../auth-session";
import { RecoveryStoreCorruptError } from "./cart-intent-store";
import { sha256 } from "./intent-identity";

export type PendingWriteOperation =
  "cart" | "purchase" | "purchase-challenge" | "release" | "refund";

/**
 * A single outstanding consequential write whose outcome is not yet known to
 * be definite. It is the entire "uncertainty ledger": created immediately
 * before a mutation is dispatched and cleared the moment a DEFINITE response
 * (success or a proven non-execution) is observed. A transport throw or a
 * complete 5xx (ambiguous) leaves the marker in place so no duplicate mutation
 * can be issued until the provider projection resolves it.
 */
export interface PendingWrite {
  version: 1;
  operation: PendingWriteOperation;
  /** Order token, selection hash, or refund hash identifying the target. */
  key: string;
  intentHash: string;
  dispatchedAt: string;
}

function markerKey(operation: PendingWriteOperation, key: string): SessionKey {
  return {
    provider: "amc-pending-write",
    account: sha256(`${operation}:${key}`),
  };
}

/**
 * At-most-one-per-(operation,key) store of {@link PendingWrite} markers over the
 * atomic mode-0600 SessionStore. There are NO normal lifecycle states here —
 * only outstanding uncertainty.
 */
export class PendingWriteStore {
  constructor(private readonly store: SessionStore) {}

  async mark(input: {
    operation: PendingWriteOperation;
    key: string;
    intentHash: string;
    dispatchedAt: string;
  }): Promise<void> {
    const marker: PendingWrite = {
      version: 1,
      operation: input.operation,
      key: input.key,
      intentHash: input.intentHash,
      dispatchedAt: input.dispatchedAt,
    };
    await this.store.save(
      markerKey(input.operation, input.key),
      Buffer.from(JSON.stringify(validate(marker)), "utf8"),
    );
  }

  async load(
    operation: PendingWriteOperation,
    key: string,
  ): Promise<PendingWrite | null> {
    const bytes = await this.store.load(markerKey(operation, key));
    if (bytes === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new RecoveryStoreCorruptError();
    }
    return validate(parsed);
  }

  async clear(operation: PendingWriteOperation, key: string): Promise<void> {
    await this.store.remove(markerKey(operation, key));
  }
}

function validate(value: unknown): PendingWrite {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isOperation(value.operation) ||
    !nonEmpty(value.key) ||
    typeof value.intentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.intentHash) ||
    !isIso(value.dispatchedAt) ||
    Object.keys(value).some(
      (k) =>
        !["version", "operation", "key", "intentHash", "dispatchedAt"].includes(
          k,
        ),
    )
  ) {
    throw new RecoveryStoreCorruptError();
  }
  return {
    version: 1,
    operation: value.operation,
    key: value.key,
    intentHash: value.intentHash,
    dispatchedAt: value.dispatchedAt,
  };
}

function isOperation(value: unknown): value is PendingWriteOperation {
  return (
    value === "cart" ||
    value === "purchase" ||
    value === "purchase-challenge" ||
    value === "release" ||
    value === "refund"
  );
}
function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
