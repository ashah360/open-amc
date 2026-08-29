export interface AmcVenueDefinition {
  /**
   * Numeric AMC theatre id (as a string). Optional because a descriptor
   * resolved from an official theater URL carries no internal id; reads then
   * take the id from the provider response instead of inventing it.
   */
  id?: string;
  /** Human-readable theatre name, e.g. "AMC Empire 25". */
  name: string;
  /** GraphQL theatre slug, e.g. "amc-empire-25". */
  slug: string;
  /** SSR listing path (legacy read path). */
  path: string;
}

/** A venue lookup keyed by caller-chosen venue keys. */
export type AmcVenueRegistry = Record<string, AmcVenueDefinition>;

/** Venue key. A string so injected/custom venues resolve through the registry. */
export type AmcVenue = string;

/**
 * Resolve a venue reference: either a key in a caller-injected registry or an
 * already-resolved venue descriptor (e.g. produced by
 * `resolveOfficialAmcTheaterUrl`), which passes through after validation.
 * There is NO built-in venue: an unresolvable key always throws and never
 * silently becomes some default theater.
 */
export function resolveVenue(
  venue: string | AmcVenueDefinition,
  registry: AmcVenueRegistry = {},
): AmcVenueDefinition {
  if (typeof venue !== "string") {
    if (!venue.slug || !venue.path || !venue.name) {
      throw new Error("resolved AMC venue descriptor is incomplete");
    }
    return venue;
  }
  const definition = registry[venue];
  if (!definition) throw new Error(`unsupported AMC venue: ${venue}`);
  return definition;
}

export interface AmcShowtimeQuery {
  venue: AmcVenue | AmcVenueDefinition;
  date: string;
  movie?: string;
  format?: string;
}

export interface AmcShowtime {
  id: string;
  movieId: string;
  movieTitle: string;
  theaterId: string;
  theaterName: string;
  date: string;
  time: string;
  dateTimeUtc: string;
  format: string;
  availability: string;
}

interface FlightShowtime {
  status: string;
  showDateTimeUtc: string;
  display?: { time?: string; amPm?: string };
}

interface PositionedMovie {
  start: number;
  id: string;
  title: string;
  theaterName: string;
}

interface PositionedFormat {
  start: number;
  name: string;
}

export function parseShowtimePageHtml(
  html: string,
  query: Pick<AmcShowtimeQuery, "venue" | "date">,
  registry: AmcVenueRegistry = {},
): AmcShowtime[] {
  const venue = resolveVenue(query.venue, registry);
  if (!validDate(query.date)) throw new Error("invalid AMC showtime date");
  const flight = flightShowtimes(html);
  const theaterId = pageTheaterId(html) ?? venue.id;
  if (!theaterId) {
    throw new Error(
      "AMC theater id is not derivable from the listing page or venue",
    );
  }
  const movies = positionedMovies(html, venue.name);
  const formats = positionedFormats(html);
  const showtimes: AmcShowtime[] = [];

  for (const anchor of html.matchAll(/<a\b([^>]*)>/gi)) {
    const anchorAttributes = anchor[1] ?? "";
    const href = attribute(anchorAttributes, "href");
    const id = href?.match(/^\/showtimes\/(\d+)$/)?.[1];
    if (!id || anchor.index === undefined) continue;
    const movie = lastBefore(movies, anchor.index);
    const format = lastBefore(formats, anchor.index);
    if (!movie || !format || format.start < movie.start) continue;
    const closing = html.indexOf("</a>", anchor.index);
    if (closing < 0) throw new Error(`AMC showtime ${id} anchor is truncated`);
    const body = html.slice(anchor.index + anchor[0].length, closing);
    const observed = flight.get(id);
    const timeElement = /<time\b([^>]*)>([\s\S]*?)<\/time>/i.exec(body);
    const dateTimeUtc =
      observed?.showDateTimeUtc ??
      (timeElement ? (attribute(timeElement[1] ?? "", "datetime") ?? "") : "");
    const time =
      displayTime(observed) ||
      (timeElement ? normalizeText(timeElement[2] ?? "") : "") ||
      dateTimeUtc;
    const availability = observed?.status ?? availabilityText(body);
    if (!dateTimeUtc || !time || !availability) {
      throw new Error(`AMC showtime ${id} shape drifted`);
    }
    showtimes.push({
      id,
      movieId: movie.id,
      movieTitle: movie.title,
      theaterId,
      theaterName: movie.theaterName,
      date: query.date,
      time,
      dateTimeUtc,
      format: format.name,
      availability,
    });
  }

  if (showtimes.length === 0) {
    throw new Error("AMC listing response is missing typed showtime groups");
  }
  return showtimes;
}

function flightShowtimes(html: string): Map<string, FlightShowtime> {
  const result = new Map<string, FlightShowtime>();
  const pattern = /self\.__next_f\.push\((\[\d+,"(?:\\.|[^"\\])*"\])\)/g;
  for (const match of html.matchAll(pattern)) {
    const frame: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(frame) || typeof frame[1] !== "string") continue;
    const payload = frame[1];
    let offset = 0;
    while (offset < payload.length) {
      const marker = payload.indexOf('"showtimeId":', offset);
      if (marker < 0) break;
      const objectStart = payload.lastIndexOf("{", marker);
      if (objectStart < 0) break;
      const objectEnd = balancedObjectEnd(payload, objectStart);
      offset = objectEnd;
      let value: unknown;
      try {
        value = JSON.parse(payload.slice(objectStart, objectEnd));
      } catch {
        continue;
      }
      if (
        !isRecord(value) ||
        !positiveInteger(value.showtimeId) ||
        typeof value.status !== "string" ||
        typeof value.showDateTimeUtc !== "string"
      ) {
        continue;
      }
      const display = isRecord(value.display)
        ? {
            ...(typeof value.display.time === "string"
              ? { time: value.display.time }
              : {}),
            ...(typeof value.display.amPm === "string"
              ? { amPm: value.display.amPm }
              : {}),
          }
        : undefined;
      result.set(String(value.showtimeId), {
        status: value.status,
        showDateTimeUtc: value.showDateTimeUtc,
        ...(display ? { display } : {}),
      });
    }
  }
  return result;
}

function positionedMovies(
  html: string,
  fallbackTheaterName: string,
): PositionedMovie[] {
  const sections = [...html.matchAll(/<section\b([^>]*)>/gi)];
  return sections.flatMap((section, index) => {
    if (section.index === undefined) return [];
    const id = attribute(section[1] ?? "", "id");
    const label = attribute(section[1] ?? "", "aria-label");
    const movieId = id?.match(/-(\d+)$/)?.[1];
    const movieTitle = label?.match(/^Showtimes for (.+)$/i)?.[1];
    if (!movieId || !movieTitle) return [];
    const end = sections[index + 1]?.index ?? html.length;
    const sectionBody = html.slice(section.index + section[0].length, end);
    return [
      {
        start: section.index,
        id: movieId,
        title: movieTitle,
        theaterName: headingText(sectionBody, "h2") || fallbackTheaterName,
      },
    ];
  });
}

function positionedFormats(html: string): PositionedFormat[] {
  const formats: PositionedFormat[] = [];
  for (const listItem of html.matchAll(/<li\b([^>]*)>/gi)) {
    if (
      listItem.index === undefined ||
      attribute(listItem[1] ?? "", "role") !== "listitem"
    ) {
      continue;
    }
    const label = attribute(listItem[1] ?? "", "aria-label");
    const name = label?.match(/^(.+)\s+Showtimes$/i)?.[1]?.trim();
    if (name) formats.push({ start: listItem.index, name });
  }
  return formats;
}

function lastBefore<T extends { start: number }>(
  items: readonly T[],
  position: number,
): T | undefined {
  let found: T | undefined;
  for (const item of items) {
    if (item.start >= position) break;
    found = item;
  }
  return found;
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  throw new Error("AMC showtime payload is truncated");
}

function pageTheaterId(html: string): string | null {
  return /\\?"theatreId\\?"\s*:\s*(\d+)/.exec(html)?.[1] ?? null;
}

function headingText(body: string, level: "h1" | "h2"): string {
  const match = new RegExp(
    `<${level}\\b[^>]*>([\\s\\S]*?)<\\/${level}>`,
    "i",
  ).exec(body);
  return match ? normalizeText(match[1] ?? "") : "";
}

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "i",
  ).exec(attributes);
  return match ? decodeEntities(match[1] ?? match[2] ?? "") : null;
}

function displayTime(showtime: FlightShowtime | undefined): string {
  if (!showtime?.display?.time) return "";
  return `${showtime.display.time}${showtime.display.amPm ? ` ${showtime.display.amPm}` : ""}`;
}

function availabilityText(body: string): string {
  const labels = [
    ...body.matchAll(
      /<(?:span|div)\b[^>]*\bclass=(?:"[^"]*sr-only[^"]*"|'[^']*sr-only[^']*')[^>]*>([\s\S]*?)<\/(?:span|div)>/gi,
    ),
  ];
  return (
    labels.map((match) => normalizeText(match[1] ?? "")).find(Boolean) ?? ""
  );
}

function normalizeText(value: string): string {
  return decodeEntities(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&#(\d+);/g, (_, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 10)),
    );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
