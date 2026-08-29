import { Transport } from "../transport";
import {
  AmcAuthRejectedError,
  AmcChallengeError,
  AmcHttpError,
} from "../client/client";
import { AmcRuntime, AmcSessionContext } from "../client/runtime";
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
  PurchaseResult,
  RefundOrderSnapshot,
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
      try {
        return await this.dispatch(context, envelope, true);
      } catch (error) {
        if (error instanceof AmcGraphqlContractError) throw error;
        throw new AmbiguousWriteError(operation);
      }
    });
  }

  private async dispatch(
    context: AmcSessionContext,
    envelope: GraphqlEnvelope<unknown> | GraphqlEnvelopeWithoutVariables,
    write: boolean,
  ): Promise<unknown> {
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
    classifyGraphResponse(
      response.status,
      response.bodyText,
      envelope.operationName,
    );
    try {
      return JSON.parse(response.bodyText);
    } catch {
      throw new AmcGraphqlContractError(envelope.operationName);
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
  body: string,
  operation: string,
): void {
  if (
    (status === 403 || status === 429) &&
    /(queue-it|queueit|waiting room|cf-chl|challenge-platform|just a moment)/i.test(
      body,
    )
  ) {
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
