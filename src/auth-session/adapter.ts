/**
 * Provider adapter contract for the reusable auth-session lifecycle.
 *
 * The manager unifies lifecycle only. Provider auth data stays an opaque typed
 * payload owned by the adapter; the manager never inspects header names or
 * infers auth semantics from field names.
 */
export interface SessionKey {
  /** Provider identifier used for storage scoping, e.g. "example". */
  provider: string;
  /** Account alias used for storage scoping, e.g. "personal". */
  account: string;
}

/** Thrown by adapters when persisted bytes do not decode to a usable session. */
export class SessionDecodeError extends Error {}

/**
 * Thrown (or wrapped) by adapters when the provider actually rejected the
 * session's authentication. Rate limits (429), server errors (5xx), and
 * response-shape drift are NOT auth failures and must not use this class.
 */
export class AuthRejectedError extends Error {}

/** Thrown when a refreshed session belongs to the wrong account. */
export class IdentityMismatchError extends Error {}

export interface AuthAdapter<Session, Identity> {
  readonly key: SessionKey;

  /** Decode persisted opaque bytes into a typed session. Throws SessionDecodeError on drift. */
  decode(bytes: Uint8Array): Session;

  /** Encode a session for atomic persistence. */
  encode(session: Session): Uint8Array;

  /**
   * Prove the session works with a real provider check and return the
   * authenticated identity. Throws AuthRejectedError only on actual auth
   * rejection; other failures propagate as-is.
   */
  validate(session: Session): Promise<Identity>;

  /**
   * Obtain a replacement session (e.g. browser bootstrap / provider login).
   * `previous` is the invalid session, if one existed.
   */
  refresh(previous: Session | null): Promise<Session>;

  /**
   * Assert the validated identity is the exact expected account for this key.
   * Throws IdentityMismatchError otherwise.
   */
  verifyIdentity(identity: Identity): void;

  /**
   * Classify an error from request execution. Only true for actual auth
   * rejections; 429/5xx/schema errors must return false.
   */
  isAuthFailure(error: unknown): boolean;

  /**
   * Provider-owned session equality: true when both sessions carry the same
   * credentials, so a rejection of one is a rejection of the other. The
   * manager uses this to avoid retrying a just-rejected session; it never
   * infers equality from fields itself.
   */
  sameSession(a: Session, b: Session): boolean;
}
