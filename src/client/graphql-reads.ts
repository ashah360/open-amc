import {
  FileSessionStore,
  SessionDecodeError,
  SessionKey,
  SessionStore,
} from "../auth-session";
import { ResponseOutput, Transport } from "../transport";
import { AmcChallengeError, AmcHttpError } from "./client";
import {
  AMC_GRAPH_ORIGIN,
  AMC_ORIGIN,
  AMC_PROFILE,
  AmcSession,
  applySetCookieLines,
  cookieHeaderFor,
  decodeAmcSession,
  encodeAmcSession,
} from "./session";
import {
  AmcSeatSlot,
  AmcSeatType,
  AmcSeatingLayout,
  AmcTicketPrice,
} from "./seat-layout";
import {
  AmcShowtime,
  AmcShowtimeQuery,
  AmcVenueRegistry,
  resolveVenue,
} from "./showtimes";

const GRAPHQL_URL = `${AMC_GRAPH_ORIGIN}/`;
const GRAPH_SESSION_KEY: SessionKey = { provider: "amc", account: "personal" };
const SEAT_TYPES = new Set<AmcSeatType>([
  "CanReserve",
  "Companion",
  "Wheelchair",
  "NotASeat",
  "LoveSeatLeft",
  "LoveSeatRight",
]);

const DATED_SHOWTIMES_DOCUMENT = `query DatedShowtimes($date: Date!, $theatreSlug: String!) {
  viewer {
    user {
      movies(date: $date, theatreSlug: $theatreSlug) {
        items {
          movie { movieId name slug }
          theatres {
            theatre { theatreId name slug }
            formats {
              date
              items {
                attributes { name }
                groups(first: 100) {
                  edges {
                    node {
                      showtimeGroupHeadingAttribute { name }
                      showtimes(first: 100) {
                        edges {
                          node {
                            showtimeId
                            businessDate
                            when
                            status
                            display { time amPm }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const SHOWTIME_INVENTORY_DOCUMENT = `query ShowtimeInventory($id: Int!) {
  viewer {
    showtime(id: $id) {
      showtimeId
      status
      prices { sku type price convenienceFee tax }
      seatingLayout {
        columns
        rows
        seats { name available column row type seatTier shouldDisplay }
      }
    }
  }
}`;

const SHOWTIME_INVENTORY_SELECTION = `
  showtimeId
  status
  prices { sku type price convenienceFee tax }
  seatingLayout {
    columns
    rows
    seats { name available column row type seatTier shouldDisplay }
  }
`;

export type AmcSeatLayoutBatchResult =
  | { showtimeId: string; status: "ok"; layout: AmcSeatingLayout }
  | {
      showtimeId: string;
      status: "error";
      code: "AMC_GRAPH_READ_CONTRACT_ERROR";
      message: string;
    };

export interface AmcSeatLayoutBatch {
  observedAt: string;
  results: AmcSeatLayoutBatchResult[];
}

export class AmcGraphReadContractError extends Error {
  readonly code = "AMC_GRAPH_READ_CONTRACT_ERROR";
  constructor(readonly operation: string) {
    super(`AMC GraphQL read contract failed (${operation})`);
  }
}

export interface AmcGraphReadClientOptions {
  transport: Transport;
  store?: SessionStore;
  repairSession?: () => Promise<AmcSession>;
  venues?: AmcVenueRegistry;
  /**
   * Invoked with a freshly loaded persisted session so the runtime can adopt
   * its browser-derived fingerprint on the transport before the read. This is
   * how a fresh CLI process self-aligns the direct signature.
   */
  onSessionLoaded?: (session: AmcSession) => Promise<void>;
}

export class AmcGraphReadClient {
  private readonly store: SessionStore;
  private readonly venues: AmcVenueRegistry;
  constructor(private readonly options: AmcGraphReadClientOptions) {
    this.store = options.store ?? new FileSessionStore();
    this.venues = options.venues ?? {};
  }

  async getShowtimes(query: AmcShowtimeQuery): Promise<AmcShowtime[]> {
    const venue = resolveVenue(query.venue, this.venues);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date))
      throw new Error("invalid AMC showtime date");
    const value = await this.read("DatedShowtimes", DATED_SHOWTIMES_DOCUMENT, {
      date: query.date,
      theatreSlug: venue.slug,
    });
    const items = arrayAt(
      value,
      ["data", "viewer", "user", "movies", "items"],
      "DatedShowtimes",
    );
    const found = new Map<string, AmcShowtime>();
    for (const item of items) {
      const movie = recordAt(item, ["movie"], "DatedShowtimes");
      const movieId = positiveInteger(movie.movieId, "DatedShowtimes");
      const movieTitle = nonEmpty(movie.name, "DatedShowtimes");
      for (const theatreItem of arrayAt(item, ["theatres"], "DatedShowtimes")) {
        const theatre = recordAt(theatreItem, ["theatre"], "DatedShowtimes");
        // A URL-resolved venue carries no internal id; the slug is then the
        // sole key and the provider's own theatreId is used, never invented.
        if (
          theatre.slug !== venue.slug ||
          (venue.id !== undefined && theatre.theatreId !== Number(venue.id))
        )
          continue;
        const formats = recordAt(theatreItem, ["formats"], "DatedShowtimes");
        for (const format of arrayAt(formats, ["items"], "DatedShowtimes")) {
          const fallbackFormat = attributeNames(format).join(", ");
          for (const edge of arrayAt(
            format,
            ["groups", "edges"],
            "DatedShowtimes",
          )) {
            const group = recordAt(edge, ["node"], "DatedShowtimes");
            // `showtimeGroupHeadingAttribute` is optional: the provider legitimately
            // returns it as null for one group even in an otherwise complete
            // response. Prefer its name when present, otherwise fall back to the
            // format-level attribute names.
            const headingAttribute = group.showtimeGroupHeadingAttribute;
            const heading =
              headingAttribute == null
                ? null
                : optionalString(
                    recordAt(
                      group,
                      ["showtimeGroupHeadingAttribute"],
                      "DatedShowtimes",
                    ).name,
                  );
            const formatName = heading ?? fallbackFormat;
            // A genuinely unlabeled group (no heading AND no format attributes)
            // is skipped rather than failing all valid sibling groups. We never
            // fabricate a label.
            if (!formatName) continue;
            for (const showtimeEdge of arrayAt(
              group,
              ["showtimes", "edges"],
              "DatedShowtimes",
            )) {
              const node = recordAt(showtimeEdge, ["node"], "DatedShowtimes");
              const display = recordAt(node, ["display"], "DatedShowtimes");
              const id = String(
                positiveInteger(node.showtimeId, "DatedShowtimes"),
              );
              found.set(id, {
                id,
                movieId: String(movieId),
                movieTitle,
                theaterId:
                  venue.id ??
                  String(positiveInteger(theatre.theatreId, "DatedShowtimes")),
                theaterName: venue.name,
                date: nonEmpty(node.businessDate, "DatedShowtimes"),
                time: `${nonEmpty(display.time, "DatedShowtimes")} ${nonEmpty(display.amPm, "DatedShowtimes").toLowerCase()}`,
                dateTimeUtc: nonEmpty(node.when, "DatedShowtimes"),
                format: formatName,
                availability: nonEmpty(node.status, "DatedShowtimes"),
              });
            }
          }
        }
      }
    }
    const movieFilter = query.movie?.trim().toLocaleLowerCase();
    const formatFilter = query.format?.trim().toLocaleLowerCase();
    return [...found.values()].filter(
      (showtime) =>
        (!movieFilter ||
          showtime.movieTitle.toLocaleLowerCase().includes(movieFilter)) &&
        (!formatFilter ||
          showtime.format.toLocaleLowerCase().includes(formatFilter)),
    );
  }

  async getSeatLayout(showtimeId: string): Promise<AmcSeatingLayout> {
    if (!/^\d+$/.test(showtimeId)) throw new Error("invalid AMC showtime id");
    const value = await this.read(
      "ShowtimeInventory",
      SHOWTIME_INVENTORY_DOCUMENT,
      {
        id: Number(showtimeId),
      },
    );
    const showtime = recordAt(
      value,
      ["data", "viewer", "showtime"],
      "ShowtimeInventory",
    );
    return parseLayout(showtime, showtimeId, "ShowtimeInventory");
  }

  async getSeatLayouts(
    showtimeIds: readonly string[],
  ): Promise<AmcSeatLayoutBatch> {
    if (showtimeIds.length === 0 || showtimeIds.length > 32) {
      throw new Error("AMC batch must contain 1-32 showtime ids");
    }
    if (
      showtimeIds.some((showtimeId) => !/^\d+$/.test(showtimeId)) ||
      new Set(showtimeIds).size !== showtimeIds.length
    ) {
      throw new Error("AMC batch showtime ids must be unique numeric values");
    }
    const fields = showtimeIds
      .map(
        (showtimeId, index) =>
          `s${index}: showtime(id: ${showtimeId}) { ${SHOWTIME_INVENTORY_SELECTION} }`,
      )
      .join("\n");
    const value = await this.read(
      "MultiShowtimeInventory",
      `query MultiShowtimeInventory { viewer { ${fields} } }`,
      {},
      true,
    );
    const aliasErrors = batchGraphErrorAliases(value, showtimeIds.length);
    const viewer = recordAt(
      value,
      ["data", "viewer"],
      "MultiShowtimeInventory",
    );
    const results = showtimeIds.map(
      (showtimeId, index): AmcSeatLayoutBatchResult => {
        const operation = `ShowtimeInventory:${showtimeId}`;
        try {
          if (aliasErrors.has(index))
            throw new AmcGraphReadContractError(operation);
          const showtime = recordAt(viewer, [`s${index}`], operation);
          return {
            showtimeId,
            status: "ok",
            layout: parseLayout(showtime, showtimeId, operation),
          };
        } catch (error) {
          if (!(error instanceof AmcGraphReadContractError)) throw error;
          return {
            showtimeId,
            status: "error",
            code: error.code,
            message: error.message,
          };
        }
      },
    );
    return { observedAt: new Date().toISOString(), results };
  }

  private async read(
    operationName: string,
    query: string,
    variables: object,
    allowGraphErrors = false,
  ): Promise<unknown> {
    const loaded = await this.loadSession();
    let session = loaded.session;
    if (loaded.persisted) await this.options.onSessionLoaded?.(session);
    let mayCreateSession = !loaded.persisted;
    // Reads (never writes) get exactly ONE bounded same-session re-dispatch past
    // a TRANSIENT anti-bot/egress hiccup on the direct graph endpoint: a
    // transport throw (TLS EPROTO / connection reset / timeout), a transient
    // HTTP status (429/5xx), or a 200 whose body is an interstitial rather than
    // JSON. Live evidence shows the immediate next request on the same session
    // succeeds. This is not a blind retry (it is single, transient-classified,
    // same-session, read-only) and it runs before — not instead of — the
    // challenge/repair and fail-closed classification below.
    let response = await this.dispatchWithTransientRetry(
      session,
      operationName,
      query,
      variables,
    );
    if (
      isChallenge(response.status, response.bodyText) &&
      this.options.repairSession
    ) {
      session = await this.options.repairSession();
      mayCreateSession = false;
      response = await this.dispatch(session, operationName, query, variables);
    }
    await this.persist(session, response.setCookies, mayCreateSession);
    classify(response.status, response.bodyText, operationName);
    try {
      const value: unknown = JSON.parse(response.bodyText);
      if (
        !allowGraphErrors &&
        isRecord(value) &&
        Array.isArray(value.errors) &&
        value.errors.length > 0
      ) {
        throw new AmcGraphReadContractError(operationName);
      }
      return value;
    } catch (error) {
      if (error instanceof AmcGraphReadContractError) throw error;
      throw new AmcGraphReadContractError(operationName);
    }
  }

  /**
   * One bounded, same-session re-dispatch when the first attempt is a
   * transient failure. If the first attempt throws a transport-class error, the
   * retry may itself throw (propagated, fail-closed). Non-transient responses
   * pass straight through to the caller's challenge/classification logic.
   */
  private async dispatchWithTransientRetry(
    session: AmcSession,
    operationName: string,
    query: string,
    variables: object,
  ): Promise<ResponseOutput> {
    let first: ResponseOutput;
    try {
      first = await this.dispatch(session, operationName, query, variables);
    } catch (error) {
      if (!isTransientTransportThrow(error)) throw error;
      return this.dispatch(session, operationName, query, variables);
    }
    if (isTransientReadResponse(first)) {
      return this.dispatch(session, operationName, query, variables);
    }
    return first;
  }

  private dispatch(
    session: AmcSession,
    operationName: string,
    query: string,
    variables: object,
  ): Promise<ResponseOutput> {
    const cookie = cookieHeaderFor(session, GRAPHQL_URL);
    return this.options.transport.request({
      method: "POST",
      url: GRAPHQL_URL,
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        origin: AMC_ORIGIN,
        referer: `${AMC_ORIGIN}/`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ operationName, query, variables }),
      verifyTLS: true,
      followRedirect: false,
      timeoutMs: 45_000,
    });
  }

  private async loadSession(): Promise<{
    session: AmcSession;
    persisted: boolean;
  }> {
    const bytes = await this.store.load(GRAPH_SESSION_KEY);
    if (bytes === null) return { session: emptySession(), persisted: false };
    try {
      return { session: decodeAmcSession(bytes), persisted: true };
    } catch (error) {
      if (error instanceof SessionDecodeError)
        return { session: emptySession(), persisted: false };
      throw error;
    }
  }

  private async persist(
    session: AmcSession,
    lines: readonly string[],
    mayCreateSession: boolean,
  ): Promise<void> {
    if (lines.length === 0) return;
    await this.store.withRefreshLock(GRAPH_SESSION_KEY, async () => {
      const saved = await this.store.load(GRAPH_SESSION_KEY);
      // A concurrent clear wins when this request began with a persisted jar.
      if (saved === null && !mayCreateSession) return;
      const current = saved === null ? session : decodeAmcSession(saved);
      const rotated = applySetCookieLines(current, GRAPHQL_URL, lines);
      rotated.exportedAt = new Date().toISOString();
      const encoded = encodeAmcSession(rotated);
      if (saved === null || !Buffer.from(saved).equals(Buffer.from(encoded))) {
        await this.store.save(GRAPH_SESSION_KEY, encoded);
      }
    });
  }
}

function batchGraphErrorAliases(
  value: unknown,
  showtimeCount: number,
): Set<number> {
  if (!isRecord(value) || !("errors" in value)) return new Set();
  if (!Array.isArray(value.errors)) {
    throw new AmcGraphReadContractError("MultiShowtimeInventory");
  }
  const aliases = new Set<number>();
  for (const error of value.errors) {
    if (
      !isRecord(error) ||
      !Array.isArray(error.path) ||
      error.path.length < 2
    ) {
      throw new AmcGraphReadContractError("MultiShowtimeInventory");
    }
    const [root, alias] = error.path;
    if (
      root !== "viewer" ||
      typeof alias !== "string" ||
      !/^s\d+$/.test(alias)
    ) {
      throw new AmcGraphReadContractError("MultiShowtimeInventory");
    }
    const index = Number(alias.slice(1));
    if (!Number.isSafeInteger(index) || index < 0 || index >= showtimeCount) {
      throw new AmcGraphReadContractError("MultiShowtimeInventory");
    }
    aliases.add(index);
  }
  return aliases;
}

function parseLayout(
  showtime: Record<string, unknown>,
  showtimeId: string,
  operation: string,
): AmcSeatingLayout {
  if (showtime.showtimeId !== Number(showtimeId)) {
    throw new AmcGraphReadContractError(operation);
  }
  const prices = arrayAt(showtime, ["prices"], operation).map((price, index) =>
    parsePrice(price, index),
  );
  const layout = recordAt(showtime, ["seatingLayout"], operation);
  const soldoutSeats = layout.seats;
  if (
    showtime.status === "Soldout" &&
    layout.columns === null &&
    layout.rows === null &&
    soldoutSeats === null
  ) {
    return {
      columns: 0,
      rows: 0,
      seats: [],
      prices,
      providerStatus: "Soldout",
    };
  }
  const rawSeats = arrayAt(layout, ["seats"], operation);
  const columns = positiveInteger(layout.columns, operation);
  const rows = positiveInteger(layout.rows, operation);
  const seats = rawSeats.map((seat, index) =>
    parseSeat(seat, index, columns, rows),
  );
  if (seats.length !== columns * rows)
    throw new AmcGraphReadContractError(operation);
  const coordinates = new Set<string>();
  for (const seat of seats) {
    const coordinate = `${seat.row}:${seat.column}`;
    if (coordinates.has(coordinate))
      throw new AmcGraphReadContractError(operation);
    coordinates.add(coordinate);
  }
  return { columns, rows, seats, prices };
}

function emptySession(): AmcSession {
  return {
    version: 1,
    origin: AMC_ORIGIN,
    profile: AMC_PROFILE,
    exportedAt: new Date().toISOString(),
    cookies: [],
  };
}

function parseSeat(
  value: unknown,
  index: number,
  columns: number,
  rows: number,
): AmcSeatSlot {
  if (!isRecord(value))
    throw new AmcGraphReadContractError("ShowtimeInventory");
  const type = value.type;
  if (
    typeof value.name !== "string" ||
    typeof value.available !== "boolean" ||
    !Number.isInteger(value.column) ||
    !Number.isInteger(value.row) ||
    typeof type !== "string" ||
    !SEAT_TYPES.has(type as AmcSeatType) ||
    typeof value.seatTier !== "string" ||
    typeof value.shouldDisplay !== "boolean" ||
    (value.column as number) < 1 ||
    (value.column as number) > columns ||
    (value.row as number) < 1 ||
    (value.row as number) > rows
  ) {
    throw new AmcGraphReadContractError(`ShowtimeInventory.seat.${index}`);
  }
  return {
    name: value.name,
    available: value.available,
    column: value.column as number,
    row: value.row as number,
    type: type as AmcSeatType,
    seatTier: value.seatTier,
    shouldDisplay: value.shouldDisplay,
  };
}

function parsePrice(value: unknown, index: number): AmcTicketPrice {
  if (
    !isRecord(value) ||
    typeof value.sku !== "string" ||
    !value.sku ||
    typeof value.type !== "string" ||
    !value.type ||
    !nonNegative(value.price) ||
    !nonNegative(value.convenienceFee) ||
    !nonNegative(value.tax)
  ) {
    throw new AmcGraphReadContractError(`ShowtimeInventory.price.${index}`);
  }
  return {
    sku: value.sku,
    type: value.type,
    price: value.price,
    convenienceFee: value.convenienceFee,
    tax: value.tax,
  };
}

function attributeNames(value: unknown): string[] {
  return arrayAt(value, ["attributes"], "DatedShowtimes")
    .map((attribute) =>
      isRecord(attribute) ? optionalString(attribute.name) : null,
    )
    .filter((name): name is string => name !== null);
}

function recordAt(
  value: unknown,
  path: string[],
  operation: string,
): Record<string, unknown> {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) throw new AmcGraphReadContractError(operation);
    current = current[part];
  }
  if (!isRecord(current)) throw new AmcGraphReadContractError(operation);
  return current;
}

function arrayAt(value: unknown, path: string[], operation: string): unknown[] {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) throw new AmcGraphReadContractError(operation);
    current = current[part];
  }
  if (!Array.isArray(current)) throw new AmcGraphReadContractError(operation);
  return current;
}

function nonEmpty(value: unknown, operation: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new AmcGraphReadContractError(operation);
  return value;
}
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function positiveInteger(value: unknown, operation: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AmcGraphReadContractError(operation);
  }
  return value;
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Transient HTTP statuses worth exactly one same-session read retry. */
const TRANSIENT_READ_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * A first read response that is a transient anti-bot/egress hiccup rather than
 * a real answer: a transient HTTP status, or an HTTP 200 whose body is not JSON
 * (an interstitial page). A genuine challenge (403/429 with challenge markers)
 * is also transient-retryable here; if it persists, the caller's challenge path
 * still runs on the second response.
 */
function isTransientReadResponse(response: ResponseOutput): boolean {
  if (TRANSIENT_READ_STATUS.has(response.status)) return true;
  if (response.status === 200 && !looksLikeJson(response.bodyText)) return true;
  return false;
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

// Exact socket/DNS/TLS/undici failure codes (plus the ECONN* family) that count
// as a transient transport hiccup on a read. Deliberately NOT a catch-all: a
// programmer error (ERR_INVALID_ARG_TYPE) or typed contract error keeps its
// identity and is never retried.
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

function isTransientTransportThrow(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_TRANSPORT_CODES.has(code)) return true;
    return TRANSIENT_TRANSPORT_CODE_PREFIXES.some((p) => code.startsWith(p));
  }
  return /TLS fatal|SSL routines|hello transport timed out/i.test(
    error.message,
  );
}

function isChallenge(status: number, body: string): boolean {
  return (
    (status === 403 || status === 429) &&
    /(queue-it|queueit|waiting room|cf-chl|challenge-platform|just a moment|cloudflare)/i.test(
      body,
    )
  );
}
function classify(status: number, body: string, operation: string): void {
  if (isChallenge(status, body))
    throw new AmcChallengeError("AMC GraphQL returned an anti-bot challenge");
  if (status !== 200)
    throw new AmcHttpError(
      `AMC GraphQL ${operation} failed with HTTP ${status}`,
      status,
    );
}
