import {
  AuthAdapter,
  AuthRejectedError,
  IdentityMismatchError,
  SessionDecodeError,
} from "./adapter";
import { SessionStore } from "./store";

/**
 * Generic session lifecycle: use saved session -> validate -> on actual auth
 * failure refresh through the adapter -> verify identity -> atomically save ->
 * continue. Reads retry exactly once after an adapter-classified auth failure,
 * always with a session different from the rejected one; writes are
 * preflighted and never auto-retried.
 */
export class SessionManager<Session, Identity> {
  private pendingRefresh: Promise<Session> | null = null;

  constructor(
    private readonly adapter: AuthAdapter<Session, Identity>,
    private readonly store: SessionStore,
  ) {}

  /** Load, validate, and return a working session, refreshing only on actual auth failure. */
  async getValidSession(): Promise<Session> {
    const saved = await this.loadSaved();
    if (saved !== null) {
      try {
        this.adapter.verifyIdentity(await this.adapter.validate(saved));
        return saved;
      } catch (error) {
        if (!this.isRefreshableFailure(error)) throw error;
      }
    }
    return this.refreshShared();
  }

  /**
   * Read path: run `fn` with a validated session; after an adapter-classified
   * auth failure, refresh and retry exactly once. Non-auth errors propagate.
   */
  async withRead<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.getValidSession();
    try {
      return await fn(session);
    } catch (error) {
      if (!this.adapter.isAuthFailure(error)) throw error;
      // Never hand the retry the session the provider just rejected.
      return fn(await this.refreshShared(session));
    }
  }

  /**
   * Write preflight: returns a session validated immediately before a
   * preview/submit. The mutation itself is the caller's single attempt.
   */
  async preflightWrite(): Promise<Session> {
    return this.getValidSession();
  }

  /**
   * Write path: preflight-validate, then run the mutation exactly once. An
   * auth (or any other) failure during the mutation is ambiguous and
   * propagates without refresh or retry.
   */
  async withWrite<T>(fn: (session: Session) => Promise<T>): Promise<T> {
    return fn(await this.preflightWrite());
  }

  /** Explicit forced refresh (e.g. `auth preload`): always obtains a new session. */
  async forceRefresh(): Promise<Session> {
    return this.store.withRefreshLock(this.adapter.key, () =>
      this.refreshAndPersist(),
    );
  }

  /**
   * Explicit refresh through a caller-provided refresher rather than the
   * adapter's automatic one. Used to keep automatic (routine) repair on a
   * strictly direct path while an explicit operation is allowed to escalate.
   * Validates identity and persists atomically under the refresh lock.
   */
  async refreshWith(refresher: {
    refresh(previous: Session | null): Promise<Session>;
  }): Promise<Session> {
    return this.store.withRefreshLock(this.adapter.key, async () => {
      const previous = await this.loadSaved();
      const fresh = await refresher.refresh(previous);
      const identity = await this.adapter.validate(fresh);
      this.adapter.verifyIdentity(identity);
      await this.store.save(this.adapter.key, this.adapter.encode(fresh));
      return fresh;
    });
  }

  /** Remove the persisted session. */
  async clear(): Promise<void> {
    await this.store.remove(this.adapter.key);
  }

  /** Concurrent in-process callers share one refresh and all receive its result. */
  private refreshShared(rejected: Session | null = null): Promise<Session> {
    if (!this.pendingRefresh) {
      this.pendingRefresh = this.refreshLocked(rejected).finally(() => {
        this.pendingRefresh = null;
      });
    }
    return this.pendingRefresh;
  }

  private async refreshLocked(rejected: Session | null): Promise<Session> {
    return this.store.withRefreshLock(this.adapter.key, async () => {
      // Double-check after acquiring: another holder's DIFFERENT session wins.
      // A stored session equal to the one the provider just rejected must not
      // be revalidated (e.g. endpoint-specific rejection that /me still accepts).
      const saved = await this.loadSaved();
      if (
        saved !== null &&
        (rejected === null || !this.adapter.sameSession(saved, rejected))
      ) {
        try {
          this.adapter.verifyIdentity(await this.adapter.validate(saved));
          return saved;
        } catch (error) {
          if (!this.isRefreshableFailure(error)) throw error;
        }
      }
      return this.refreshAndPersist(saved);
    });
  }

  private async refreshAndPersist(
    previous: Session | null = null,
  ): Promise<Session> {
    const fresh = await this.adapter.refresh(previous);
    const identity = await this.adapter.validate(fresh);
    this.adapter.verifyIdentity(identity);
    await this.store.save(this.adapter.key, this.adapter.encode(fresh));
    return fresh;
  }

  private async loadSaved(): Promise<Session | null> {
    const bytes = await this.store.load(this.adapter.key);
    if (bytes === null) return null;
    try {
      return this.adapter.decode(bytes);
    } catch (error) {
      if (error instanceof SessionDecodeError) return null;
      throw error;
    }
  }

  /** Saved-session failures that a refresh can repair; everything else propagates. */
  private isRefreshableFailure(error: unknown): boolean {
    if (
      error instanceof AuthRejectedError ||
      error instanceof IdentityMismatchError
    )
      return true;
    return this.adapter.isAuthFailure(error);
  }
}
