import { Transport } from "../transport";
import {
  AmcAuthRejectedError,
  AmcChallengeError,
  AmcHttpError,
} from "../client/client";
import {
  AmcRuntime,
  AmcSessionContext,
  WriteChallengeCooldownError,
} from "../client/runtime";
import {
  AMC_GRAPH_ORIGIN,
  AMC_ORIGIN,
  cookieHeaderFor,
} from "../client/session";
import {
  GraphqlEnvelope,
  GraphqlEnvelopeWithoutVariables,
  OrderFulfillInput,
  buildBraintreeAuthorizationEnvelope,
  buildCartCreateEnvelope,
  buildOrderDeleteEnvelope,
  buildOrderExpirationUpdateEnvelope,
  buildOrderFulfillEnvelope,
  buildOrderRefundEnvelope,
  buildOrderSearchEnvelope,
  parseBraintreeAuthorizationResponse,
  parseCartCreateResponse,
  parseOrderDeleteResponse,
  parseOrderExpirationUpdateResponse,
  parseOrderFulfillResponse,
  parseOrderRefundResponse,
  parseOrderSearchResponse,
} from "./contracts";
import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  CommerceExecutor,
  Money,
  OrderLifecycle,
  PurchaseResult,
  RefundOrderSnapshot,
  WriteChallengedError,
  WriteRateLimitedError,
} from "./executor";
import {
  BraintreeClientTokenProvider,
  DirectOrderFulfillProvider,
} from "./direct-braintree-tokenizer";

const GRAPHQL_URL = `${AMC_GRAPH_ORIGIN}/`;

export class AmcGraphqlContractError extends Error {
  readonly code = "AMC_GRAPHQL_CONTRACT_ERROR";

  constructor(readonly operation: string) {
    super(`AMC GraphQL contract failed (${operation})`);
  }
}

export class AmcCommerceProjectionSetupError extends Error {
  readonly code = "AMC_COMMERCE_PROJECTION_SETUP_REQUIRED";

  constructor() {
    super("AMC exact cart/order projection provider is not configured");
  }
}

/**
 * Exact provider projections not present in the six captured GraphQL response
 * documents remain a separate boundary. Implementations must obtain fresh
 * provider state and must not synthesize expiry, totals, or refund lines.
 */
export interface AmcCommerceProjectionProvider {
  assertReady(): void | Promise<void>;
  inspectCart(
    orderToken: string,
    email?: string,
    intent?: CartCreateIntent,
  ): Promise<CartSnapshot>;
  /** Decide an order's lifecycle from ONE fresh projection (sole source of truth). */
  projectLifecycle(
    orderToken: string,
    opts: { intent?: CartCreateIntent; now: Date },
  ): Promise<OrderLifecycle>;
  reconcileCart(intent: CartCreateIntent): Promise<CartSnapshot | null>;
  projectRefundOrder(input: {
    orderNumber: string;
    email: string;
    orderToken: string;
  }): Promise<RefundOrderSnapshot>;
  projectPurchase(input: {
    orderToken: string;
    email: string;
    expectedTotal: Money;
  }): Promise<PurchaseResult>;
  reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null>;
  /** Read the order's current expiration timestamp (used for extend + reconcile). */
  projectExpiration(orderToken: string): Promise<{ expiresAt: string }>;
  /** Read the order's coarse lifecycle status (used to reconcile release). */
  projectStatus(orderToken: string): Promise<"OPEN" | "FULFILLED" | "EXPIRED">;
}

export class MissingAmcCommerceProjectionProvider implements AmcCommerceProjectionProvider {
  assertReady(): never {
    throw new AmcCommerceProjectionSetupError();
  }
  inspectCart(): Promise<CartSnapshot> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  projectLifecycle(): Promise<OrderLifecycle> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  reconcileCart(): Promise<CartSnapshot | null> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  projectRefundOrder(): Promise<RefundOrderSnapshot> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  projectPurchase(): Promise<PurchaseResult> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  projectExpiration(): Promise<{ expiresAt: string }> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
  projectStatus(): Promise<"OPEN" | "FULFILLED" | "EXPIRED"> {
    return Promise.reject(new AmcCommerceProjectionSetupError());
  }
}

export class ScopedAmcGraphqlClient {
  readonly replayStatus = "requires-live-canary" as const;

  constructor(
    private readonly transport: Transport,
    private readonly runtime: AmcRuntime,
  ) {}

  read<Variables>(
    envelope: GraphqlEnvelope<Variables> | GraphqlEnvelopeWithoutVariables,
  ): Promise<unknown> {
    return this.runtime.withAuthenticatedRead((context) =>
      this.dispatch(context, envelope, false),
    );
  }

  write<Variables>(
    operation: "cart" | "purchase" | "refund" | "release" | "expiration",
    envelope: GraphqlEnvelope<Variables>,
  ): Promise<unknown> {
    return this.runtime.withAuthenticatedWrite(async (context) => {
      // Bounded write budget: at most two dispatches and one recovery action
      // (a single 429 same-session retry OR one direct re-admission after a
      // complete challenge). The second dispatch is terminal; a transport throw
      // (no complete HTTP response) is never retried and stays ambiguous.
      let current = context;
      for (let dispatch = 0; ; dispatch++) {
        let response: {
          status: number;
          bodyText: string;
          headers: Record<string, string>;
        };
        try {
          response = await this.dispatchRaw(current, envelope, true);
        } catch (error) {
          // Missing-cookie is a contract error; anything else here is a
          // transport failure with no complete response — genuinely unknown.
          if (error instanceof AmcGraphqlContractError) throw error;
          throw new AmbiguousWriteError(operation);
        }
        const outcome = this.classifyWriteResponse(
          response,
          envelope.operationName,
        );
        if (outcome.kind === "ok") return outcome.value;
        if (outcome.kind === "ambiguous") {
          // A complete 5xx does NOT prove non-execution, so it stays ambiguous
          // (single dispatch, no retry) like a transport throw.
          throw new AmbiguousWriteError(operation);
        }
        if (outcome.kind === "captcha") {
          // A Cloudflare CAPTCHA is an interactive human boundary that immediate
          // re-admission cannot clear. Record the cooldown circuit breaker
          // BEFORE returning and fail typed — never refresh, never redispatch.
          const retryAt = await this.runtime.recordWriteCooldown();
          throw new WriteChallengeCooldownError(retryAt);
        }
        if (dispatch >= 1) {
          // Second dispatch is terminal — no third call.
          if (outcome.kind === "rate-limited") {
            throw new WriteRateLimitedError(operation);
          }
          if (outcome.kind === "challenge") {
            throw new WriteChallengedError(operation);
          }
          throw outcome.error;
        }
        // First dispatch: spend the single recovery action, or fail definitely.
        if (outcome.kind === "rate-limited") {
          // Exactly one immediate SAME-session redispatch.
          continue;
        }
        if (outcome.kind === "challenge") {
          // Exactly one bounded DIRECT re-admission (never launches a browser).
          // Browser-required, missing-listing-URL, or transport/canary failures
          // surface as a typed AMC_SESSION_REPAIR_REQUIRED with zero redispatch.
          current = await this.runtime.refreshDirectForWrite();
          continue;
        }
        // A complete 4xx (non-challenge) or contract drift is a definite
        // rejection: preserve the typed error, no retry beyond the 429 rule.
        throw outcome.error;
      }
    });
  }

  /**
   * Classify a COMPLETE write HTTP response. Only outcomes that are provably not
   * executed become retryable/definite: a 429 is an explicit rate-limit
   * rejection; a challenge (403/429 with anti-bot markers) is an edge rejection
   * before the origin mutation; a complete 4xx (or contract drift) is a definite
   * rejection. A complete 5xx is NOT proof of non-execution (the origin may have
   * mutated then failed), so it is reported as `ambiguous` and handled like a
   * transport throw (reconcile-only, no retry); a 200 parses to the result.
   */
  private classifyWriteResponse(
    response: {
      status: number;
      bodyText: string;
      headers?: Record<string, string>;
    },
    operationName: string,
  ):
    | { kind: "ok"; value: unknown }
    | { kind: "rate-limited" }
    | { kind: "challenge" }
    | { kind: "captcha" }
    | { kind: "ambiguous" }
    | { kind: "terminal"; error: Error } {
    // 429 stays an explicit rate-limit (one immediate retry) and 5xx stays
    // ambiguous, exactly as before — checked before challenge classification.
    if (response.status === 429) return { kind: "rate-limited" };
    if (response.status >= 500) return { kind: "ambiguous" };
    const challenge = antiBotChallengeKind(
      response.status,
      response.headers ?? {},
      response.bodyText,
    );
    if (challenge === "cloudflare-captcha") return { kind: "captcha" };
    if (challenge === "direct-recoverable") return { kind: "challenge" };
    try {
      return {
        kind: "ok",
        value: this.parseGraphResponse(response, operationName),
      };
    } catch (error) {
      if (error instanceof AmcChallengeError) return { kind: "challenge" };
      return { kind: "terminal", error: error as Error };
    }
  }

  private async dispatch(
    context: AmcSessionContext,
    envelope: GraphqlEnvelope<unknown> | GraphqlEnvelopeWithoutVariables,
    write: boolean,
  ): Promise<unknown> {
    const response = await this.dispatchRaw(context, envelope, write);
    return this.parseGraphResponse(response, envelope.operationName);
  }

  private async dispatchRaw(
    context: AmcSessionContext,
    envelope: GraphqlEnvelope<unknown> | GraphqlEnvelopeWithoutVariables,
    write: boolean,
  ): Promise<{
    status: number;
    bodyText: string;
    headers: Record<string, string>;
  }> {
    const cookie = cookieHeaderFor(context.session, GRAPHQL_URL);
    if (!cookie) throw new AmcGraphqlContractError(envelope.operationName);
    const response = await this.transport.request({
      method: "POST",
      url: GRAPHQL_URL,
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        origin: AMC_ORIGIN,
        referer: `${AMC_ORIGIN}/`,
        cookie,
      },
      body: JSON.stringify(envelope),
      verifyTLS: true,
      followRedirect: false,
      timeoutMs: write ? 60_000 : 45_000,
    });
    await context.persistSetCookies(GRAPHQL_URL, response.setCookies);
    return response;
  }

  private parseGraphResponse(
    response: {
      status: number;
      bodyText: string;
      headers?: Record<string, string>;
    },
    operationName: string,
  ): unknown {
    classifyGraphResponse(
      response.status,
      response.headers ?? {},
      response.bodyText,
      operationName,
    );
    try {
      return JSON.parse(response.bodyText);
    } catch {
      throw new AmcGraphqlContractError(operationName);
    }
  }
}

export class AmcGraphqlCommerceExecutor implements CommerceExecutor {
  constructor(
    private readonly graph: ScopedAmcGraphqlClient,
    private readonly projections: AmcCommerceProjectionProvider,
  ) {}

  async createCart(
    intent: CartCreateIntent,
    onToken?: (orderToken: string) => Promise<void>,
  ): Promise<CartSnapshot> {
    await this.projections.assertReady();
    const response = await this.graph.write(
      "cart",
      buildCartCreateEnvelope({
        products: intent.seats.map(({ sku, quantity, column, row }) => ({
          sku,
          quantity,
          column,
          row,
        })),
        waiveSubscriptionDiscounts: intent.waiveSubscriptionDiscounts,
      }),
    );
    const created = parseCartCreateResponse(response);
    await onToken?.(created.token);
    return this.projections.inspectCart(created.token, undefined, intent);
  }

  reconcileCart(intent: CartCreateIntent): Promise<CartSnapshot | null> {
    return Promise.resolve(this.projections.assertReady()).then(() =>
      this.projections.reconcileCart(intent),
    );
  }

  async inspectCart(
    orderToken: string,
    email: string,
    intent?: CartCreateIntent,
  ): Promise<CartSnapshot> {
    await this.projections.assertReady();
    return this.projections.inspectCart(orderToken, email || undefined, intent);
  }

  async deleteCart(orderToken: string): Promise<void> {
    const response = await this.graph.write(
      "release",
      buildOrderDeleteEnvelope(orderToken),
    );
    parseOrderDeleteResponse(response);
  }

  async reconcileRelease(orderToken: string): Promise<boolean> {
    await this.projections.assertReady();
    // Released iff the provider proves the order is cancelled/expired. A still
    // OPEN order or a FULFILLED (purchased) order is NOT released.
    return (await this.projections.projectStatus(orderToken)) === "EXPIRED";
  }

  async extendOrderExpiration(
    orderToken: string,
  ): Promise<{ expiresAt: string }> {
    await this.projections.assertReady();
    try {
      const response = await this.graph.write(
        "expiration",
        buildOrderExpirationUpdateEnvelope(orderToken),
      );
      parseOrderExpirationUpdateResponse(response);
    } catch (error) {
      // Extension is monotonic: on an ambiguous dispatch, do not redispatch;
      // authoritatively read the current expiry instead.
      if (!(error instanceof AmbiguousWriteError)) throw error;
    }
    return this.projections.projectExpiration(orderToken);
  }

  async searchOrder(
    orderNumber: string,
    email: string,
  ): Promise<RefundOrderSnapshot> {
    await this.projections.assertReady();
    const response = await this.graph.read(
      buildOrderSearchEnvelope({ orderNumber, email }),
    );
    const order = parseOrderSearchResponse(response);
    if (order.error) throw new AmcGraphqlContractError("OrderSearch");
    return this.projections.projectRefundOrder({
      orderNumber,
      email,
      orderToken: order.token,
    });
  }

  async refund(input: {
    token: string;
    lineNumbers: string[];
  }): Promise<{ orderId: string }> {
    await this.projections.assertReady();
    const response = await this.graph.write(
      "refund",
      buildOrderRefundEnvelope(input),
    );
    const refunded = parseOrderRefundResponse(response);
    return { orderId: refunded.id };
  }
}

export class AmcGraphqlPaymentProvider
  implements BraintreeClientTokenProvider, DirectOrderFulfillProvider
{
  constructor(
    private readonly graph: ScopedAmcGraphqlClient,
    private readonly projections: AmcCommerceProjectionProvider,
  ) {}

  async getClientToken(): Promise<string> {
    const response = await this.graph.read(
      buildBraintreeAuthorizationEnvelope(),
    );
    return parseBraintreeAuthorizationResponse(response).clientToken;
  }

  async fulfill(input: {
    token: string;
    email: string;
    paymentMethodType: "creditCard";
    nonce: string;
    postalCode: string;
    deviceData: string;
    expectedTotal: Money;
  }): Promise<PurchaseResult> {
    await this.projections.assertReady();
    const envelopeInput: OrderFulfillInput = {
      token: input.token,
      email: input.email,
      paymentMethodType: input.paymentMethodType,
      nonce: input.nonce,
      postalCode: input.postalCode,
      deviceData: input.deviceData,
    };
    const response = await this.graph.write(
      "purchase",
      buildOrderFulfillEnvelope(envelopeInput),
    );
    const fulfilled = parseOrderFulfillResponse(response);
    if (fulfilled.token !== input.token) {
      throw new AmcGraphqlContractError("OrderFulfill");
    }
    return this.projections.projectPurchase({
      orderToken: input.token,
      email: input.email,
      expectedTotal: input.expectedTotal,
    });
  }

  async reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null> {
    await this.projections.assertReady();
    return this.projections.reconcilePurchase(orderToken, email);
  }
}

function classifyGraphResponse(
  status: number,
  headers: Record<string, string>,
  body: string,
  operation: string,
): void {
  if (antiBotChallengeKind(status, headers, body) !== null) {
    throw new AmcChallengeError("AMC GraphQL returned an anti-bot challenge");
  }
  if (status === 401)
    throw new AmcAuthRejectedError("AMC GraphQL rejected the session");
  if (status !== 200) {
    throw new AmcHttpError(
      `AMC GraphQL ${operation} failed with HTTP ${status}`,
      status,
    );
  }
}

/** Older Queue-it / Cloudflare interstitial body markers (header-independent). */
const LEGACY_CHALLENGE_BODY =
  /(queue-it|queueit|waiting room|cf-chl|challenge-platform|just a moment)/i;
/**
 * Bounded Cloudflare CAPTCHA / managed-challenge body markers. Only consulted
 * together with a Cloudflare-fronted HTML response, so ordinary origin bodies
 * that merely contain one of these words are never misclassified.
 */
const CLOUDFLARE_CHALLENGE_BODY =
  /(captcha|hcaptcha|recaptcha|turnstile|attention required|checking your browser|verify you are (?:a )?human|are you a robot|needs to review the security|performance (?:&|&amp;) security by cloudflare)/i;

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export type AntiBotChallengeKind = "direct-recoverable" | "cloudflare-captcha";

/**
 * Positively identify an anti-bot challenge and its KIND (null when it is a
 * generic origin rejection, not a challenge):
 *  - `direct-recoverable`: the older Queue-it / Cloudflare interstitial body
 *    markers — cleared by one bounded direct re-admission + one redispatch.
 *  - `cloudflare-captcha`: a 403/429 HTML response that is Cloudflare-fronted
 *    (server=cloudflare or a cf-ray/cf-mitigated header) AND carries a bounded
 *    Cloudflare CAPTCHA/challenge body marker. A bare `server: cloudflare` is
 *    never sufficient. This interactive CAPTCHA cannot be cleared by immediate
 *    re-admission, so writes trip the cooldown circuit breaker instead.
 */
export function antiBotChallengeKind(
  status: number,
  headers: Record<string, string>,
  body: string,
): AntiBotChallengeKind | null {
  if (status !== 403 && status !== 429) return null;
  if (LEGACY_CHALLENGE_BODY.test(body)) return "direct-recoverable";
  const contentType = (
    headerValue(headers, "content-type") ?? ""
  ).toLowerCase();
  if (!contentType.includes("text/html")) return null;
  const server = (headerValue(headers, "server") ?? "").toLowerCase();
  const cloudflareFronted =
    server.includes("cloudflare") ||
    headerValue(headers, "cf-ray") !== undefined ||
    headerValue(headers, "cf-mitigated") !== undefined;
  if (!cloudflareFronted) return null;
  return CLOUDFLARE_CHALLENGE_BODY.test(body) ? "cloudflare-captcha" : null;
}
