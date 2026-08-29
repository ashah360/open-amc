import { createHash } from "node:crypto";

/**
 * Minimal, non-identifying browser TLS/H2/header fingerprint material derived
 * from a tls.peet.ws capture, safe to persist in the private session record and
 * feed to `profiles.registerFromPeet`. It deliberately EXCLUDES every
 * connection-identifying or ephemeral-secret field (client IP, tcp/ip stack
 * details, donate note, TLS client_random / session_id / key bytes) so the
 * stored artifact reveals only the stable browser signature, never who or where
 * the capture came from.
 */
export interface AmcFingerprintProfile {
  /** Stable, non-secret, hash-derived profile name (safe to log/select). */
  name: string;
  /** The sanitized peet-shaped object passed to `registerFromPeet`. */
  peet: Record<string, unknown>;
}

/** The fixed, documented endpoint browser repair reads to self-align the fingerprint. */
export const PEET_FINGERPRINT_URL = "https://tls.peet.ws/api/all";

/** Hard bound on the raw capture we will even look at (defense against abuse). */
export const MAX_RAW_FINGERPRINT_BYTES = 512 * 1024;
/** Hard bound on the sanitized, persisted profile material. */
export const MAX_SANITIZED_FINGERPRINT_BYTES = 128 * 1024;

/**
 * Peet keys that identify the connection/host and must never persist, stripped
 * wherever they appear (`tcpip` is top-level, but strip defensively anywhere).
 */
const FORBIDDEN_STRUCTURAL = new Set(["ip", "donate", "tcpip"]);

/**
 * Exact ephemeral per-connection secret/randomness fields that must never
 * persist. Matched by exact (case-insensitive) name so structural fields that
 * merely contain the substring "key" (`shared_keys`, `key_share`,
 * `PSK_Key_Exchange_Mode`) are preserved — HelloJS `fromPeet` needs them.
 */
const FORBIDDEN_EXACT_VALUE_KEY = new Set([
  "client_random",
  "session_id",
  "master_secret_data",
  "extended_master_secret_data",
]);

/**
 * A key whose VALUE is a genuine secret/randomness (`*_random`, or anything
 * containing `secret`/`private`). Deliberately does NOT match "key", so
 * structural TLS field names survive.
 */
function isEphemeralValueKey(key: string): boolean {
  const k = key.toLowerCase();
  if (FORBIDDEN_EXACT_VALUE_KEY.has(k)) return true;
  if (/(^|_)random$/.test(k)) return true;
  if (k.includes("secret") || k.includes("private")) return true;
  return false;
}

function isForbiddenKey(key: string): boolean {
  return (
    FORBIDDEN_STRUCTURAL.has(key.toLowerCase()) || isEphemeralValueKey(key)
  );
}

export class FingerprintSanitizeError extends Error {
  readonly code = "AMC_FINGERPRINT_INVALID";
}

/**
 * Validate, bound, and strip a raw tls.peet.ws capture into minimal,
 * non-identifying HelloJS profile material with a stable hash-derived name.
 * Throws {@link FingerprintSanitizeError} on any shape/size violation; never
 * logs and never returns the raw capture.
 */
export function sanitizePeetFingerprint(raw: unknown): AmcFingerprintProfile {
  const rawSize = safeJsonSize(raw);
  if (rawSize === null || rawSize > MAX_RAW_FINGERPRINT_BYTES) {
    throw new FingerprintSanitizeError(
      "fingerprint capture is not serializable JSON within the size bound",
    );
  }
  if (!isRecord(raw)) {
    throw new FingerprintSanitizeError("fingerprint capture is not an object");
  }
  if (!isRecord(raw.tls)) {
    throw new FingerprintSanitizeError("fingerprint capture is missing tls");
  }
  if (typeof raw.user_agent !== "string" || raw.user_agent.trim() === "") {
    throw new FingerprintSanitizeError(
      "fingerprint capture is missing a user_agent",
    );
  }

  const peet = sanitizeNode(raw) as Record<string, unknown>;

  const sanitizedSize = safeJsonSize(peet);
  if (
    sanitizedSize === null ||
    sanitizedSize > MAX_SANITIZED_FINGERPRINT_BYTES
  ) {
    throw new FingerprintSanitizeError(
      "sanitized fingerprint exceeds the size bound",
    );
  }
  assertNoIdentifyingResidue(peet);

  return { name: deriveProfileName(peet), peet };
}

/**
 * Deep copy that drops forbidden keys everywhere and redacts key-share byte
 * values. Structural signature fields (ciphers, extensions, `shared_keys`
 * group names, `key_share`, `PSK_Key_Exchange_Mode`, ja3/ja4/peetprint, http2)
 * are preserved so HelloJS `fromPeet` can rebuild the profile.
 */
function sanitizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeNode);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenKey(key)) continue;
    if (key === "shared_keys" && Array.isArray(child)) {
      out[key] = child.map(redactSharedKeyEntry);
      continue;
    }
    out[key] = sanitizeNode(child);
  }
  return out;
}

/**
 * `fromPeet` reads only the OFFERED group name (`Object.keys(entry)[0]`) from a
 * `shared_keys` entry; the mapped value is ephemeral key bytes. Keep the group
 * name(s) with an empty, non-identifying value.
 */
function redactSharedKeyEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const redacted: Record<string, unknown> = {};
  for (const groupName of Object.keys(entry)) redacted[groupName] = "";
  return redacted;
}

/**
 * Belt-and-suspenders: after stripping, prove no forbidden key name survived
 * anywhere and that no `shared_keys` entry retained a non-empty (key-byte)
 * value. A residual match is a bug, not a recoverable input, so it throws.
 */
function assertNoIdentifyingResidue(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (isForbiddenKey(key)) {
          throw new FingerprintSanitizeError(
            "sanitized fingerprint retained an identifying field",
          );
        }
        if (key === "shared_keys" && Array.isArray(child)) {
          for (const entry of child) {
            if (isRecord(entry) && Object.values(entry).some((v) => v !== "")) {
              throw new FingerprintSanitizeError(
                "sanitized fingerprint retained key-share bytes",
              );
            }
          }
        }
        stack.push(child);
      }
    }
  }
}

/** Stable, non-secret name derived from the sanitized signature only. */
function deriveProfileName(peet: Record<string, unknown>): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(peet))
    .digest("hex")
    .slice(0, 16);
  return `amc-fp-${digest}`;
}

function safeJsonSize(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
