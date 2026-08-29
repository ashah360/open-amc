import { SessionDecodeError } from "../auth-session";
import {
  AmcFingerprintProfile,
  FingerprintSanitizeError,
  sanitizePeetFingerprint,
} from "./fingerprint";

export const AMC_ORIGIN = "https://www.amctheatres.com";
export const AMC_GRAPH_ORIGIN = "https://graph.amctheatres.com";
export const AMC_PROFILE = "chrome147-mac";

export interface AmcCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface AmcSession {
  version: 1;
  origin: typeof AMC_ORIGIN;
  profile: typeof AMC_PROFILE;
  exportedAt: string;
  cookies: AmcCookie[];
  /**
   * Optional browser-derived TLS/H2/header fingerprint that explicit browser
   * repair captured and self-aligned, so a later CLI process adopts the same
   * direct-transport signature automatically. Always sanitized on decode; a
   * malformed/identifying value is dropped rather than trusted.
   */
  fingerprint?: AmcFingerprintProfile;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ALLOWED_DOMAINS = new Set([
  ".amctheatres.com",
  "amctheatres.com",
  "www.amctheatres.com",
  ".www.amctheatres.com",
  "graph.amctheatres.com",
  ".graph.amctheatres.com",
]);

export function decodeAmcSession(bytes: Uint8Array): AmcSession {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new SessionDecodeError("AMC session shape drifted: expected JSON");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.origin !== AMC_ORIGIN ||
    value.profile !== AMC_PROFILE ||
    typeof value.exportedAt !== "string" ||
    !validTimestamp(value.exportedAt) ||
    !Array.isArray(value.cookies)
  ) {
    throw new SessionDecodeError("AMC session shape drifted");
  }
  const cookies = value.cookies.map((cookie, index) =>
    decodeCookie(cookie, index),
  );
  const fingerprint = decodeFingerprint(value.fingerprint);
  return {
    version: 1,
    origin: AMC_ORIGIN,
    profile: AMC_PROFILE,
    exportedAt: value.exportedAt,
    cookies,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

/**
 * Decode a persisted fingerprint defensively: it is re-sanitized through the
 * same stripper so a tampered/legacy record can never reintroduce identifying
 * fields, and its persisted name must match the freshly derived one. Anything
 * off is dropped (returns undefined) rather than trusted.
 */
function decodeFingerprint(value: unknown): AmcFingerprintProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  try {
    const resanitized = sanitizePeetFingerprint(value.peet);
    if (resanitized.name !== value.name) return undefined;
    return resanitized;
  } catch (error) {
    if (error instanceof FingerprintSanitizeError) return undefined;
    throw error;
  }
}

export function encodeAmcSession(session: AmcSession): Uint8Array {
  const validated = decodeAmcSession(
    Buffer.from(JSON.stringify(session), "utf8"),
  );
  return Buffer.from(JSON.stringify(validated), "utf8");
}

/**
 * Bootstrap-only decoder. Persisted sessions always go through the stricter
 * decodeAmcSession contract; this additionally accepts Network.getAllCookies
 * output and normalizes browser-specific optional/fractional fields once.
 */
export function decodeAmcBootstrap(
  bytes: Uint8Array,
  exportedAt: Date = new Date(),
): AmcSession {
  const value = parseJson(bytes, "AMC bootstrap shape drifted: expected JSON");
  if (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "version")
  ) {
    return decodeAmcSession(bytes);
  }
  if (!isRecord(value) || !Array.isArray(value.cookies)) {
    throw new SessionDecodeError("AMC bootstrap shape drifted");
  }
  if (!Number.isFinite(exportedAt.valueOf())) {
    throw new SessionDecodeError("AMC bootstrap exportedAt drifted");
  }

  const cookies: AmcCookie[] = [];
  for (const [index, rawCookie] of value.cookies.entries()) {
    if (!isRecord(rawCookie) || typeof rawCookie.domain !== "string") {
      throw new SessionDecodeError(`AMC bootstrap cookie ${index} drifted`);
    }
    const domain = rawCookie.domain.toLowerCase();
    if (!ALLOWED_DOMAINS.has(domain)) continue;
    if (
      typeof rawCookie.name !== "string" ||
      !COOKIE_NAME.test(rawCookie.name) ||
      typeof rawCookie.value !== "string" ||
      hasCookieValueInvalidCharacter(rawCookie.value) ||
      typeof rawCookie.path !== "string" ||
      !rawCookie.path.startsWith("/") ||
      hasControlOrSemicolon(rawCookie.path) ||
      typeof rawCookie.expires !== "number" ||
      !Number.isFinite(rawCookie.expires) ||
      typeof rawCookie.secure !== "boolean" ||
      typeof rawCookie.httpOnly !== "boolean" ||
      typeof rawCookie.session !== "boolean"
    ) {
      throw new SessionDecodeError(`AMC bootstrap cookie ${index} drifted`);
    }
    cookies.push({
      name: rawCookie.name,
      value: rawCookie.value,
      domain,
      path: rawCookie.path,
      expires:
        rawCookie.session || rawCookie.expires <= 0
          ? -1
          : Math.floor(rawCookie.expires),
      secure: rawCookie.secure,
      httpOnly: rawCookie.httpOnly,
      sameSite: isSameSite(rawCookie.sameSite) ? rawCookie.sameSite : "Lax",
    });
  }
  if (cookies.length === 0) {
    throw new SessionDecodeError(
      "AMC bootstrap contains no allowed AMC cookies",
    );
  }
  const session: AmcSession = {
    version: 1,
    origin: AMC_ORIGIN,
    profile: AMC_PROFILE,
    exportedAt: exportedAt.toISOString(),
    cookies,
  };
  return decodeAmcSession(encodeAmcSession(session));
}

export function cookieHeaderFor(
  session: AmcSession,
  rawUrl: string,
  nowSeconds = Date.now() / 1000,
): string {
  const url = allowedUrl(rawUrl);
  return session.cookies
    .map((cookie, index) => ({ cookie, index }))
    .filter(({ cookie }) => cookieMatches(cookie, url, nowSeconds))
    .sort(
      (a, b) =>
        b.cookie.path.length - a.cookie.path.length || a.index - b.index,
    )
    .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function applySetCookieLines(
  session: AmcSession,
  rawUrl: string,
  lines: readonly string[],
  nowMs = Date.now(),
): AmcSession {
  const url = allowedUrl(rawUrl);
  const cookies = session.cookies.map((cookie) => ({ ...cookie }));
  for (const line of lines) {
    const parsed = parseSetCookie(line, url, nowMs);
    if (!parsed) continue;
    const index = cookies.findIndex(
      (cookie) =>
        cookie.name === parsed.cookie.name &&
        cookie.domain === parsed.cookie.domain &&
        cookie.path === parsed.cookie.path,
    );
    if (parsed.delete) {
      if (index >= 0) cookies.splice(index, 1);
    } else if (index >= 0) {
      cookies[index] = parsed.cookie;
    } else {
      cookies.push(parsed.cookie);
    }
  }
  return { ...session, cookies };
}

function decodeCookie(value: unknown, index: number): AmcCookie {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !COOKIE_NAME.test(value.name) ||
    typeof value.value !== "string" ||
    hasCookieValueInvalidCharacter(value.value) ||
    typeof value.domain !== "string" ||
    !ALLOWED_DOMAINS.has(value.domain.toLowerCase()) ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    hasControlOrSemicolon(value.path) ||
    typeof value.expires !== "number" ||
    !Number.isInteger(value.expires) ||
    value.expires < -1 ||
    typeof value.secure !== "boolean" ||
    typeof value.httpOnly !== "boolean" ||
    !isSameSite(value.sameSite)
  ) {
    throw new SessionDecodeError(
      `AMC session shape drifted at cookie ${index}`,
    );
  }
  return {
    name: value.name,
    value: value.value,
    domain: value.domain.toLowerCase(),
    path: value.path,
    expires: value.expires,
    secure: value.secure,
    httpOnly: value.httpOnly,
    sameSite: value.sameSite,
  };
}

function cookieMatches(
  cookie: AmcCookie,
  url: URL,
  nowSeconds: number,
): boolean {
  if (cookie.expires !== -1 && cookie.expires <= nowSeconds) return false;
  if (cookie.secure && url.protocol !== "https:") return false;
  const domain = cookie.domain.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const domainMatches = domain.startsWith(".")
    ? hostname === domain.slice(1) || hostname.endsWith(domain)
    : hostname === domain;
  if (!domainMatches) return false;
  if (!url.pathname.startsWith(cookie.path)) return false;
  return (
    cookie.path.endsWith("/") ||
    url.pathname.length === cookie.path.length ||
    url.pathname[cookie.path.length] === "/"
  );
}

function parseSetCookie(
  line: string,
  url: URL,
  nowMs: number,
): { cookie: AmcCookie; delete: boolean } | null {
  const parts = line.split(";");
  const pair = parts.shift()?.trim();
  if (!pair) return null;
  const equals = pair.indexOf("=");
  if (equals <= 0) return null;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (!COOKIE_NAME.test(name) || hasCookieValueInvalidCharacter(value))
    return null;

  let domain = url.hostname.toLowerCase();
  let cookiePath = defaultCookiePath(url.pathname);
  let expires = -1;
  let secure = false;
  let httpOnly = false;
  let sameSite: AmcCookie["sameSite"] = "Lax";
  let maxAge: number | null = null;

  for (const rawAttribute of parts) {
    const attribute = rawAttribute.trim();
    if (!attribute) continue;
    const split = attribute.indexOf("=");
    const key = (split < 0 ? attribute : attribute.slice(0, split))
      .trim()
      .toLowerCase();
    const rawValue = split < 0 ? "" : attribute.slice(split + 1).trim();
    if (key === "domain") {
      const candidate = rawValue.toLowerCase();
      const normalized = candidate.startsWith(".")
        ? candidate
        : `.${candidate}`;
      if (!ALLOWED_DOMAINS.has(candidate) && !ALLOWED_DOMAINS.has(normalized))
        return null;
      if (
        url.hostname.toLowerCase() !== candidate.replace(/^\./, "") &&
        !url.hostname.toLowerCase().endsWith(normalized)
      ) {
        return null;
      }
      domain = normalized;
    } else if (key === "path" && rawValue.startsWith("/")) {
      cookiePath = rawValue;
    } else if (key === "expires") {
      const parsed = Date.parse(rawValue);
      if (Number.isFinite(parsed)) expires = Math.floor(parsed / 1000);
    } else if (key === "max-age" && /^-?\d+$/.test(rawValue)) {
      maxAge = Number.parseInt(rawValue, 10);
    } else if (key === "secure") {
      secure = true;
    } else if (key === "httponly") {
      httpOnly = true;
    } else if (key === "samesite") {
      const canonical = `${rawValue.slice(0, 1).toUpperCase()}${rawValue.slice(1).toLowerCase()}`;
      if (isSameSite(canonical)) sameSite = canonical;
    }
  }
  if (maxAge !== null)
    expires = maxAge <= 0 ? 0 : Math.floor(nowMs / 1000) + maxAge;
  const cookie: AmcCookie = {
    name,
    value,
    domain,
    path: cookiePath,
    expires,
    secure,
    httpOnly,
    sameSite,
  };
  if (!ALLOWED_DOMAINS.has(cookie.domain)) return null;
  return {
    cookie,
    delete: expires !== -1 && expires <= Math.floor(nowMs / 1000),
  };
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function allowedUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.origin !== AMC_ORIGIN && url.origin !== AMC_GRAPH_ORIGIN) {
    throw new Error("AMC session URL is outside the allowed origin");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(bytes: Uint8Array, message: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new SessionDecodeError(message);
  }
}

function validTimestamp(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isSameSite(value: unknown): value is AmcCookie["sameSite"] {
  return value === "Strict" || value === "Lax" || value === "None";
}

function hasCookieValueInvalidCharacter(value: string): boolean {
  return value.includes(";") || hasControlCharacter(value);
}

function hasControlOrSemicolon(value: string): boolean {
  return value.includes(";") || hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
