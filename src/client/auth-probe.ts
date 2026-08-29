import { Transport } from "../transport";
import {
  AmcAuthRejectedError,
  AmcChallengeError,
  AmcHttpError,
} from "./client";
import { AMC_GRAPH_ORIGIN, AMC_ORIGIN } from "./session";

const GRAPHQL_URL = `${AMC_GRAPH_ORIGIN}/`;

/**
 * The cheap GraphQL auth canary. `viewer.user` is a non-null object for an
 * authenticated session and `null` for an anonymous one, so a single tiny query
 * distinguishes valid / stale / challenged without fetching or parsing the
 * theater-specific SSR listing (which carried listing-page auth semantics). It reads
 * no wallet, order, or personal data.
 */
const AUTH_CANARY_DOCUMENT = `query AmcAuthCanary {
  viewer {
    user {
      __typename
    }
  }
}`;

export interface AmcGraphAuthProbeOptions {
  transport: Transport;
  cookieHeader: (url: string) => string;
  onSuccessfulRead?: (
    url: string,
    setCookies: readonly string[],
  ) => Promise<void>;
}

export class AmcGraphAuthProbe {
  constructor(private readonly options: AmcGraphAuthProbeOptions) {}

  /** Throws AmcChallengeError / AmcAuthRejectedError / AmcHttpError; resolves when authenticated. */
  async check(): Promise<void> {
    const cookie = this.options.cookieHeader(GRAPHQL_URL);
    if (!cookie.trim()) {
      throw new AmcAuthRejectedError("AMC session has no graph cookies");
    }
    const response = await this.options.transport.request({
      method: "POST",
      url: GRAPHQL_URL,
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        origin: AMC_ORIGIN,
        referer: `${AMC_ORIGIN}/`,
        cookie,
      },
      body: JSON.stringify({
        operationName: "AmcAuthCanary",
        query: AUTH_CANARY_DOCUMENT,
        variables: {},
      }),
      verifyTLS: true,
      followRedirect: false,
      timeoutMs: 45_000,
    });
    if (isChallenge(response.status, response.bodyText)) {
      throw new AmcChallengeError("AMC GraphQL returned an anti-bot challenge");
    }
    if (response.status === 401) {
      throw new AmcAuthRejectedError("AMC GraphQL rejected the session");
    }
    if (response.status !== 200) {
      throw new AmcHttpError(
        `AMC auth canary failed with HTTP ${response.status}`,
        response.status,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(response.bodyText);
    } catch {
      throw new AmcAuthRejectedError("AMC auth canary response drifted");
    }
    if (!authenticated(value)) {
      throw new AmcAuthRejectedError("AMC session is not authenticated");
    }
    await this.options.onSuccessfulRead?.(GRAPHQL_URL, response.setCookies);
  }
}

function authenticated(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.errors) && value.errors.length > 0) return false;
  const data = isRecord(value.data) ? value.data : null;
  const viewer = data && isRecord(data.viewer) ? data.viewer : null;
  return !!viewer && isRecord(viewer.user);
}

function isChallenge(status: number, body: string): boolean {
  return (
    (status === 403 || status === 429) &&
    /(queue-it|queueit|waiting room|cf-chl|challenge-platform|just a moment|cloudflare)/i.test(
      body,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
