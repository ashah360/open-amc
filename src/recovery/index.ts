// Optional durable recovery. `createAmcClient()` and ordinary checkout never
// require any of this: by default no journal is wired and imported client calls
// create no workflow files. These building blocks let an application opt into
// cross-process crash recovery using its own durable store, or the bundled
// filesystem store, explicitly.

export {
  CartIntentStore,
  RecoveryStoreCorruptError,
} from "../commerce/cart-intent-store";
export type { CartIntentRecord } from "../commerce/cart-intent-store";
export { PendingWriteStore } from "../commerce/pending-write-store";
export type {
  PendingWrite,
  PendingWriteOperation,
} from "../commerce/pending-write-store";
export { createFileCheckoutRecovery } from "../commerce/wiring";
export type { CheckoutRecovery } from "../commerce/service";

// Durable and in-memory SessionStore implementations usable as the journal's
// backing store. MemorySessionStore is intended for tests/ephemeral processes.
export { FileSessionStore, MemorySessionStore } from "../auth-session";
export type { SessionStore, SessionKey } from "../auth-session";
