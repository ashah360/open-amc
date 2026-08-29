// Optional durable recovery. `createAmcClient()` and ordinary checkout never
// require any of this: by default no journal is wired and imported client calls
// create no workflow files. These building blocks let an application opt into
// cross-process crash recovery using its own durable store, or the bundled
// filesystem store, explicitly.

export {
  FileCheckoutJournal,
  CheckoutJournalCorruptError,
} from "../commerce/checkout-journal";
export type {
  CheckoutJournal,
  CheckoutAttempt,
  CheckoutAttemptState,
  RefundAttempt,
} from "../commerce/checkout-journal";

// Durable and in-memory SessionStore implementations usable as the journal's
// backing store. MemorySessionStore is intended for tests/ephemeral processes.
export { FileSessionStore, MemorySessionStore } from "../auth-session";
export type { SessionStore, SessionKey } from "../auth-session";
