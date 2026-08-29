import { SessionKey } from "./adapter";

/**
 * Storage contract for opaque session payloads. Implementations must provide
 * atomic saves and one cross-process refresh lock per provider/account key.
 */
export interface SessionStore {
  /** Load persisted bytes, or null when no session exists. */
  load(key: SessionKey): Promise<Uint8Array | null>;

  /** Atomically replace the persisted session. */
  save(key: SessionKey, bytes: Uint8Array): Promise<void>;

  /** Remove the persisted session; a missing session is not an error. */
  remove(key: SessionKey): Promise<void>;

  /**
   * Run `fn` while holding the exclusive refresh lock for `key`. Acquisition
   * is bounded; callers must re-check the stored session after acquiring so a
   * concurrent refresh by another holder wins.
   */
  withRefreshLock<T>(key: SessionKey, fn: () => Promise<T>): Promise<T>;
}
