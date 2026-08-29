import { MemorySessionStore, SessionStore } from "./auth-session";
import { HelloTransport, Transport } from "./transport";
import { AmcBrowserRefresher } from "./client/browser-refresh";
import {
  AmcRuntime,
  bootstrapAmcSession,
  clearAmcSession,
  getAmcAuthStatus,
  type AmcAuthStatus,
} from "./client/runtime";
import { AmcSeatLayoutBatch } from "./client/graphql-reads";
import { AmcSeatingLayout } from "./client/seat-layout";
import {
  AmcShowtime,
  AmcShowtimeQuery,
  AmcVenueRegistry,
} from "./client/showtimes";
import {
  CartCreateIntent,
  CartSnapshot,
  Money,
  PurchaseResult,
  RefundOrderSnapshot,
} from "./commerce/executor";
import {
  CartCreationOutcomeUnknownError,
  CheckoutChallengePreview,
  CheckoutOutcomeUnknownError,
  CheckoutPreview,
  RefundOutcomeUnknownError,
  RefundPreview,
  UnknownWriteOutcomeError,
} from "./commerce/service";
import {
  AmcCheckoutCapabilities,
  buildAmcCheckoutService,
} from "./commerce/wiring";

const READ_MODE_DEFAULT = "graphql" as const;

export interface AmcClientConfig {
  /** Request transport. Defaults to the public HelloJS transport. */
  transport?: Transport;
  /** HelloJS profile/proxy used only when `transport` is not provided. */
  hello?: { profile?: string; proxyUrl?: string };
  /**
   * Session jar persistence. Defaults to an in-memory store so an imported
   * client writes no hidden filesystem state. Pass a FileSessionStore (or any
   * SessionStore) explicitly for durable, cross-process persistence.
   */
  store?: SessionStore;
  /** Read strategy. Defaults to GraphQL (also selects a GraphQL auth canary). */
  readMode?: "graphql" | "ssr";
  /**
   * Optional caller-injected venue registry keyed by your own names. There is
   * NO built-in venue; the canonical input is a descriptor resolved from an
   * official theater URL via `resolveOfficialAmcTheaterUrl`.
   */
  venues?: AmcVenueRegistry;
  /** Explicit browser session-repair capability. None by default. */
  browserRepair?: AmcBrowserRefresher;
  /** Explicit checkout capabilities (card provider, challenge handler, recovery). */
  checkout?: AmcCheckoutCapabilities;
  now?: () => Date;
}

export interface AmcClient {
  readonly showtimes: {
    list(query: AmcShowtimeQuery): Promise<AmcShowtime[]>;
  };
  readonly inventory: {
    get(showtimeId: string): Promise<AmcSeatingLayout>;
    getBatch(showtimeIds: readonly string[]): Promise<AmcSeatLayoutBatch>;
  };
  readonly auth: {
    status(): Promise<AmcAuthStatus>;
    bootstrap(bundle: Uint8Array): Promise<void>;
    clear(): Promise<void>;
    /**
     * Explicit-only session repair. A command-local `browserRepair` capability
     * and/or admission `listingUrl` applies to this call only; ordinary reads
     * always stay direct-only.
     */
    repair(options?: {
      browserRepair?: AmcBrowserRefresher;
      listingUrl?: string;
    }): Promise<void>;
  };
  readonly orders: {
    createCart(
      intent: CartCreateIntent,
      opts?: { checkoutSessionId?: string },
    ): Promise<CartSnapshot>;
    get(input: { orderToken: string; email: string }): Promise<CartSnapshot>;
    extendExpiration(input: {
      orderToken: string;
    }): Promise<{ orderToken: string; expiresAt: string }>;
    release(
      orderToken: string,
      opts?: { checkoutSessionId?: string },
    ): Promise<{ released: true }>;
  };
  readonly checkout: {
    preview(input: {
      orderToken: string;
      email: string;
    }): Promise<CheckoutPreview>;
    submit(input: {
      preview: CheckoutPreview;
      confirmationToken: string;
      email: string;
      vaultPointer: string;
    }): Promise<PurchaseResult & { reconciled: boolean }>;
    reconcile(input: {
      orderToken: string;
      email: string;
    }): Promise<PurchaseResult | null>;
  };
  readonly refunds: {
    preview(input: {
      orderNumber: string;
      email: string;
      lineNumbers?: string[];
    }): Promise<RefundPreview>;
    submit(input: {
      preview: RefundPreview;
      confirmationToken: string;
      email: string;
    }): Promise<{
      orderId: string;
      status: "REFUND_REQUESTED" | "REFUNDED";
      refundTotal: Money;
      nonRefundableFee: Money;
      reconciled: boolean;
    }>;
    reconcile(input: {
      orderNumber: string;
      email: string;
    }): Promise<RefundOrderSnapshot>;
  };
  close(): Promise<void>;
}

/**
 * Construct the public AMC client. With no configuration it uses the public
 * HelloJS transport, an in-memory session jar (no hidden filesystem state),
 * GraphQL-first reads, direct-only session repair, and no checkout
 * payment/recovery capability. Everything is a plain, explicit seam; nothing
 * browser, card, proxy, or identity-related is wired implicitly.
 */
export function createAmcClient(config: AmcClientConfig = {}): AmcClient {
  // The client owns (and later closes) only a transport it constructs itself.
  // An injected transport's lifecycle belongs to the caller.
  const injectedTransport = config.transport !== undefined;
  const transport =
    config.transport ??
    new HelloTransport({
      ...(config.hello?.profile ? { profile: config.hello.profile } : {}),
      ...(config.hello?.proxyUrl ? { proxyUrl: config.hello.proxyUrl } : {}),
    });
  const store = config.store ?? new MemorySessionStore();
  const readMode = config.readMode ?? READ_MODE_DEFAULT;
  const venues: AmcVenueRegistry = { ...(config.venues ?? {}) };
  const runtime = new AmcRuntime({
    transport,
    store,
    readMode,
    venues,
    ...(config.browserRepair ? { browserRefresher: config.browserRepair } : {}),
  });
  const { service, reconcile } = buildAmcCheckoutService({
    transport,
    store,
    runtime,
    ...(config.checkout ? { capabilities: config.checkout } : {}),
    ...(config.now ? { now: config.now } : {}),
  });

  return {
    showtimes: {
      list: (query) => runtime.getShowtimes(query),
    },
    inventory: {
      get: (showtimeId) => runtime.getSeatLayout(showtimeId),
      getBatch: (showtimeIds) => runtime.getSeatLayouts(showtimeIds),
    },
    auth: {
      status: () => getAmcAuthStatus(transport, store, readMode),
      bootstrap: (bundle) =>
        bootstrapAmcSession(bundle, transport, store, readMode),
      clear: () => clearAmcSession(store),
      repair: (options) =>
        runtime.repairSession(
          options
            ? {
                ...(options.browserRepair
                  ? { browserRefresher: options.browserRepair }
                  : {}),
                ...(options.listingUrl
                  ? { listingUrl: options.listingUrl }
                  : {}),
              }
            : undefined,
        ),
    },
    orders: {
      createCart: async (intent, opts) => {
        try {
          return await service.createCart(intent, opts?.checkoutSessionId);
        } catch (error) {
          throw mapUnknown(
            error,
            (message) =>
              new CartCreationOutcomeUnknownError(message, {
                showtimeId: intent.showtimeId,
                seatNames: intent.seats.map((seat) => seat.name),
              }),
          );
        }
      },
      get: (input) => service.inspectCart(input.orderToken, input.email),
      extendExpiration: (input) =>
        service.extendOrderExpiration(input.orderToken),
      release: (orderToken, opts) =>
        service.releaseCart(orderToken, opts?.checkoutSessionId),
    },
    checkout: {
      preview: (input) => service.previewCheckout(input),
      submit: async (input) => {
        try {
          return await service.submitCheckout(input);
        } catch (error) {
          throw mapUnknown(
            error,
            (message) =>
              new CheckoutOutcomeUnknownError(message, {
                orderToken: input.preview.orderToken,
              }),
          );
        }
      },
      reconcile: (input) => reconcile.checkout(input.orderToken, input.email),
    },
    refunds: {
      preview: (input) =>
        input.lineNumbers
          ? service.previewRefund({
              orderNumber: input.orderNumber,
              email: input.email,
              lineNumbers: input.lineNumbers,
            })
          : service.previewFullRefund({
              orderNumber: input.orderNumber,
              email: input.email,
            }),
      submit: async (input) => {
        try {
          return await service.submitRefund(input);
        } catch (error) {
          throw mapUnknown(
            error,
            (message) =>
              new RefundOutcomeUnknownError(message, {
                orderNumber: input.preview.orderNumber,
                orderToken: input.preview.orderToken,
                lineNumbers: [...input.preview.lineNumbers],
              }),
          );
        }
      },
      reconcile: (input) => reconcile.refund(input.orderNumber, input.email),
    },
    async close() {
      // Only close a transport the client constructed; a caller-injected
      // transport (possibly shared across clients) is the caller's to close.
      if (!injectedTransport) await transport.close?.();
    },
  };
}

export type { CheckoutChallengePreview };

/**
 * Translate a generic ambiguous-write error into the operation-specific typed
 * error carrying only safe reconciliation context. Any already-specific or
 * unrelated error passes through unchanged.
 */
function mapUnknown(
  error: unknown,
  make: (message: string) => UnknownWriteOutcomeError,
): unknown {
  if (
    error instanceof UnknownWriteOutcomeError &&
    !(error instanceof CartCreationOutcomeUnknownError) &&
    !(error instanceof CheckoutOutcomeUnknownError) &&
    !(error instanceof RefundOutcomeUnknownError)
  ) {
    return make(error.message);
  }
  return error;
}
