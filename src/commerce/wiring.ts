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
import { CartIntentStore } from "./cart-intent-store";
import { PendingWriteStore } from "./pending-write-store";
import { AmcCommerceService, CheckoutRecovery } from "./service";

/** Default durable recovery bundle (cart-intent store + uncertainty ledger) over a SessionStore. */
export function createFileCheckoutRecovery(
  store: SessionStore,
): CheckoutRecovery {
  return {
    intents: new CartIntentStore(store),
    pending: new PendingWriteStore(store),
    store,
  };
}

/**
 * Explicit, non-ambient checkout capabilities. Direct GraphQL operations work
 * with none; `cardProvider` unlocks direct fulfillment, `challengeHandler` the
 * interactive 3DS path, `recovery` durable cross-process resume.
 */
export interface AmcCheckoutCapabilities {
  /** Supplies raw card material behind an ephemeral lease. Never in argv/JSON. */
  cardProvider?: SecretCardProvider;
  /** Interactive browser payment/3DS handler for the challenge path. */
  challengeHandler?: PaymentExecutor;
  /** Optional durable recovery bundle for cross-process crash recovery. */
  recovery?: CheckoutRecovery;
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
 * Compose the commerce service from explicit seams. Payment fulfillment is
 * available only when a `cardProvider` is supplied (else submit fails typed).
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
    projections,
    payment,
    ...(capabilities.challengeHandler
      ? { challengePayment: capabilities.challengeHandler }
      : {}),
    ...(capabilities.recovery ? { recovery: capabilities.recovery } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    service,
    reconcile: {
      checkout: (orderToken, email) =>
        service.reconcileCheckoutByToken(orderToken, email),
      refund: (orderNumber, email) => executor.searchOrder(orderNumber, email),
    },
  };
}
