import { AuthRejectedError } from "../auth-session";
import { Transport } from "../transport";
import { AMC_ORIGIN } from "./session";
import {
  AmcShowtime,
  AmcShowtimeQuery,
  AmcVenueRegistry,
  parseShowtimePageHtml,
  resolveVenue,
} from "./showtimes";
import { AmcSeatingLayout, parseSeatPageHtml } from "./seat-layout";

export class AmcAuthRejectedError extends AuthRejectedError {}
export class AmcChallengeError extends Error {
  readonly code = "AMC_CHALLENGE";
}
export class AmcHttpError extends Error {
  readonly code = "AMC_HTTP";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface AmcClientOptions {
  transport: Transport;
  cookieHeader: string | ((url: string) => string);
  onSuccessfulRead?: (
    url: string,
    setCookies: readonly string[],
  ) => Promise<void>;
  venues?: AmcVenueRegistry;
  /**
   * Official AMC listing path used by the SSR access check (canary). There is
   * no built-in venue default; without one, `checkAccess` fails with an
   * instruction to resolve the caller's theater URL first.
   */
  accessCheckPath?: string;
}

export class AmcClient {
  constructor(private readonly options: AmcClientOptions) {
    if (
      typeof options.cookieHeader === "string" &&
      !options.cookieHeader.trim()
    ) {
      throw new Error("AMC browser session cookies are required");
    }
  }

  async checkAccess(): Promise<void> {
    if (!this.options.accessCheckPath) {
      throw new Error(
        "the SSR access check requires an official AMC theater listing path; resolve the caller's theater URL first",
      );
    }
    const url = `${AMC_ORIGIN}${this.options.accessCheckPath}`;
    const response = await this.read(url);
    if (
      !/<h2\b[^>]*>\s*AMC\b/i.test(response.bodyText) ||
      !/<section\b[^>]*aria-label=(?:"Showtimes for [^"]+"|'Showtimes for [^']+')/i.test(
        response.bodyText,
      ) ||
      !/<li\b[^>]*role=(?:"listitem"|'listitem')[^>]*aria-label=(?:"[^"]+ Showtimes"|'[^']+ Showtimes')/i.test(
        response.bodyText,
      ) ||
      !/href=(?:"\/showtimes\/\d+"|'\/showtimes\/\d+')/i.test(response.bodyText)
    ) {
      throw new Error("AMC access check response shape drifted");
    }
    await this.options.onSuccessfulRead?.(url, response.setCookies);
  }

  async getSeatLayout(showtimeId: string): Promise<AmcSeatingLayout> {
    if (!/^\d+$/.test(showtimeId)) throw new Error("invalid AMC showtime id");
    const url = `${AMC_ORIGIN}/showtimes/${showtimeId}/seats`;
    const response = await this.read(url);
    const layout = parseSeatPageHtml(response.bodyText);
    await this.options.onSuccessfulRead?.(url, response.setCookies);
    return layout;
  }

  async getShowtimes(query: AmcShowtimeQuery): Promise<AmcShowtime[]> {
    const registry = this.options.venues ?? {};
    const venue = resolveVenue(query.venue, registry);
    const url = `${AMC_ORIGIN}${venue.path}?date=${encodeURIComponent(query.date)}`;
    let response = await this.read(url);
    let showtimes: AmcShowtime[];
    try {
      showtimes = parseShowtimePageHtml(response.bodyText, query, registry);
    } catch (error) {
      if (!isVerifiedPartialListing(response.bodyText, error)) throw error;
      await this.options.onSuccessfulRead?.(url, response.setCookies);
      response = await this.read(url);
      showtimes = parseShowtimePageHtml(response.bodyText, query, registry);
    }
    await this.options.onSuccessfulRead?.(url, response.setCookies);
    const movie = query.movie?.trim().toLocaleLowerCase();
    const format = query.format?.trim().toLocaleLowerCase();
    return showtimes.filter(
      (showtime) =>
        (!movie || showtime.movieTitle.toLocaleLowerCase().includes(movie)) &&
        (!format || showtime.format.toLocaleLowerCase().includes(format)),
    );
  }

  private async read(url: string) {
    const cookieHeader =
      typeof this.options.cookieHeader === "function"
        ? this.options.cookieHeader(url)
        : this.options.cookieHeader;
    if (!cookieHeader.trim())
      throw new Error("AMC browser session cookies are required");
    const response = await this.options.transport.request({
      method: "GET",
      url,
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie: cookieHeader,
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        "sec-fetch-dest": "document",
        "upgrade-insecure-requests": "1",
      },
      verifyTLS: true,
      followRedirect: true,
      timeoutMs: 45_000,
    });
    classifyResponse(
      response.status,
      response.headers,
      response.bodyText,
      response.setCookieNames,
    );
    const contentType = response.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error(
        `AMC read response content type drifted: ${contentType || "missing"}`,
      );
    }
    return response;
  }
}

function isVerifiedPartialListing(bodyText: string, error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "AMC listing response is missing typed showtime groups" &&
    /<h2\b[^>]*>\s*AMC\b/i.test(bodyText) &&
    !/<section\b[^>]*aria-label=(?:"Showtimes for [^"]+"|'Showtimes for [^']+')/i.test(
      bodyText,
    )
  );
}

function classifyResponse(
  status: number,
  headers: Record<string, string>,
  bodyText: string,
  setCookieNames: readonly string[] = [],
): void {
  const queueEvidence = `${headers["x-queueit-ajaxpageurl"] ?? ""}\n${bodyText}`;
  const cloudflareEvidence = bodyText;
  if (
    (status === 403 || status === 429) &&
    (/(queue-it|queueit|waiting room)/i.test(queueEvidence) ||
      /(cf-chl|challenge-platform|just a moment|attention required[^<]*cloudflare)/i.test(
        cloudflareEvidence,
      ))
  ) {
    throw new AmcChallengeError(
      `AMC returned a Queue-it/Cloudflare challenge (HTTP ${status})`,
    );
  }
  const location = headers.location ?? "";
  const acceptedCookieIssued = setCookieNames.some((name) =>
    name.startsWith("QueueITAccepted-"),
  );
  if (
    status === 302 &&
    (acceptedCookieIssued ||
      (() => {
        try {
          return (
            new URL(location).hostname.toLowerCase() === "queue.amctheatres.com"
          );
        } catch {
          return false;
        }
      })())
  ) {
    throw new AmcChallengeError("AMC entered the Queue-it admission flow");
  }
  if (status === 401) {
    throw new AmcAuthRejectedError("AMC rejected the saved browser session");
  }
  if (status !== 200) {
    throw new AmcHttpError(`AMC read failed with HTTP ${status}`, status);
  }
}
