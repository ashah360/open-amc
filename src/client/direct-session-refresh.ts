import { Transport } from "../transport";
import { AmcBrowserRefresher } from "./browser-refresh";
import {
  AMC_ORIGIN,
  AMC_PROFILE,
  AmcSession,
  applySetCookieLines,
  cookieHeaderFor,
} from "./session";

const QUEUE_HOST = "queue.amctheatres.com";
const MAX_REDIRECT_URL_BYTES = 16 * 1024;

export class DirectAdmissionRequiresBrowserError extends Error {
  readonly code = "AMC_DIRECT_ADMISSION_REQUIRES_BROWSER";
  constructor(
    readonly stage: "target-challenge" | "waiting-room" | "queue-challenge",
  ) {
    super(`AMC direct admission requires browser (${stage})`);
  }
}

export class DirectAdmissionError extends Error {
  readonly code = "AMC_DIRECT_ADMISSION_FAILED";
  constructor(
    readonly stage: "target" | "queue" | "return" | "accepted-cookie",
  ) {
    super(`AMC direct admission failed (${stage})`);
  }
}

export interface AmcSessionRefresher {
  refresh(previous?: AmcSession | null): Promise<AmcSession>;
}

export class DirectFirstAmcSessionRefresher implements AmcSessionRefresher {
  constructor(
    private readonly direct: AmcSessionRefresher,
    private readonly browser: AmcBrowserRefresher,
  ) {}

  async refresh(previous?: AmcSession | null): Promise<AmcSession> {
    try {
      return await this.direct.refresh(previous);
    } catch (error) {
      // Explicit repair with a deliberately supplied browser escalates for
      // BOTH typed direct-admission outcomes: a browser-required challenge
      // and a deterministic direct-admission failure at any stage
      // (target/queue/return/accepted-cookie). Anything else — raw
      // transport, provider, or programmer errors — keeps its identity.
      // The browser export remains direct-canary-gated before persistence.
      if (
        !(error instanceof DirectAdmissionRequiresBrowserError) &&
        !(error instanceof DirectAdmissionError)
      ) {
        throw error;
      }
      return this.browser.refresh(previous);
    }
  }
}

export class DirectQueueItSessionRefresher implements AmcSessionRefresher {
  private readonly listingUrl: string;

  // An explicit official listing URL is REQUIRED; there is no built-in venue
  // default. Callers derive it from the human's official theater URL.
  constructor(
    private readonly transport: Transport,
    options: { listingUrl: string },
  ) {
    if (!options.listingUrl) {
      throw new Error(
        "direct admission requires an explicit official AMC listing URL (no built-in venue default)",
      );
    }
    const url = new URL(options.listingUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "www.amctheatres.com"
    ) {
      throw new Error(
        "direct admission listing URL must be on https://www.amctheatres.com",
      );
    }
    this.listingUrl = options.listingUrl;
  }

  async refresh(previous?: AmcSession | null): Promise<AmcSession> {
    const listingUrl = this.listingUrl;
    let session = previous ? cloneSession(previous) : emptySession();
    const initial = await this.get(
      listingUrl,
      cookieHeaderFor(session, listingUrl),
    );
    session = applySetCookieLines(session, listingUrl, initial.setCookies);

    if (isChallenge(initial.status, initial.bodyText)) {
      throw new DirectAdmissionRequiresBrowserError("target-challenge");
    }
    if (initial.status !== 302 || !initial.headers.location) {
      throw new DirectAdmissionError("target");
    }
    const queueUrl = checkedUrl(
      initial.headers.location,
      listingUrl,
      QUEUE_HOST,
      "queue",
    );

    const queue = await this.get(queueUrl, "");
    if (queue.status === 200 && isHtml(queue.headers["content-type"])) {
      throw new DirectAdmissionRequiresBrowserError("waiting-room");
    }
    if (isChallenge(queue.status, queue.bodyText)) {
      throw new DirectAdmissionRequiresBrowserError("queue-challenge");
    }
    if (queue.status !== 302 || !queue.headers.location) {
      throw new DirectAdmissionError("queue");
    }
    const returnUrl = checkedUrl(
      queue.headers.location,
      queueUrl,
      "www.amctheatres.com",
      "return",
    );
    if (!new URL(returnUrl).searchParams.has("queueittoken")) {
      throw new DirectAdmissionError("return");
    }

    const returned = await this.get(
      returnUrl,
      cookieHeaderFor(session, returnUrl),
    );
    session = applySetCookieLines(session, returnUrl, returned.setCookies);
    if (
      ![200, 302, 307].includes(returned.status) ||
      ((returned.status === 302 || returned.status === 307) &&
        (!returned.headers.location ||
          !isAllowedCleanTarget(returned.headers.location, returnUrl)))
    ) {
      throw new DirectAdmissionError("return");
    }
    if (!hasAcceptedCookie(session)) {
      throw new DirectAdmissionError("accepted-cookie");
    }
    return { ...session, exportedAt: new Date().toISOString() };
  }

  private get(url: string, cookie: string) {
    return this.transport.request({
      method: "GET",
      url,
      headers: {
        accept: "text/html,application/xhtml+xml",
        ...(cookie ? { cookie } : {}),
        "sec-fetch-site": "none",
        "sec-fetch-mode": "navigate",
        "sec-fetch-user": "?1",
        "sec-fetch-dest": "document",
        "upgrade-insecure-requests": "1",
      },
      verifyTLS: true,
      followRedirect: false,
      timeoutMs: 45_000,
    });
  }
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

function cloneSession(session: AmcSession): AmcSession {
  return {
    ...session,
    cookies: session.cookies.map((cookie) => ({ ...cookie })),
  };
}

function checkedUrl(
  raw: string,
  base: string,
  host: string,
  stage: "queue" | "return",
): string {
  if (raw.length > MAX_REDIRECT_URL_BYTES)
    throw new DirectAdmissionError(stage);
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new DirectAdmissionError(stage);
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== host) {
    throw new DirectAdmissionError(stage);
  }
  return url.toString();
}

function isAllowedCleanTarget(raw: string, base: string): boolean {
  try {
    const url = new URL(raw, base);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "www.amctheatres.com" &&
      !url.searchParams.has("queueittoken")
    );
  } catch {
    return false;
  }
}

function hasAcceptedCookie(session: AmcSession): boolean {
  const now = Date.now() / 1000;
  return session.cookies.some(
    (cookie) =>
      cookie.name.startsWith("QueueITAccepted-") &&
      cookie.value.length > 0 &&
      (cookie.expires === -1 || cookie.expires > now),
  );
}

function isHtml(contentType: string | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("text/html");
}

function isChallenge(status: number, bodyText: string): boolean {
  return (
    (status === 403 || status === 429) &&
    /(queue-it|queueit|waiting room|cf-chl|challenge-platform|just a moment|cloudflare)/i.test(
      bodyText,
    )
  );
}
