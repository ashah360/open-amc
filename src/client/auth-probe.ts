import { ResponseOutput, Transport } from "../transport";
import {
  AmcAuthRejectedError,
  AmcChallengeError,
  AmcHttpError,
} from "./client";
import { AMC_GRAPH_ORIGIN, AMC_ORIGIN } from "./session";
import { isTransientResponse, isTransientTransportThrow } from "./transient";

const GRAPHQL_URL = `${AMC_GRAPH_ORIGIN}/`;

/**
 * The cheap GraphQL auth canary. `viewer.user` is a non-null object for an
 * authenticated session and `null` for an anonymous one, so a single tiny query
 * distinguishes valid / stale / challenged without fetching or parsing the
 * theater-specific SSR listing (which carried listing-page auth semantics). It reads
 * no wallet, order, or personal data.
 */
/**
 * The canonical AccessCheck operation name and document. Exported so the
 * explicit browser-repair path can run the SAME harmless GraphQL AccessCheck
 * from inside the browser context (to prove the anti-bot layer has settled)
 * rather than inventing a second contract.
 */
export const AMC_ACCESS_CHECK_OPERATION = "AmcAuthCanary";
export const AMC_ACCESS_CHECK_DOCUMENT = `query AmcAuthCanary {
  viewer {
    user {
      __typename
    }
  }
}`;
const AUTH_CANARY_DOCUMENT = AMC_ACCESS_CHECK_DOCUMENT;

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
    const response = await this.dispatchWithTransientRetry(cookie);
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

  /**
   * The canary gets exactly ONE bounded, SAME-session re-dispatch when the
   * first attempt is the same transient anti-bot/egress class proven for graph
   * reads (transport TLS/socket/DNS/timeout throw, HTTP 429/5xx, or a 200 whose
   * body is an interstitial). This prevents a transient interstitial on the
   * canary from being misread as a genuine challenge/rejection — which would
   * otherwise escalate an ordinary read/cart into session repair
   * (`listing-url-required`) for a session that is actually valid. A persistent
   * transient, a genuine 403 challenge, a 401, or an authenticated failure all
   * follow the existing classification below unchanged. No browser, no backoff.
   */
  private async dispatchWithTransientRetry(
    cookie: string,
  ): Promise<ResponseOutput> {
    const send = () =>
      this.options.transport.request({
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
    let first: ResponseOutput;
    try {
      first = await send();
    } catch (error) {
      if (!isTransientTransportThrow(error)) throw error;
      return send();
    }
    if (isTransientResponse(first)) return send();
    return first;
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
