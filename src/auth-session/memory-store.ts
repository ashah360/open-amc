import { SessionKey } from "./adapter";
import { SessionStore } from "./store";

/**
 * In-memory SessionStore. Intended for tests and ephemeral processes that must
 * not touch the filesystem. The refresh "lock" is a single in-process promise
 * chain per key; it provides no cross-process exclusion. Use FileSessionStore
 * for durable, cross-process persistence.
 */
export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<string, Uint8Array>();
  private readonly locks = new Map<string, Promise<unknown>>();

  private id(key: SessionKey): string {
    return `${key.provider}/${key.account}`;
  }

  load(key: SessionKey): Promise<Uint8Array | null> {
    const value = this.data.get(this.id(key));
    return Promise.resolve(value ? Uint8Array.from(value) : null);
  }

  save(key: SessionKey, bytes: Uint8Array): Promise<void> {
    this.data.set(this.id(key), Uint8Array.from(bytes));
    return Promise.resolve();
  }

  remove(key: SessionKey): Promise<void> {
    this.data.delete(this.id(key));
    return Promise.resolve();
  }

  async withRefreshLock<T>(key: SessionKey, fn: () => Promise<T>): Promise<T> {
    const id = this.id(key);
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(
      id,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
