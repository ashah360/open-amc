import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionKey } from "./adapter";
import { SessionStore } from "./store";

export interface FileSessionStoreOptions {
  /** Root directory; defaults to ~/.open-amc/sessions. */
  root?: string;
  /** Total bounded wait for the refresh lock before failing. */
  lockTimeoutMs?: number;
  /** Poll interval while waiting on a held lock. */
  lockPollMs?: number;
  /** Age after which a malformed/unowned lock file may be reclaimed. */
  lockStaleMs?: number;
}

export class RefreshLockTimeoutError extends Error {}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Filesystem store: <root>/<provider>/<account>.session with private modes,
 * atomic temp+fsync+rename saves, and a bounded lockfile for cross-process
 * refresh exclusion. Each lock records its owner (pid + nonce) and is
 * published atomically (private candidate + hard link), so a fresh lock is
 * never observable empty or partial. A lock held by a live pid is never
 * reclaimed regardless of age, a dead holder's lock is reclaimed immediately,
 * and a malformed lock is reclaimed only after lockStaleMs. Acquisition never
 * waits past lockTimeoutMs.
 */
export class FileSessionStore implements SessionStore {
  private readonly root: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly lockStaleMs: number;

  constructor(options: FileSessionStoreOptions = {}) {
    this.root =
      options.root ?? path.join(os.homedir(), ".open-amc", "sessions");
    this.lockTimeoutMs = options.lockTimeoutMs ?? 120_000;
    this.lockPollMs = options.lockPollMs ?? 200;
    this.lockStaleMs = options.lockStaleMs ?? 180_000;
  }

  sessionPath(key: SessionKey): string {
    return path.join(this.dirFor(key), `${segment(key.account)}.session`);
  }

  private lockPath(key: SessionKey): string {
    return path.join(this.dirFor(key), `${segment(key.account)}.refresh.lock`);
  }

  private dirFor(key: SessionKey): string {
    return path.join(this.root, segment(key.provider));
  }

  async load(key: SessionKey): Promise<Uint8Array | null> {
    try {
      return await fs.readFile(this.sessionPath(key));
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async save(key: SessionKey, bytes: Uint8Array): Promise<void> {
    const dir = this.dirFor(key);
    await mkdirPrivate(this.root);
    await mkdirPrivate(dir);
    const file = this.sessionPath(key);
    // Random nonce: concurrent saves in one process within the same
    // millisecond must never collide on the temp name.
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(tmp, 0o600).catch(() => undefined);
      await fs.rename(tmp, file);
    } catch (error) {
      // Failed before the atomic rename landed: don't leave the temp behind.
      await fs.unlink(tmp).catch(() => undefined);
      throw error;
    }
    await fsyncDir(dir);
  }

  async remove(key: SessionKey): Promise<void> {
    try {
      await fs.unlink(this.sessionPath(key));
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  async withRefreshLock<T>(key: SessionKey, fn: () => Promise<T>): Promise<T> {
    const lock = this.lockPath(key);
    await mkdirPrivate(this.root);
    await mkdirPrivate(this.dirFor(key));
    await reclaimDeadCandidates(lock);
    const owner = ownerRecord();
    // Publish a fully initialized owner record atomically: write a private
    // candidate first, then hard-link it to the final lock path. The final
    // lock therefore either does not exist or carries a complete record; an
    // empty/partial fresh lock is unrepresentable through this path.
    const candidate = candidatePath(lock);
    await writeCandidate(candidate, owner);
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      for (;;) {
        try {
          await fs.link(candidate, lock);
          break;
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
          if (await this.reclaimStaleLock(lock)) continue;
          if (Date.now() >= deadline) {
            throw new RefreshLockTimeoutError(
              `refresh lock held too long: ${lock}`,
            );
          }
          await sleep(this.lockPollMs);
        }
      }
    } finally {
      // The candidate is only a publish vehicle; the final lock is the holder.
      await fs.unlink(candidate).catch(() => undefined);
    }
    try {
      return await fn();
    } finally {
      await this.releaseOwnLock(lock, owner);
    }
  }

  /**
   * Reclaim rules: a well-formed lock is reclaimed only when its holder pid is
   * dead — never merely because it is old (browser auth can legitimately run
   * long). A malformed/unowned lock is reclaimed only after lockStaleMs.
   */
  private async reclaimStaleLock(lock: string): Promise<boolean> {
    let stale = false;
    try {
      const holder = parseOwner(await fs.readFile(lock, "utf8"));
      if (holder) {
        stale = !processAlive(holder.pid);
      } else {
        const stat = await fs.stat(lock);
        stale = Date.now() - stat.mtimeMs > this.lockStaleMs;
      }
    } catch (error) {
      // Lock vanished between EEXIST and read: retry acquisition immediately.
      return isCode(error, "ENOENT");
    }
    if (!stale) return false;
    await fs.unlink(lock).catch(() => undefined);
    return true;
  }

  /** Unlink only a lock this holder still owns; never a successor's lock. */
  private async releaseOwnLock(lock: string, owner: string): Promise<void> {
    try {
      if ((await fs.readFile(lock, "utf8")) === owner) await fs.unlink(lock);
    } catch {
      // Missing or unreadable lock: nothing owned by us remains to release.
    }
  }
}

/** Owner record: "<pid> <nonce>\n". The nonce distinguishes successive holders with the same pid. */
function ownerRecord(): string {
  return `${process.pid} ${randomUUID()}\n`;
}

/** Candidate name embeds the writer pid so crash residue is attributable. */
function candidatePath(lock: string): string {
  return `${lock}.candidate-${process.pid}-${randomUUID()}`;
}

const CANDIDATE_PID = /\.candidate-(\d+)-[^/\\]+$/;

/** Fully write and fsync the private candidate before it can be published. */
async function writeCandidate(candidate: string, owner: string): Promise<void> {
  const handle = await fs.open(candidate, "wx", 0o600);
  try {
    try {
      await handle.writeFile(owner);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.unlink(candidate).catch(() => undefined);
    throw error;
  }
}

/**
 * Remove candidate residue left by crashed writers. Candidates are private
 * publish vehicles, never held locks, so this only touches files whose
 * embedded writer pid is dead; the final lock is never considered.
 */
async function reclaimDeadCandidates(lock: string): Promise<void> {
  const dir = path.dirname(lock);
  const prefix = `${path.basename(lock)}.candidate-`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const pid = CANDIDATE_PID.exec(name);
    if (pid && processAlive(Number.parseInt(pid[1]!, 10))) continue;
    await fs.unlink(path.join(dir, name)).catch(() => undefined);
  }
}

function parseOwner(content: string): { pid: number; nonce: string } | null {
  const match = /^(\d+) (\S+)\n?$/.exec(content);
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isInteger(pid) && pid > 0 ? { pid, nonce: match[2]! } : null;
}

function segment(value: string): string {
  if (!SAFE_SEGMENT.test(value))
    throw new Error(`unsafe session key segment: ${value}`);
  return value;
}

async function mkdirPrivate(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32")
    await fs.chmod(dir, 0o700).catch(() => undefined);
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is best-effort; some platforms/filesystems refuse it.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
