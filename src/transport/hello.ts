import type { RequestOptions, Response } from "@unreleased/hellojs";
import {
  RequestInput,
  ResponseOutput,
  Transport,
  extractSetCookieLines,
  extractSetCookieNames,
} from "./core";

/**
 * The default HelloJS fingerprint profile. HelloJS ships `chrome147-mac` as its
 * canonical profile; its TLS/H2 signature and browser-identity HTTP headers
 * (User-Agent + client hints + accept-language) travel together. An internally
 * inconsistent fingerprint (a session User-Agent from a different Chrome major
 * than the profile's client hints) is a classic anti-bot tell, so the profile
 * OWNS all browser-identity headers; callers/providers own only cookies, CSRF,
 * and request-context headers.
 */
export const HELLO_PROFILE = "chrome147-mac";

/**
 * Browser-identity header names owned by the profile. A caller/provider MUST NOT
 * set these; the transport strips any such override so the profile's values win.
 */
export const HELLO_IDENTITY_HEADERS: readonly string[] = [
  "user-agent",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "accept-language",
];

/**
 * The HelloJS public runtime surface we depend on. The published `index.d.ts`
 * declares the request function but omits the `profile` request option and the
 * top-level `profiles` registry, even though `index.js` exports both
 * (`module.exports.profiles = require('./lib/profiles')`). We type only what we
 * use here rather than deep-importing internal files, so this stays on the
 * package's supported public entrypoint.
 */
interface HelloProfilesRegistry {
  get(name: string): { name?: string; headers?: Record<string, string> };
  list(): string[];
  register(name: string, profile: unknown): void;
  registerFromPeet(name: string, peetJson: unknown): { name?: string };
}

type HelloRequestFn = ((opts: RequestOptions) => Promise<Response>) & {
  profiles: HelloProfilesRegistry;
  pool?: { closeAll?: () => void };
};

type HelloRequestOptionsWithProfile = RequestOptions & {
  profile?: string;
  h3?: boolean;
};

let cachedHello: HelloRequestFn | null = null;

async function loadHello(): Promise<HelloRequestFn> {
  if (cachedHello) return cachedHello;
  // Loaded lazily so a consumer can construct the client (and use a custom
  // transport) in an environment where HelloJS is not desired without paying
  // its module-load cost up front.
  const mod = (await import("@unreleased/hellojs")) as unknown as {
    default: HelloRequestFn;
  };
  cachedHello = mod.default;
  return cachedHello;
}

function profilesRegistry(hello: HelloRequestFn): HelloProfilesRegistry {
  const registry = hello.profiles;
  if (
    !registry ||
    typeof registry.get !== "function" ||
    typeof registry.register !== "function" ||
    typeof registry.registerFromPeet !== "function"
  ) {
    throw new Error(
      "installed @unreleased/hellojs does not expose the supported profiles registry",
    );
  }
  return registry;
}

/**
 * Register a custom HelloJS fingerprint profile from a captured peet.ws JSON
 * (a full TLS/H2/header fingerprint of a real browser), then select it by name
 * via `new HelloTransport(name)`. This is the supported way to match a browser
 * whose Chrome major differs from the built-in profile. Throws on failure.
 */
export async function registerHelloProfileFromPeet(
  name: string,
  peetJson: unknown,
): Promise<void> {
  const hello = await loadHello();
  profilesRegistry(hello).registerFromPeet(name, peetJson);
}

/** Register an explicit custom fingerprint profile object (advanced/testing). */
export async function registerHelloProfile(
  name: string,
  profile: unknown,
): Promise<void> {
  const hello = await loadHello();
  profilesRegistry(hello).register(name, profile);
}

/**
 * Drop any browser-identity headers a caller tried to set, so the pinned profile
 * remains the sole authority on the fingerprint. Returns a new object.
 */
export function stripProviderIdentityHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const owned = new Set(HELLO_IDENTITY_HEADERS);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!owned.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Close HelloJS's global connection pool. HelloJS keeps pooled sockets alive
 * with a multi-minute idle timeout, which keeps the Node event loop (and a
 * short-lived CLI process) alive after the last response. A process that uses
 * this transport should call this once during shutdown; it is safe when empty.
 */
export async function closeHelloPool(): Promise<void> {
  try {
    const hello = await loadHello();
    hello.pool?.closeAll?.();
  } catch {
    // Nothing loaded / nothing to close: shutdown cleanup is best-effort.
  }
}

export interface HelloTransportOptions {
  /** Registered HelloJS profile name to pin. Defaults to `chrome147-mac`. */
  profile?: string;
  /** Outbound proxy URL passed to HelloJS. Never logged. */
  proxyUrl?: string;
  /**
   * When true (default), a browser-derived fingerprint from the persisted
   * session may replace the pinned profile via {@link HelloTransport.adoptProfile}.
   * A caller that explicitly pinned a manual profile (AMC_HELLO_PROFILE_PATH)
   * sets this false so the manual pin always wins.
   */
  allowFingerprintAdoption?: boolean;
}

/**
 * A transport that can adopt a browser-derived fingerprint. The transport owns
 * both registration and selection, so callers never touch the HelloJS registry
 * directly. Duck-typed so native/custom transports that cannot adopt one remain
 * fully functional (they keep their own signature and fail honestly if their
 * own canary fails).
 */
export interface FingerprintAdoptingTransport extends Transport {
  adoptFingerprint(fingerprint: {
    name: string;
    peet: Record<string, unknown>;
  }): Promise<boolean>;
}

export function isFingerprintAdoptingTransport(
  transport: Transport,
): transport is FingerprintAdoptingTransport {
  return (
    typeof (transport as Partial<FingerprintAdoptingTransport>)
      .adoptFingerprint === "function"
  );
}

/**
 * Number of live (unclosed) HelloTransport instances. HelloJS keeps a single
 * process-global connection pool, so every transport shares it; the pool is
 * drained only when the last live transport closes. Each transport's own
 * `close()` releases exactly its own reference, so closing one transport can
 * never tear down a pool another live transport is still using. Exported for
 * diagnostics and ownership tests.
 */
let helloPoolOwners = 0;
export function helloPoolOwnerCount(): number {
  return helloPoolOwners;
}

/**
 * Node HelloJS transport (public `@unreleased/hellojs`). Certificate
 * verification is ALWAYS enabled and can never be disabled by a caller. A
 * per-request `proxyUrl` (or the transport-level default) is passed via the
 * library's `proxy` option and is never logged.
 */
export class HelloTransport implements FingerprintAdoptingTransport {
  readonly name = "hello";
  private profileName: string;
  private readonly defaultProxyUrl: string | undefined;
  private readonly allowFingerprintAdoption: boolean;
  private closed = false;

  constructor(options: HelloTransportOptions | string = {}) {
    const opts = typeof options === "string" ? { profile: options } : options;
    this.profileName = opts.profile ?? HELLO_PROFILE;
    this.defaultProxyUrl = opts.proxyUrl;
    this.allowFingerprintAdoption = opts.allowFingerprintAdoption ?? true;
    helloPoolOwners += 1;
  }

  /** The fingerprint profile this transport pins (for diagnostics/tests). */
  get profile(): string {
    return this.profileName;
  }

  /**
   * Register a browser-derived fingerprint (sanitized peet material) and pin it
   * as this transport's profile. Returns false (a no-op) when a manual profile
   * was explicitly pinned — so an operator's AMC_HELLO_PROFILE_PATH override
   * always wins — or when registration fails, in which case the transport
   * keeps its current signature and the caller's canary decides. Never logs the
   * fingerprint material.
   */
  async adoptFingerprint(fingerprint: {
    name: string;
    peet: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.allowFingerprintAdoption) return false;
    if (!fingerprint.name) return false;
    try {
      const hello = await loadHello();
      profilesRegistry(hello).registerFromPeet(
        fingerprint.name,
        fingerprint.peet,
      );
    } catch {
      // Registration failure is non-fatal: keep the current profile and let the
      // caller's direct canary decide with the stock signature.
      return false;
    }
    this.profileName = fingerprint.name;
    return true;
  }

  /**
   * Release this transport's own reference to the shared global pool. The pool
   * is drained only when the last live transport closes, so closing one
   * transport never tears down a pool another live transport is still using.
   * Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    helloPoolOwners = Math.max(0, helloPoolOwners - 1);
    if (helloPoolOwners === 0) await closeHelloPool();
  }

  async request(input: RequestInput): Promise<ResponseOutput> {
    const hello = await loadHello();
    const start = performance.now();
    // Enforce the fingerprint invariant: the profile owns UA + client hints +
    // accept-language; strip any provider override so they cannot desync from
    // the pinned TLS/H2 signature.
    const outboundHeaders = stripProviderIdentityHeaders(input.headers);
    const proxyUrl = input.proxyUrl ?? this.defaultProxyUrl;
    const opts: HelloRequestOptionsWithProfile = {
      url: input.url,
      method: input.method,
      headers: outboundHeaders,
      profile: this.profileName,
      body: input.body,
      followRedirect: input.followRedirect,
      maxRedirects: input.followRedirect ? 5 : 0,
      timeout: input.timeoutMs,
      // Per-phase timeouts keep sequential reads reliable rather than relying on
      // a single overall timeout.
      timeouts: {
        connect: Math.min(6000, input.timeoutMs),
        tlsHandshake: Math.min(6000, input.timeoutMs),
        response: input.timeoutMs,
      },
      // Keep sequential reads reliable over h2; QUIC/h3 has caused read stalls
      // against these anti-bot targets.
      h3: false,
      // Security invariant: TLS verification is forced on regardless of input.
      verifyTLS: true,
      resolveWithFullResponse: true,
      simple: false,
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
    };

    // Hard wall-clock timeout: against a plain-HTTP or unreachable endpoint the
    // underlying handshake can stall past the library timeout, so we fail
    // honestly rather than hang.
    const res = await withTimeout(
      hello(opts as RequestOptions),
      input.timeoutMs + 2000,
      input.url,
    );
    const headers = normalizeHeaders(res.headers);
    return {
      status: res.statusCode ?? res.status,
      headers,
      bodyText:
        typeof res.body === "string"
          ? res.body
          : (res.rawBody?.toString("utf8") ?? ""),
      timingMs: Math.round(performance.now() - start),
      transport: this.name,
      setCookieNames: extractSetCookieNames(res.headers),
      setCookies: extractSetCookieLines(res.headers),
    };
  }
}

async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  url: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`hello transport timed out after ${ms}ms for ${url}`)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function normalizeHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}
