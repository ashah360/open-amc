export interface RequestInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** Resolved proxy URL for home egress, or undefined for direct. Never logged. */
  proxyUrl?: string;
  verifyTLS: boolean;
  followRedirect: boolean;
  timeoutMs: number;
}

export interface ResponseOutput {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  timingMs: number;
  transport: string;
  /** Cookie names mutated by this response (values omitted; safe to log). */
  setCookieNames: string[];
  /**
   * Raw `Set-Cookie` header lines from this response, in order, unparsed. These
   * carry cookie VALUES (e.g. rotated anti-bot sensors) and MUST NOT be logged;
   * they exist so a caller can apply provider cookie rotations to its jar.
   */
  setCookies: string[];
}

export interface Transport {
  readonly name: string;
  request(input: RequestInput): Promise<ResponseOutput>;
  /** Release owned connection pools/resources after the logical workflow. */
  close?(): Promise<void>;
}

type RawHeaders = Record<string, string | string[] | undefined>;

/**
 * Provider-neutral extraction of raw `Set-Cookie` header lines, preserved as
 * separate entries and unparsed. A single response can carry multiple
 * Set-Cookie headers and each may contain an `Expires=<...>,` comma; callers
 * MUST keep them as distinct lines (never comma-join) and MUST NOT log values.
 */
export function extractSetCookieLines(headers: RawHeaders): string[] {
  const raw = headers["set-cookie"] ?? headers["Set-Cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw.slice() : [raw];
}

/** Provider-neutral extraction of mutated cookie NAMES only (safe to log). */
export function extractSetCookieNames(headers: RawHeaders): string[] {
  return extractSetCookieLines(headers).map((c) =>
    (c.split("=")[0] ?? "").trim(),
  );
}
