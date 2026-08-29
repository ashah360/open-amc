import { SessionStore } from "../auth-session";
import { Transport } from "../transport";
import { AmcRuntime } from "../client/runtime";
import {
  DeviceDataProvider,
  DirectBraintreeTokenizer,
  DirectBraintreeTokenizerPaymentExecutor,
  FetchHttpTransport,
  HttpTransport,
  KountSessionProvider,
  SecretCardProvider,
} from "./direct-braintree-tokenizer";
import {
  AmcKountSessionProvider,
  FetchRiskHttpTransport,
  RiskHttpTransport,
  StoredAmcKountCookieProvider,
  SyntheticFraudNetDeviceDataProvider,
} from "./direct-risk-providers";
import {
  PaymentCapabilityUnavailableExecutor,
  PaymentExecutor,
  PurchaseResult,
  RefundOrderSnapshot,
} from "./executor";
import {
  AmcCommerceProjectionProvider,
  AmcGraphqlCommerceExecutor,
  AmcGraphqlPaymentProvider,
  ScopedAmcGraphqlClient,
} from "./graphql-executor";
import { AmcGraphqlOrderProjectionProvider } from "./graphql-order-projection";
import { CheckoutJournal } from "./checkout-journal";
import { AmcCommerceService } from "./service";

/**
 * Explicit, non-ambient checkout capabilities. Nothing here is defaulted to a
 * home proxy, 1Password, Gmail, or any personal identity; a caller wires only
 * what it needs. Direct GraphQL cart/order/refund/expiration operations work
 * with no capabilities at all. `cardProvider` unlocks direct Braintree
 * tokenization + fulfillment; `challengeHandler` unlocks the interactive
 * 3DS/hosted-frame path; `recovery` opts into durable cross-process resume.
 */
export interface AmcCheckoutCapabilities {
  /** Supplies raw card material behind an ephemeral lease. Never in argv/JSON. */
  cardProvider?: SecretCardProvider;
  /** Interactive browser payment/3DS handler for the challenge path. */
  challengeHandler?: PaymentExecutor;
  /** Optional durable operation store for cross-process crash recovery. */
  recovery?: CheckoutJournal;
  /** Advanced overrides for the fraud/risk seams. */
  deviceData?: DeviceDataProvider;
  kount?: KountSessionProvider;
  braintreeHttp?: HttpTransport;
  riskHttp?: RiskHttpTransport;
}

export interface BuildAmcCheckoutServiceOptions {
  transport: Transport;
  store: SessionStore;
  runtime: AmcRuntime;
  /** Defaults to the direct GraphQL order projection over the same session. */
  projections?: AmcCommerceProjectionProvider;
  capabilities?: AmcCheckoutCapabilities;
  now?: () => Date;
}

export interface AmcCheckoutReconciler {
  /** Authoritative read of a fulfilled order, keyed by the order token. */
  checkout(orderToken: string, email: string): Promise<PurchaseResult | null>;
  /** Authoritative read of an order's refund consequence, keyed by number. */
  refund(orderNumber: string, email: string): Promise<RefundOrderSnapshot>;
}

export interface BuiltAmcCheckout {
  service: AmcCommerceService;
  reconcile: AmcCheckoutReconciler;
}

/**
 * Compose the AMC commerce service from explicit seams. Direct GraphQL
 * cart/order/refund/expiration always work. Payment fulfillment is available
 * only when a `cardProvider` is supplied; otherwise checkout submit fails with
 * a typed capability error rather than an ambient default.
 */
export function buildAmcCheckoutService(
  options: BuildAmcCheckoutServiceOptions,
): BuiltAmcCheckout {
  const capabilities = options.capabilities ?? {};
  const graph = new ScopedAmcGraphqlClient(options.transport, options.runtime);
  const projections =
    options.projections ?? new AmcGraphqlOrderProjectionProvider(graph);
  const executor = new AmcGraphqlCommerceExecutor(graph, projections);
  const graphPayment = new AmcGraphqlPaymentProvider(graph, projections);

  let payment: PaymentExecutor;
  if (capabilities.cardProvider) {
    const deviceData =
      capabilities.deviceData ?? new SyntheticFraudNetDeviceDataProvider();
    const kount =
      capabilities.kount ??
      new AmcKountSessionProvider({
        http: capabilities.riskHttp ?? new FetchRiskHttpTransport(),
        firstPartyCookie: new StoredAmcKountCookieProvider(options.store),
      });
    const tokenizer = new DirectBraintreeTokenizer({
      http: capabilities.braintreeHttp ?? new FetchHttpTransport(),
      cards: capabilities.cardProvider,
      clientTokens: graphPayment,
      deviceData,
      kount,
    });
    payment = new DirectBraintreeTokenizerPaymentExecutor({
      tokenizer,
      orders: graphPayment,
    });
  } else {
    payment = new PaymentCapabilityUnavailableExecutor();
  }

  const service = new AmcCommerceService({
    executor,
    payment,
    ...(capabilities.challengeHandler
      ? { challengePayment: capabilities.challengeHandler }
      : {}),
    ...(capabilities.recovery ? { journal: capabilities.recovery } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    service,
    reconcile: {
      checkout: (orderToken, email) =>
        graphPayment.reconcilePurchase(orderToken, email),
      refund: (orderNumber, email) => executor.searchOrder(orderNumber, email),
    },
  };
}
