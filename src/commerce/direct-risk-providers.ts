import { randomBytes, randomUUID } from "node:crypto";
import { SessionStore } from "../auth-session";
import { AMC_SESSION_KEY } from "../client/runtime";
import { decodeAmcSession, encodeAmcSession } from "../client/session";
import {
  DeviceDataProvider,
  KountSessionProvider,
} from "./direct-braintree-tokenizer";

const AMC_ORIGIN = "https://www.amctheatres.com";
const AMC_REFERER = `${AMC_ORIGIN}/`;
const KOUNT_BASE_URL = "https://ssl.kaptcha.com";
const KOUNT_CLIENT_ID = "602840";
const KOUNT_SDK_VERSION = "2.2.3";
const KOUNT_IMPLEMENTATION = "module";
const KOUNT_REPOSITORY = "npm";

/**
 * Fresh Braintree-shaped correlation metadata without running FraudNet's
 * browser collector. This is intentionally synthetic: the merchant may score
 * or decline it differently, but it is never reused and is not an auth token.
 */
export class SyntheticFraudNetDeviceDataProvider implements DeviceDataProvider {
  constructor(
    private readonly createCorrelationId: () => string = () =>
      randomBytes(16).toString("hex"),
  ) {}

  collect(): Promise<{ deviceData: string; fresh: true }> {
    const correlationId = this.createCorrelationId();
    if (!/^[A-Za-z0-9_-]{32}$/.test(correlationId)) {
      return Promise.reject(
        new Error("AMC synthetic FraudNet correlation ID is invalid"),
      );
    }
    return Promise.resolve({
      deviceData: JSON.stringify({ correlation_id: correlationId }),
      fresh: true,
    });
  }
}

export interface RiskHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export interface RiskHttpTransport {
  request(
    input: RiskHttpRequest,
  ): Promise<{ status: number; bodyText: string }>;
}

export class FetchRiskHttpTransport implements RiskHttpTransport {
  async request(
    input: RiskHttpRequest,
  ): Promise<{ status: number; bodyText: string }> {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      credentials: "omit",
      redirect: "error",
    });
    return { status: response.status, bodyText: await response.text() };
  }
}

export interface KountFirstPartyCookieProvider {
  getCookie(input: {
    orderToken: string;
    sessionId: string;
  }): Promise<string | null>;
  /**
   * Optional durable persistence for a Kount first-party cookie generated via
   * the /cs/generatecookie fallback. Implementations must persist atomically
   * under an exclusive lock so a concurrent session refresh cannot clobber it.
   */
  setCookie?(value: string): Promise<void>;
}

/** Reads Kount's AMC first-party value without exposing any other session data. */
export class StoredAmcKountCookieProvider implements KountFirstPartyCookieProvider {
  constructor(private readonly store: SessionStore) {}

  async getCookie(): Promise<string | null> {
    try {
      const bytes = await this.store.load(AMC_SESSION_KEY);
      if (!bytes) return null;
      const session = decodeAmcSession(bytes);
      const nowSeconds = Date.now() / 1000;
      const cookie = session.cookies.find(
        (candidate) =>
          candidate.name === "clientside-cookie" &&
          [
            "amctheatres.com",
            ".amctheatres.com",
            "www.amctheatres.com",
            ".www.amctheatres.com",
          ].includes(candidate.domain) &&
          !candidate.httpOnly &&
          candidate.secure &&
          candidate.path === "/" &&
          (candidate.expires === -1 || candidate.expires > nowSeconds),
      );
      return cookie?.value ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Persist a freshly generated Kount first-party cookie into the AMC session
   * jar. The write is performed under the store's exclusive refresh lock and
   * re-reads the current jar so a concurrent refresh cannot be clobbered.
   */
  async setCookie(value: string): Promise<void> {
    if (!validCookieValue(value)) {
      throw new Error("AMC Kount cookie value is invalid");
    }
    await this.store.withRefreshLock(AMC_SESSION_KEY, async () => {
      const bytes = await this.store.load(AMC_SESSION_KEY);
      if (!bytes) throw new Error("AMC session is unavailable");
      const session = decodeAmcSession(bytes);
      const cookies = session.cookies.filter(
        (candidate) => candidate.name !== "clientside-cookie",
      );
      cookies.push({
        name: "clientside-cookie",
        value,
        domain: ".amctheatres.com",
        path: "/",
        expires: -1,
        secure: true,
        httpOnly: false,
        sameSite: "Lax",
      });
      await this.store.save(
        AMC_SESSION_KEY,
        encodeAmcSession({
          ...session,
          cookies,
          exportedAt: new Date().toISOString(),
        }),
      );
    });
  }
}

export interface AmcKountSessionProviderOptions {
  http?: RiskHttpTransport;
  firstPartyCookie: KountFirstPartyCookieProvider;
  createKddcgid?: () => string;
}

/**
 * Exact direct initialization sequence observed from AMC's Kount Web Client
 * 2.2.3 integration. This intentionally does not emulate Kount's DOM/iframe
 * collector; it proves only the captured server-side session/config/cookie
 * initialization and fails closed on every missing or rejected step.
 */
export class AmcKountSessionProvider implements KountSessionProvider {
  private readonly http: RiskHttpTransport;
  private readonly createKddcgid: () => string;

  constructor(private readonly options: AmcKountSessionProviderOptions) {
    this.http = options.http ?? new FetchRiskHttpTransport();
    this.createKddcgid = options.createKddcgid ?? randomUUID;
  }

  async initialize(input: {
    orderToken: string;
    sessionId: string;
  }): Promise<{ initialized: boolean; sessionId: string }> {
    const failure = { initialized: false, sessionId: input.sessionId };
    const expectedSessionId = input.orderToken.replace(/[^A-Za-z0-9]/g, "");
    if (!expectedSessionId || input.sessionId !== expectedSessionId)
      return failure;

    const kddcgid = this.createKddcgid();
    if (!isUuid(kddcgid)) return failure;

    try {
      const sessionResponse = await this.http.request({
        url: `${KOUNT_BASE_URL}/session/${input.sessionId}?${query({
          kddcgid,
          impl: KOUNT_IMPLEMENTATION,
          repo: KOUNT_REPOSITORY,
        })}`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "client-id": KOUNT_CLIENT_ID,
          Origin: AMC_ORIGIN,
          Referer: AMC_REFERER,
        },
      });
      if (![200, 201, 404].includes(sessionResponse.status)) return failure;

      const configResponse = await this.http.request({
        url: `${KOUNT_BASE_URL}/cs/config?${query({
          m: KOUNT_CLIENT_ID,
          s: input.sessionId,
          sv: KOUNT_SDK_VERSION,
          kddcgid,
          impl: KOUNT_IMPLEMENTATION,
          repo: KOUNT_REPOSITORY,
        })}`,
        method: "GET",
        headers: {
          Accept: "*/*",
          Referer: AMC_REFERER,
        },
      });
      if (configResponse.status !== 200) return failure;
      const config = parseCollectorConfig(configResponse.bodyText);
      if (!config.valid) return failure;
      // collect=false is a VALID Kount answer meaning "no collection run
      // needed" (the official 2.2.3 client yields {run:false} and stops):
      // initialization is complete with no cookie store/generate step.
      if (!config.collect)
        return { initialized: true, sessionId: input.sessionId };

      const firstPartyCookie =
        await this.options.firstPartyCookie.getCookie(input);
      if (!validCookieValue(firstPartyCookie)) {
        return (await this.generateCookie(input.sessionId, kddcgid))
          ? { initialized: true, sessionId: input.sessionId }
          : failure;
      }
      const cookieResponse = await this.http.request({
        url: `${KOUNT_BASE_URL}/cs/storecookie`,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: AMC_ORIGIN,
          Referer: AMC_REFERER,
        },
        body: query({
          m: KOUNT_CLIENT_ID,
          s: input.sessionId,
          sv: KOUNT_SDK_VERSION,
          k: firstPartyCookie,
          kddcgid,
          impl: KOUNT_IMPLEMENTATION,
          repo: KOUNT_REPOSITORY,
        }),
      });
      // A 500 from storecookie means the stored value was rejected; fall back to
      // provider-side cookie generation and lock-safe persistence.
      if (cookieResponse.status === 500) {
        return (await this.generateCookie(input.sessionId, kddcgid))
          ? { initialized: true, sessionId: input.sessionId }
          : failure;
      }
      if (cookieResponse.status !== 200) return failure;

      return { initialized: true, sessionId: input.sessionId };
    } catch {
      return failure;
    }
  }

  /**
   * /cs/generatecookie fallback: asks Kount to mint a fresh first-party cookie,
   * validates it, and persists it via the injected provider (under its refresh
   * lock). Returns false — fail-closed — on any missing capability, non-200,
   * malformed payload, or invalid value.
   */
  private async generateCookie(
    sessionId: string,
    kddcgid: string,
  ): Promise<boolean> {
    if (!this.options.firstPartyCookie.setCookie) return false;
    const response = await this.http.request({
      url: `${KOUNT_BASE_URL}/cs/generatecookie?${query({
        m: KOUNT_CLIENT_ID,
        s: sessionId,
        sv: KOUNT_SDK_VERSION,
        kddcgid,
        impl: KOUNT_IMPLEMENTATION,
        repo: KOUNT_REPOSITORY,
      })}`,
      method: "GET",
      headers: { Accept: "*/*", Referer: AMC_REFERER },
    });
    if (response.status !== 200) return false;
    let value: unknown;
    try {
      value = (JSON.parse(response.bodyText) as { value?: unknown }).value;
    } catch {
      return false;
    }
    if (typeof value !== "string" || !validCookieValue(value)) return false;
    await this.options.firstPartyCookie.setCookie(value);
    return true;
  }
}

function query(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

const COLLECT_FEATURE_FLAGS = [
  "app",
  "battery",
  "browser",
  "exp",
  "page",
  "ui",
  "passLoc",
] as const;

/**
 * Mirror of the official Kount Web Client 2.2.3 config translation: collection
 * and feature_flags must be present and collect must be boolean; the named
 * feature flags must be booleans ONLY when collect=true. collect=false is a
 * valid "no collection run" answer. Anything else fails closed.
 */
function parseCollectorConfig(
  bodyText: string,
): { valid: true; collect: boolean } | { valid: false } {
  try {
    const value: unknown = JSON.parse(bodyText);
    if (
      !isRecord(value) ||
      !isRecord(value.collection) ||
      value.collection.feature_flags === undefined ||
      typeof value.collection.collect !== "boolean"
    ) {
      return { valid: false };
    }
    if (!value.collection.collect) return { valid: true, collect: false };
    const flags = value.collection.feature_flags;
    if (
      !isRecord(flags) ||
      COLLECT_FEATURE_FLAGS.some((name) => typeof flags[name] !== "boolean")
    ) {
      return { valid: false };
    }
    return { valid: true, collect: true };
  } catch {
    return { valid: false };
  }
}

function validCookieValue(value: string | null): value is string {
  return (
    value !== null && value.length > 0 && !/[\u0000-\u0020;\u007f]/.test(value)
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
