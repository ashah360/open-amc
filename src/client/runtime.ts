import {
  AuthAdapter,
  FileSessionStore,
  SessionDecodeError,
  SessionKey,
  SessionManager,
  SessionStore,
} from "../auth-session";
import { Transport, isFingerprintAdoptingTransport } from "../transport";
import { AmcFingerprintProfile } from "./fingerprint";
import { AmcAuthRejectedError, AmcChallengeError, AmcClient } from "./client";
import { AmcBrowserRefresher } from "./browser-refresh";
import { AmcGraphAuthProbe } from "./auth-probe";
import {
  AmcSessionRefresher,
  DirectAdmissionError,
  DirectAdmissionRequiresBrowserError,
  DirectFirstAmcSessionRefresher,
  DirectQueueItSessionRefresher,
} from "./direct-session-refresh";
import { AmcGraphReadClient, AmcSeatLayoutBatch } from "./graphql-reads";
import {
  AMC_ORIGIN,
  AmcSession,
  applySetCookieLines,
  cookieHeaderFor,
  decodeAmcBootstrap,
  decodeAmcSession,
  encodeAmcSession,
} from "./session";
import { AmcSeatingLayout } from "./seat-layout";
import {
  AmcShowtime,
  AmcShowtimeQuery,
  AmcVenueRegistry,
  resolveVenue,
} from "./showtimes";

export const AMC_SESSION_KEY: SessionKey = {
  provider: "amc",
  account: "personal",
};

export class AmcBootstrapRequiredError extends Error {
  readonly code = "AMC_BOOTSTRAP_REQUIRED";
}

/**
 * Raised when routine bounded direct Queue-it repair cannot establish a usable
 * session without a browser: a real interactive waiting room / Cloudflare
 * challenge, a typed direct-admission failure, or a transport-level (TLS /
 * network) block of the admission requests themselves. Routine reads, order
 * lookups, and extend-expiration surface this stable code instead of raw
 * admission or transport errors, and never autonomously open a browser.
 */
export class AmcSessionRepairRequiredError extends Error {
  readonly code = "AMC_SESSION_REPAIR_REQUIRED";
  constructor(
    readonly stage:
      | "target-challenge"
      | "waiting-room"
      | "queue-challenge"
      | "direct-admission"
      | "direct-transport"
      | "listing-url-required",
  ) {
    super(
      `AMC session repair is required (${stage}); run \`amc auth repair --listing-url <official AMC theater URL> --browser-channel chrome --json\` (or --browser-executable/--cdp-url)`,
    );
  }
}

/**
 * Wraps the bounded direct Queue-it refresher so that, absent a browser
 * capability, any failure of the direct admission itself — browser-required
 * challenge, typed admission failure, or a transport/TLS error on the
 * admission requests — surfaces the stable typed AmcSessionRepairRequiredError.
 * Errors are mapped ONLY here, inside the admission attempt; failures of
 * ordinary reads on an already-validated session never pass through this
 * class and keep their original raw/typed errors.
 */
class DirectOnlySessionRefresher implements AmcSessionRefresher {
  constructor(private readonly direct: AmcSessionRefresher) {}
  async refresh(previous?: AmcSession | null): Promise<AmcSession> {
    try {
      return await this.direct.refresh(previous);
    } catch (error) {
      if (error instanceof DirectAdmissionRequiresBrowserError) {
        throw new AmcSessionRepairRequiredError(error.stage);
      }
      if (error instanceof DirectAdmissionError) {
        throw new AmcSessionRepairRequiredError("direct-admission");
      }
      if (isTransportLevelFailure(error)) {
        throw new AmcSessionRepairRequiredError("direct-transport");
      }
      throw error;
    }
  }
}

// Exact socket/DNS/TLS/undici failure codes (plus the ECONN* family) that
// count as the transport itself blocking direct admission. Deliberately NOT a
// catch-all E*/ERR_* match: programmer errors like ERR_INVALID_ARG_TYPE and
// typed provider/contract errors must keep their original identity.
const TRANSPORT_FAILURE_CODES = new Set([
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "EPIPE",
]);
const TRANSPORT_FAILURE_CODE_PREFIXES = [
  "ECONN",
  "UND_ERR_",
  "ERR_TLS_",
  "ERR_SSL_",
];

/**
 * Conservative detection of transport-level (socket/TLS/DNS) failures raised
 * while performing direct admission requests.
 */
function isTransportLevelFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSPORT_FAILURE_CODES.has(code)) return true;
    if (
      TRANSPORT_FAILURE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
    ) {
      return true;
    }
    // A concrete non-transport code is decisive; do not fall through to the
    // message heuristic.
    return false;
  }
  return /TLS fatal|SSL routines/i.test(error.message);
}

export interface AmcRuntimeOptions {
  transport: Transport;
  store?: SessionStore;
  browserRefresher?: AmcBrowserRefresher;
  sessionRefresher?: AmcSessionRefresher;
  readMode?: "graphql" | "ssr";
  venues?: AmcVenueRegistry;
  /**
   * Optional initial official AMC listing URL used for direct admission and
   * the SSR canary. There is NO built-in venue default; when absent, the URL
   * is learned dynamically from the caller's showtimes query (theater-URL
   * descriptor), and admission without one fails with
   * AMC_SESSION_REPAIR_REQUIRED (listing-url-required).
   */
  listingUrl?: string;
}

export interface AmcAuthStatus {
  provider: "amc";
  account: "personal";
  status: "missing" | "valid" | "stale" | "challenged";
  instruction?: string;
}

export interface AmcSessionContext {
  session: AmcSession;
  persistSetCookies(url: string, lines: readonly string[]): Promise<void>;
}

export class AmcRuntime {
  private readonly store: SessionStore;
  private readonly manager: SessionManager<AmcSession, true>;
  private readonly graphReads: AmcGraphReadClient;
  private readonly pendingValidationRotations = new WeakMap<
    AmcSession,
    Array<{ url: string; lines: readonly string[] }>
  >();

  /**
   * The official listing URL driving direct admission and the SSR canary.
   * Seeded from options.listingUrl and updated dynamically from every
   * showtimes query whose venue descriptor carries a listing path. Never a
   * built-in venue.
   */
  private admissionListingUrl: string | null;
  private adoptedFingerprintName: string | null = null;

  constructor(private readonly options: AmcRuntimeOptions) {
    this.store = options.store ?? new FileSessionStore();
    this.admissionListingUrl = options.listingUrl ?? null;
    // AUTOMATIC repair (routine reads / validate retries) is ALWAYS direct-only,
    // even when a browser capability is configured, so an ordinary showtimes or
    // inventory challenge can never autonomously open a browser. Admission runs
    // against the dynamically-known official listing URL; without one it fails
    // with the stable repair-required code instead of assuming any venue. An
    // injected sessionRefresher (advanced/testing) overrides the automatic path.
    const automaticDirect: AmcSessionRefresher = {
      refresh: (previous) => this.directRefresher().refresh(previous),
    };
    const automaticRefresher =
      options.sessionRefresher ??
      new DirectOnlySessionRefresher(automaticDirect);
    this.manager = new SessionManager(
      new AmcAuthAdapter(
        options.transport,
        automaticRefresher,
        this.pendingValidationRotations,
        options.readMode === "graphql" ? "graphql" : "ssr",
        () => this.admissionListingPath(),
        (session) => this.adoptFingerprint(session.fingerprint),
      ),
      this.store,
    );
    this.graphReads = new AmcGraphReadClient({
      transport: options.transport,
      store: this.store,
      repairSession: () => this.manager.forceRefresh(),
      onSessionLoaded: (session) => this.adoptFingerprint(session.fingerprint),
      ...(options.venues ? { venues: options.venues } : {}),
    });
  }

  /**
   * Register and adopt a browser-derived fingerprint on the direct transport
   * before it is used for the canary and subsequent reads, so a persisted
   * session self-aligns the direct signature (including in a fresh CLI
   * process). Idempotent per profile name; a no-op for transports that cannot
   * adopt one (native/custom) or when a manual profile is pinned.
   */
  private async adoptFingerprint(
    fingerprint?: AmcFingerprintProfile,
  ): Promise<void> {
    if (!fingerprint) return;
    if (this.adoptedFingerprintName === fingerprint.name) return;
    if (!isFingerprintAdoptingTransport(this.options.transport)) return;
    if (await this.options.transport.adoptFingerprint(fingerprint)) {
      this.adoptedFingerprintName = fingerprint.name;
    }
  }

  getShowtimes(query: AmcShowtimeQuery): Promise<AmcShowtime[]> {
    // The caller's theater drives everything dynamic: remember its official
    // listing URL so direct admission for THIS read (and later reads in the
    // session) targets exactly that theater, never a built-in venue.
    this.rememberListing(query.venue);
    if (this.options.readMode === "graphql")
      return this.graphReads.getShowtimes(query);
    return this.withRead((session) => this.client(session).getShowtimes(query));
  }

  /** Learn the admission listing URL from a resolvable venue reference. */
  private rememberListing(venue: AmcShowtimeQuery["venue"]): void {
    try {
      const definition = resolveVenue(venue, this.options.venues ?? {});
      if (definition.path) {
        this.admissionListingUrl = `${AMC_ORIGIN}${definition.path}`;
      }
    } catch {
      // An unresolvable venue key is the read's own typed failure; it must
      // never silently fall back to some default theater here.
    }
  }

  private admissionListingPath(): string | null {
    if (!this.admissionListingUrl) return null;
    return new URL(this.admissionListingUrl).pathname;
  }

  /** Direct Queue-it admission against the dynamically-known listing URL. */
  private directRefresher(listingUrl?: string): AmcSessionRefresher {
    const url = listingUrl ?? this.admissionListingUrl;
    if (!url) {
      throw new AmcSessionRepairRequiredError("listing-url-required");
    }
    return new DirectQueueItSessionRefresher(this.options.transport, {
      listingUrl: url,
    });
  }

  getSeatLayout(showtimeId: string): Promise<AmcSeatingLayout> {
    if (this.options.readMode === "graphql")
      return this.graphReads.getSeatLayout(showtimeId);
    return this.withRead((session) =>
      this.client(session).getSeatLayout(showtimeId),
    );
  }

  getSeatLayouts(showtimeIds: readonly string[]): Promise<AmcSeatLayoutBatch> {
    if (this.options.readMode !== "graphql") {
      throw new Error("AMC multi-showtime seats require GraphQL read mode");
    }
    return this.graphReads.getSeatLayouts(showtimeIds);
  }

  /**
   * Explicit, opt-in session repair. Performs bounded direct Queue-it admission
   * and, only when a browser capability was injected at construction OR passed
   * here for this call, browser bootstrap — for both browser-required
   * challenges and typed deterministic direct-admission failures. Without a
   * browser capability, either throws AmcSessionRepairRequiredError. A command-local
   * `browserRefresher`/`listingUrl` never affects automatic read repair, and an
   * injected `sessionRefresher` (advanced/testing) always wins. Whatever
   * refresher produced the session, the fresh jar is validated by the direct
   * auth/read canary before it is persisted or reported as success.
   */
  async repairSession(options?: {
    browserRefresher?: AmcBrowserRefresher;
    listingUrl?: string;
  }): Promise<void> {
    if (this.options.sessionRefresher) {
      await this.manager.refreshWith(this.options.sessionRefresher);
      return;
    }
    const listingUrl = options?.listingUrl ?? this.admissionListingUrl;
    const browser = options?.browserRefresher ?? this.options.browserRefresher;
    if (!listingUrl) {
      // Direct admission is never venue-neutral: without an official listing
      // URL there is nothing safe to admit against. A deliberately configured
      // browser capability (which carries its own listing URL) may still
      // repair; otherwise instruct the caller to pass --listing-url.
      if (!browser) {
        throw new AmcSessionRepairRequiredError("listing-url-required");
      }
      await this.manager.refreshWith(browser);
      return;
    }
    if (options?.listingUrl) this.admissionListingUrl = options.listingUrl;
    const direct = this.directRefresher(listingUrl);
    const refresher = browser
      ? new DirectFirstAmcSessionRefresher(direct, browser)
      : new DirectOnlySessionRefresher(direct);
    await this.manager.refreshWith(refresher);
  }

  withAuthenticatedRead<T>(
    operation: (context: AmcSessionContext) => Promise<T>,
  ): Promise<T> {
    return this.manager.withRead(async (session) => {
      await this.flushValidationRotations(session);
      return operation(this.sessionContext(session));
    });
  }

  withAuthenticatedWrite<T>(
    operation: (context: AmcSessionContext) => Promise<T>,
  ): Promise<T> {
    return this.manager.withWrite(async (session) => {
      await this.flushValidationRotations(session);
      return operation(this.sessionContext(session));
    });
  }

  private withRead<T>(read: (session: AmcSession) => Promise<T>): Promise<T> {
    return this.withAuthenticatedRead(({ session }) => read(session));
  }

  private async flushValidationRotations(session: AmcSession): Promise<void> {
    const pending = this.pendingValidationRotations.get(session) ?? [];
    this.pendingValidationRotations.delete(session);
    for (const rotation of pending) {
      await persistRotations(session, rotation.url, rotation.lines, this.store);
    }
  }

  private sessionContext(session: AmcSession): AmcSessionContext {
    return {
      session,
      persistSetCookies: (url, lines) =>
        persistRotations(session, url, lines, this.store),
    };
  }

  private client(session: AmcSession): AmcClient {
    return new AmcClient({
      transport: this.options.transport,
      cookieHeader: (url) => cookieHeaderFor(session, url),
      onSuccessfulRead: (url, lines) =>
        persistRotations(session, url, lines, this.store),
      ...(this.options.venues ? { venues: this.options.venues } : {}),
    });
  }
}

/**
 * Load the persisted AMC session and, if it carries a browser-derived
 * fingerprint, register and adopt it on the direct transport before any read.
 * This is the fresh-process choke point that makes a later CLI invocation
 * self-align the direct signature without AMC_HELLO_PROFILE_PATH. A no-op for
 * transports that cannot adopt one, when no session/fingerprint exists, or when
 * a manual profile is pinned (the transport refuses adoption). Never throws on
 * a malformed record; best-effort by design.
 */
export async function adoptPersistedFingerprint(
  transport: Transport,
  store: SessionStore = new FileSessionStore(),
): Promise<boolean> {
  if (!isFingerprintAdoptingTransport(transport)) return false;
  let fingerprint: AmcFingerprintProfile | undefined;
  try {
    const bytes = await store.load(AMC_SESSION_KEY);
    if (bytes === null) return false;
    fingerprint = decodeAmcSession(bytes).fingerprint;
  } catch {
    return false;
  }
  if (!fingerprint) return false;
  return transport.adoptFingerprint(fingerprint);
}

export async function bootstrapAmcSession(
  bytes: Uint8Array,
  transport: Transport,
  store: SessionStore = new FileSessionStore(),
  canaryMode: "graphql" | "ssr" = "ssr",
  // SSR canary only: official listing path resolved from the caller's theater
  // URL. There is no built-in venue default.
  listingPath?: string,
): Promise<void> {
  const imported = decodeAmcBootstrap(bytes);
  await store.withRefreshLock(AMC_SESSION_KEY, async () => {
    let validated = imported;
    const onSuccessfulRead = async (
      url: string,
      lines: readonly string[],
    ): Promise<void> => {
      validated = applySetCookieLines(validated, url, lines);
    };
    if (canaryMode === "graphql") {
      await new AmcGraphAuthProbe({
        transport,
        cookieHeader: (url) => cookieHeaderFor(imported, url),
        onSuccessfulRead,
      }).check();
    } else {
      await new AmcClient({
        transport,
        cookieHeader: (url) => cookieHeaderFor(imported, url),
        onSuccessfulRead,
        ...(listingPath ? { accessCheckPath: listingPath } : {}),
      }).checkAccess();
    }
    await store.save(AMC_SESSION_KEY, encodeAmcSession(validated));
  });
}

export async function getAmcAuthStatus(
  transport: Transport,
  store: SessionStore = new FileSessionStore(),
  canaryMode: "graphql" | "ssr" = "ssr",
  // SSR canary only: official listing path resolved from the caller's theater
  // URL. There is no built-in venue default.
  listingPath?: string,
): Promise<AmcAuthStatus> {
  const bytes = await store.load(AMC_SESSION_KEY);
  if (bytes === null) return status("missing");
  let session: AmcSession;
  try {
    session = decodeAmcSession(bytes);
  } catch (error) {
    if (error instanceof SessionDecodeError) return status("stale");
    throw error;
  }
  try {
    if (canaryMode === "graphql") {
      await new AmcGraphAuthProbe({
        transport,
        cookieHeader: (url) => cookieHeaderFor(session, url),
      }).check();
    } else {
      await new AmcClient({
        transport,
        cookieHeader: (url) => cookieHeaderFor(session, url),
        ...(listingPath ? { accessCheckPath: listingPath } : {}),
      }).checkAccess();
    }
    return status("valid");
  } catch (error) {
    if (error instanceof AmcChallengeError) {
      return {
        ...status("challenged"),
        instruction:
          "Run `amc auth bootstrap --from <file|->` with a fresh scoped browser bundle.",
      };
    }
    if (
      error instanceof AmcAuthRejectedError ||
      error instanceof AmcBootstrapRequiredError
    ) {
      return {
        ...status("stale"),
        instruction:
          "Run `amc auth bootstrap --from <file|->` with a fresh scoped browser bundle.",
      };
    }
    throw error;
  }
}

export async function clearAmcSession(
  store: SessionStore = new FileSessionStore(),
): Promise<void> {
  await store.remove(AMC_SESSION_KEY);
}

class AmcAuthAdapter implements AuthAdapter<AmcSession, true> {
  readonly key = AMC_SESSION_KEY;

  constructor(
    private readonly transport: Transport,
    private readonly sessionRefresher: AmcSessionRefresher,
    private readonly pendingValidationRotations: WeakMap<
      AmcSession,
      Array<{ url: string; lines: readonly string[] }>
    >,
    private readonly canaryMode: "graphql" | "ssr",
    private readonly listingPathProvider: () => string | null = () => null,
    private readonly adoptFingerprint: (
      session: AmcSession,
    ) => Promise<void> = async () => undefined,
  ) {}

  decode(bytes: Uint8Array): AmcSession {
    return decodeAmcSession(bytes);
  }

  encode(session: AmcSession): Uint8Array {
    return encodeAmcSession(session);
  }

  async validate(session: AmcSession): Promise<true> {
    // Adopt any browser-derived fingerprint on the direct transport BEFORE the
    // canary, so the canary (and every later read on this transport) runs with
    // the self-aligned signature. This covers both explicit repair (the fresh
    // session carries the fingerprint) and a fresh process (the persisted
    // session does).
    await this.adoptFingerprint(session);
    const onSuccessfulRead = async (
      url: string,
      lines: readonly string[],
    ): Promise<void> => {
      if (lines.length === 0) return;
      const rotated = applySetCookieLines(session, url, lines);
      session.cookies = rotated.cookies;
      const pending = this.pendingValidationRotations.get(session) ?? [];
      pending.push({ url, lines: [...lines] });
      this.pendingValidationRotations.set(session, pending);
    };
    if (this.canaryMode === "graphql") {
      await new AmcGraphAuthProbe({
        transport: this.transport,
        cookieHeader: (url) => cookieHeaderFor(session, url),
        onSuccessfulRead,
      }).check();
    } else {
      const accessCheckPath = this.listingPathProvider();
      await new AmcClient({
        transport: this.transport,
        cookieHeader: (url) => cookieHeaderFor(session, url),
        onSuccessfulRead,
        ...(accessCheckPath ? { accessCheckPath } : {}),
      }).checkAccess();
    }
    return true;
  }

  refresh(previous: AmcSession | null): Promise<AmcSession> {
    return this.sessionRefresher.refresh(previous);
  }

  verifyIdentity(identity: true): void {
    if (identity !== true) throw new Error("AMC listing canary failed");
  }

  isAuthFailure(error: unknown): boolean {
    return (
      error instanceof AmcAuthRejectedError ||
      error instanceof AmcChallengeError
    );
  }

  sameSession(a: AmcSession, b: AmcSession): boolean {
    return Buffer.from(encodeAmcSession(a)).equals(
      Buffer.from(encodeAmcSession(b)),
    );
  }
}

async function persistRotations(
  session: AmcSession,
  url: string,
  lines: readonly string[],
  store: SessionStore,
): Promise<void> {
  if (lines.length === 0) return;
  await store.withRefreshLock(AMC_SESSION_KEY, async () => {
    const saved = await store.load(AMC_SESSION_KEY);
    // A concurrent clear wins over a stale response; never recreate the jar.
    if (saved === null) return;
    const current = decodeAmcSession(saved);
    const rotated = applySetCookieLines(current, url, lines);
    const encoded = encodeAmcSession(rotated);
    if (!Buffer.from(saved).equals(Buffer.from(encoded))) {
      await store.save(AMC_SESSION_KEY, encoded);
    }
    session.exportedAt = rotated.exportedAt;
    session.cookies = rotated.cookies;
  });
}

function status(value: AmcAuthStatus["status"]): AmcAuthStatus {
  return { provider: "amc", account: "personal", status: value };
}
