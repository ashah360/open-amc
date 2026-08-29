import { ResponseOutput } from "../transport";

// A single source of truth for what counts as a TRANSIENT anti-bot/egress
// hiccup worth exactly one bounded, same-session re-dispatch on a READ or the
// auth canary. Shared by graphql-reads and auth-probe so the two never drift.
// Deliberately narrow: writes never use this, and a programmer/contract error
// keeps its identity and is never retried.

/** Transient HTTP statuses worth exactly one same-session retry. */
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

// Exact socket/DNS/TLS/undici failure codes (plus the ECONN* family) that count
// as a transient transport hiccup. NOT a catch-all: e.g. ERR_INVALID_ARG_TYPE
// is a programmer error and must never be retried.
const TRANSIENT_TRANSPORT_CODES = new Set([
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "EPIPE",
]);
const TRANSIENT_TRANSPORT_CODE_PREFIXES = [
  "ECONN",
  "UND_ERR_",
  "ERR_TLS_",
  "ERR_SSL_",
];

function looksLikeJson(body: string): boolean {
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/**
 * A first response that is a transient anti-bot/egress hiccup rather than a
 * real answer: a transient HTTP status, or an HTTP 200 whose body is not JSON
 * (an interstitial page). A genuine challenge (403/429 with challenge markers)
 * is also transient-retryable here; if it persists, the caller's own challenge
 * classification still runs on the second response.
 */
export function isTransientResponse(response: ResponseOutput): boolean {
  if (TRANSIENT_STATUS.has(response.status)) return true;
  if (response.status === 200 && !looksLikeJson(response.bodyText)) return true;
  return false;
}

/** A transport-level throw (TLS/socket/DNS/timeout) worth one same-session retry. */
export function isTransientTransportThrow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_TRANSPORT_CODES.has(code)) return true;
    return TRANSIENT_TRANSPORT_CODE_PREFIXES.some((prefix) =>
      code.startsWith(prefix),
    );
  }
  return /TLS fatal|SSL routines|hello transport timed out/i.test(
    error.message,
  );
}
