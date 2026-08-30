import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { syntheticListingHtml, syntheticSeatHtml } from "./fixtures";

import { AMC_SESSION_KEY } from "../src/client/runtime";
import { encodeAmcSession } from "../src/client/session";
import {
  AmcCommerceProjectionProvider,
  ScopedAmcGraphqlClient,
} from "../src/commerce/graphql-executor";
import {
  BraintreeHttpRequest,
  DeviceDataProvider,
  HttpTransport,
  SecretCardLease,
  SecretCardProvider,
} from "../src/commerce/direct-braintree-tokenizer";
import {
  RiskHttpRequest,
  RiskHttpTransport,
} from "../src/commerce/direct-risk-providers";
import { AmcRuntime } from "../src/client/runtime";
import { buildAmcCheckoutService } from "../src/commerce/wiring";
import {
  AmcCapabilityUnavailableError,
  CartCreateIntent,
  CartSnapshot,
  OrderLifecycle,
  PurchaseResult,
  RefundOrderSnapshot,
} from "../src/commerce/executor";

// One labeled example theater; any official AMC theater URL works.
const LISTING_URL =
  "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("AMC checkout wiring", () => {
  it("keeps reads operational and scopes missing payment to checkout submit", async () => {
    const root = await tempRoot();
    const store = new FileSessionStore({ root: path.join(root, "sessions") });
    const projection = new FakeProjectionProvider();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({
        version: 1,
        origin: "https://www.amctheatres.com",
        profile: "chrome147-mac",
        exportedAt: "2030-01-15T08:00:00.000Z",
        cookies: [
          {
            name: "session",
            value: "private-session-value",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ],
      }),
    );
    const transport = new QueueTransport([
      htmlResponse(fixture("metreon-2030-01-15.html")),
      jsonResponse({
        data: {
          viewer: {
            order: {
              accountId: null,
              error: null,
              token: projection.order.orderToken,
            },
          },
        },
      }),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });
    const { service } = buildAmcCheckoutService({
      transport,
      store,
      runtime,
      projections: projection,
    });

    const checkout = await service.previewCheckout({
      orderToken: projection.cart.orderToken,
      email: "guest@example.test",
    });
    expect(checkout).toMatchObject({
      orderToken: projection.cart.orderToken,
      total: "55.56",
    });
    await expect(
      service.previewFullRefund({
        orderNumber: projection.order.orderNumber,
        email: "guest@example.test",
      }),
    ).resolves.toMatchObject({
      refundTotal: "49.58",
      nonRefundableFee: "5.98",
    });
    await expect(
      service.submitCheckout({
        preview: checkout,
        confirmationToken: checkout.confirmationToken,
        email: "guest@example.test",
        vaultPointer: "vault://trusted-provider-pointer",
      }),
    ).rejects.toBeInstanceOf(AmcCapabilityUnavailableError);
  });

  it("uses GraphQL rather than order or seat pages for default cart projection", async () => {
    const root = await tempRoot();
    const store = new FileSessionStore({ root: path.join(root, "sessions") });
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({
        version: 1,
        origin: "https://www.amctheatres.com",
        profile: "chrome147-mac",
        exportedAt: "2030-01-15T08:00:00.000Z",
        cookies: [
          {
            name: "session",
            value: "private-session-value",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
        ],
      }),
    );
    const orderToken = "00000000-0000-4000-8000-000000000002";
    const transport = new QueueTransport([
      htmlResponse(fixture("metreon-2030-01-15.html")),
      jsonResponse({ data: { orderCreate: { order: { token: orderToken } } } }),
      htmlResponse(fixture("metreon-2030-01-15.html")),
      jsonResponse(pendingOrderProjection(orderToken)),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });
    const { service } = buildAmcCheckoutService({ transport, store, runtime });

    await expect(
      service.createCart({
        showtimeId: "900000006",
        seats: [
          {
            name: "E9",
            sku: "TICKET-RS-900000006-ADULT",
            quantity: 1,
            row: 3,
            column: 14,
          },
        ],
        waiveSubscriptionDiscounts: false,
        expectedTotal: "31.98",
        holdAcknowledgement: "CREATE_HOLD",
      }),
    ).resolves.toMatchObject({
      orderToken,
      seats: [{ name: "E9", row: 3, column: 14 }],
    });
    expect(
      transport.sent.filter((request) =>
        /\/orders\/|\/showtimes\/\d+\/seats/.test(
          new URL(request.url).pathname,
        ),
      ),
    ).toEqual([]);
  });

  it("marks scoped GraphQL replay as requiring a live canary", () => {
    const graph = new ScopedAmcGraphqlClient(
      new QueueTransport([]),
      {} as ConstructorParameters<typeof ScopedAmcGraphqlClient>[1],
    );
    expect(graph.replayStatus).toBe("requires-live-canary");
  });

  it("runs direct checkout through concrete production provider hooks", async () => {
    const root = await tempRoot();
    const store = new FileSessionStore({ root: path.join(root, "sessions") });
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({
        version: 1,
        origin: "https://www.amctheatres.com",
        profile: "chrome147-mac",
        exportedAt: "2030-01-15T08:00:00.000Z",
        cookies: [
          {
            name: "session",
            value: "private-session-value",
            domain: ".amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
          },
          {
            name: "clientside-cookie",
            value: "synthetic-kount-cookie",
            domain: "www.amctheatres.com",
            path: "/",
            expires: -1,
            secure: true,
            httpOnly: false,
            sameSite: "None",
          },
        ],
      }),
    );
    const projection = new FakeProjectionProvider();
    const clientTokenResponse = () =>
      jsonResponse({
        data: {
          viewer: {
            user: {
              paymentVendor: {
                clientToken: Buffer.from(
                  JSON.stringify({
                    authorizationFingerprint: "synthetic-fingerprint",
                  }),
                ).toString("base64"),
              },
            },
          },
        },
      });
    const transport = new QueueTransport([
      htmlResponse(fixture("metreon-2030-01-15.html")),
      clientTokenResponse(),
      htmlResponse(fixture("metreon-2030-01-15.html")),
      jsonResponse({
        data: {
          orderFulfill: { order: { token: projection.cart.orderToken } },
        },
      }),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });
    const { service } = buildAmcCheckoutService({
      transport,
      store,
      runtime,
      projections: projection,
      capabilities: {
        cardProvider: new FakeSecretCardProvider(),
        deviceData: new FakeDeviceDataProvider(),
        riskHttp: new FakeRiskHttp(),
        braintreeHttp: new FakeBraintreeHttp(),
      },
    });
    const preview = await service.previewCheckout({
      orderToken: projection.cart.orderToken,
      email: "guest@example.test",
    });
    await expect(
      service.submitCheckout({
        preview,
        confirmationToken: preview.confirmationToken,
        email: "guest@example.test",
        vaultPointer: "vault://synthetic-card",
      }),
    ).resolves.toMatchObject({
      confirmationNumber: projection.order.orderNumber,
      chargedTotal: "55.56",
      status: "CONFIRMED",
    });
    expect(
      transport.sent.filter((request) => request.url.includes("graph.")),
    ).toHaveLength(2);
  });
});

class QueueTransport implements Transport {
  readonly name = "recording";
  readonly sent: RequestInput[] = [];
  constructor(private readonly responses: ResponseOutput[]) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected AMC request");
    return response;
  }
}

class FakeProjectionProvider implements AmcCommerceProjectionProvider {
  cart: CartSnapshot = {
    orderToken: "00000000-0000-4000-8000-000000000003",
    showtimeId: "900000005",
    seats: [
      { name: "H7", sku: "TICKET-RS-900000005-ADULT", row: 9, column: 17 },
      { name: "H8", sku: "TICKET-RS-900000005-ADULT", row: 9, column: 16 },
    ],
    tickets: [{ sku: "TICKET-RS-900000005-ADULT", quantity: 2 }],
    total: "55.56",
    expiresAt: "2099-08-15T09:45:00.000Z",
    status: "OPEN",
  };
  order: RefundOrderSnapshot = {
    orderNumber: "0000000001",
    orderToken: this.cart.orderToken,
    status: "CONFIRMED",
    chargedTotal: "55.56",
    nonRefundableFee: "5.98",
    lines: [
      {
        lineNumber: "1",
        label: "Adult H7",
        refundableAmount: "24.79",
        status: "PAID",
      },
      {
        lineNumber: "2",
        label: "Adult H8",
        refundableAmount: "24.79",
        status: "PAID",
      },
    ],
  };

  assertReady(): void {}
  inspectCart(): Promise<CartSnapshot> {
    return Promise.resolve(structuredClone(this.cart));
  }
  projectLifecycle(): Promise<OrderLifecycle> {
    return Promise.resolve({ kind: "open", cart: structuredClone(this.cart) });
  }
  reconcileCart(_intent: CartCreateIntent): Promise<CartSnapshot | null> {
    return Promise.resolve(structuredClone(this.cart));
  }
  projectRefundOrder(): Promise<RefundOrderSnapshot> {
    return Promise.resolve(structuredClone(this.order));
  }
  projectPurchase(): Promise<PurchaseResult> {
    return Promise.resolve({
      orderToken: this.cart.orderToken,
      confirmationNumber: this.order.orderNumber,
      chargedTotal: this.cart.total,
      status: "CONFIRMED",
    });
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.resolve(null);
  }
  projectExpiration(): Promise<{ expiresAt: string }> {
    return Promise.resolve({ expiresAt: this.cart.expiresAt });
  }
  projectStatus(): Promise<"OPEN" | "FULFILLED" | "EXPIRED"> {
    return Promise.resolve("OPEN");
  }
}

class FakeSecretCardProvider implements SecretCardProvider {
  getCard(): Promise<SecretCardLease> {
    return Promise.resolve({
      card: {
        number: "4111111111111111",
        expirationMonth: "12",
        expirationYear: "2030",
        cvv: "123",
        postalCode: "94103",
      },
      dispose: () => undefined,
    });
  }
}

class FakeDeviceDataProvider implements DeviceDataProvider {
  collect(): Promise<{ deviceData: string; fresh: boolean }> {
    return Promise.resolve({
      deviceData: '{"correlation_id":"fresh-fraudnet-id"}',
      fresh: true,
    });
  }
}

class FakeRiskHttp implements RiskHttpTransport {
  readonly requests: RiskHttpRequest[] = [];

  request(
    input: RiskHttpRequest,
  ): Promise<{ status: number; bodyText: string }> {
    this.requests.push(structuredClone(input));
    if (input.url.startsWith("https://c.paypal.com/")) {
      return Promise.resolve({ status: 200, bodyText: "<!doctype html>" });
    }
    if (input.url.includes("/cs/config?")) {
      return Promise.resolve({
        status: 200,
        bodyText:
          '{"collection":{"collect":true,"feature_flags":{"app":true,"battery":true,"browser":true,"exp":true,"page":true,"ui":true,"passLoc":true}}}',
      });
    }
    if (input.url.includes("/session/"))
      return Promise.resolve({ status: 201, bodyText: "" });
    if (input.url.endsWith("/cs/storecookie")) {
      return Promise.resolve({ status: 200, bodyText: "" });
    }
    return Promise.reject(new Error("unexpected synthetic risk request"));
  }
}

class FakeBraintreeHttp implements HttpTransport {
  post(
    _request: BraintreeHttpRequest,
  ): Promise<{ status: number; bodyText: string }> {
    return Promise.resolve({
      status: 200,
      bodyText: JSON.stringify({
        data: {
          tokenizeCreditCard: {
            token: "synthetic-nonce",
            creditCard: {
              brandCode: "VISA",
              last4: "1111",
              expirationMonth: "12",
              expirationYear: "2030",
              binData: {
                prepaid: "NO",
                healthcare: "UNKNOWN",
                debit: "NO",
                durbinRegulated: "NO",
                commercial: "NO",
                payroll: "NO",
                issuingBank: "TEST",
                countryOfIssuance: "USA",
                productId: "TEST",
                business: "UNKNOWN",
                consumer: "YES",
                purchase: "UNKNOWN",
                corporate: "UNKNOWN",
              },
            },
          },
        },
      }),
    });
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-production-test-"));
  roots.push(root);
  return root;
}

function pendingOrderProjection(orderToken: string) {
  return {
    data: {
      viewer: {
        order: {
          token: orderToken,
          orderId: null,
          status: "Pending",
          email: null,
          paid: 0,
          total: 31.98,
          feesTotal: 2.99,
          refundableTotal: 28.99,
          refundableType: "WHOLE",
          remainingBalance: 31.98,
          expirationDateUtc: "2099-08-15T22:04:35.163Z",
          isRefunded: false,
          groups: [
            {
              confirmationCode: null,
              reservedSeats: "E9",
              feesTotal: 2.99,
              subtotal: 31.98,
              tax: 0,
              total: 31.98,
              type: "TICKET-RS",
              showtime: { showtimeId: 900000006 },
              items: [
                {
                  sku: "TICKET-RS-900000006-ADULT",
                  name: "Adult",
                  quantity: 1,
                  cost: 28.99,
                  tax: 0,
                  lineItems: [],
                },
              ],
            },
          ],
          refundedPaymentGroups: [],
          error: null,
        },
      },
    },
  };
}

function fixture(name: string): string {
  if (name.startsWith("metreon-")) return syntheticListingHtml();
  if (name.startsWith("seat-")) return syntheticSeatHtml();
  throw new Error(`unknown synthetic fixture: ${name}`);
}

function htmlResponse(bodyText: string): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    bodyText,
    timingMs: 1,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}

function jsonResponse(body: unknown): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify(body),
    timingMs: 1,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}
