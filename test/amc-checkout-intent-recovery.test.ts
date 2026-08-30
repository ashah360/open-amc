import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { AMC_SESSION_KEY, AmcRuntime } from "../src/client/runtime";
import { AmcSession, encodeAmcSession } from "../src/client/session";
import { buildAmcCheckoutService } from "../src/commerce/wiring";
import {
  CheckoutJournalCorruptError,
  FileCheckoutJournal,
} from "../src/commerce/checkout-journal";
import {
  CartIntentUnavailableError,
  CartNotResumableError,
} from "../src/commerce/service";
import { CartCreateIntent } from "../src/commerce/executor";

const LISTING_URL =
  "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes";
const ORDER_TOKEN = "00000000-0000-4000-8000-000000000042";
const SHOWTIME = "146600823";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe("durable cross-process cart-intent recovery", () => {
  it("recovers the exact journaled intent so a NEW service+projection instance previews by token and returns the provider-authoritative total", async () => {
    const ctx = await sharedContext();

    // Process A: create the cart (journals the intent + order-token alias).
    const processA = ctx.buildProcess();
    const cart = await processA.service.createCart(intent());
    expect(cart.orderToken).toBe(ORDER_TOKEN);
    expect(cart.total).toBe("12.44");

    // Process B: a brand-new service + projection provider sharing only the
    // durable journal + session store (no in-process intent map).
    const processB = ctx.buildProcess();
    const preview = await processB.service.previewCheckout({
      orderToken: ORDER_TOKEN,
      email: "guest@example.test",
    });
    expect(preview.orderToken).toBe(ORDER_TOKEN);
    expect(preview.total).toBe("12.44");
    expect(preview.seats.map((s) => s.name)).toEqual(["A10"]);
    // The projection in B never saw createCart, so recovery MUST have supplied
    // the intent from the journal (otherwise it would drift on cart.intent).
    expect(processB.cartCreateCount()).toBe(0);
  });

  it("submits token-first in a fresh process using the recovered intent and never creates a second cart", async () => {
    const ctx = await sharedContext();
    await ctx.buildProcess().service.createCart(intent());

    const processB = ctx.buildProcess({ withPayment: true });
    const preview = await processB.service.previewCheckout({
      orderToken: ORDER_TOKEN,
      email: "guest@example.test",
    });
    const purchase = await processB.service.submitCheckout({
      preview,
      confirmationToken: preview.confirmationToken,
      email: "guest@example.test",
      vaultPointer: "vault://synthetic-card",
    });
    expect(purchase.confirmationNumber).toBe("0000000001");
    expect(processB.cartCreateCount()).toBe(0);
  });

  it("fails with the actionable AMC_CART_INTENT_UNAVAILABLE (not a low-level cart.intent drift) for a token with no journaled intent", async () => {
    const ctx = await sharedContext();
    const processB = ctx.buildProcess();

    const error = await processB.service
      .previewCheckout({
        orderToken: "00000000-0000-4000-8000-000000000099",
        email: "guest@example.test",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CartIntentUnavailableError);
    expect((error as CartIntentUnavailableError).code).toBe(
      "AMC_CART_INTENT_UNAVAILABLE",
    );
  });

  it("fails closed when the order-token alias is tampered", async () => {
    const ctx = await sharedContext();
    await ctx.buildProcess().service.createCart(intent());

    // Corrupt the order-token alias so it points at a non-existent attempt.
    await ctx.store.save(
      { provider: "amc-checkout-order", account: sha256(ORDER_TOKEN) },
      Buffer.from(
        JSON.stringify({ version: 1, attemptId: "f".repeat(64) }),
        "utf8",
      ),
    );

    const error = await ctx
      .buildProcess()
      .service.previewCheckout({
        orderToken: ORDER_TOKEN,
        email: "guest@example.test",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CheckoutJournalCorruptError);
  });

  it("fails closed when the journaled attempt is not an open cart (released)", async () => {
    const ctx = await sharedContext();
    await ctx.buildProcess().service.createCart(intent());

    // Move the attempt to RELEASED (its order alias still resolves it).
    const journal = new FileCheckoutJournal(ctx.store);
    const attempt = await journal.loadByOrderToken(ORDER_TOKEN);
    await journal.save({
      ...attempt!,
      state: "RELEASED",
      updatedAt: new Date().toISOString(),
    });

    const error = await ctx
      .buildProcess()
      .service.previewCheckout({
        orderToken: ORDER_TOKEN,
        email: "guest@example.test",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CartNotResumableError);
    expect((error as CartNotResumableError).code).toBe("AMC_CART_NOT_OPEN");
  });

  it("library mode without a journal surfaces AMC_CART_INTENT_UNAVAILABLE for an unknown token (not cart.intent)", async () => {
    const ctx = await sharedContext();
    const processNoJournal = ctx.buildProcess({ withJournal: false });

    const error = await processNoJournal.service
      .previewCheckout({ orderToken: ORDER_TOKEN, email: "guest@example.test" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CartIntentUnavailableError);
  });
});

interface SharedContext {
  store: FileSessionStore;
  buildProcess(options?: {
    withPayment?: boolean;
    withJournal?: boolean;
  }): BuiltProcess;
}

interface BuiltProcess {
  service: ReturnType<typeof buildAmcCheckoutService>["service"];
  cartCreateCount(): number;
}

async function sharedContext(): Promise<SharedContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-intent-recovery-"));
  roots.push(root);
  const store = new FileSessionStore({
    root: path.join(root, "s"),
    lockPollMs: 5,
  });
  await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));

  const buildProcess = (
    options: { withPayment?: boolean; withJournal?: boolean } = {},
  ): BuiltProcess => {
    const transport = new OperationTransport(options.withPayment ?? false);
    const runtime = new AmcRuntime({
      transport,
      store,
      readMode: "graphql",
      listingUrl: LISTING_URL,
    });
    const journal =
      options.withJournal === false
        ? undefined
        : new FileCheckoutJournal(store);
    const built = buildAmcCheckoutService({
      transport,
      store,
      runtime,
      ...(journal ? { capabilities: { recovery: journal } } : {}),
      ...(options.withPayment
        ? {
            capabilities: {
              ...(journal ? { recovery: journal } : {}),
              cardProvider: new FakeCardProvider(),
              deviceData: new FakeDeviceData(),
              riskHttp: new FakeRiskHttp(),
              braintreeHttp: new FakeBraintreeHttp(),
            },
          }
        : {}),
    });
    return {
      service: built.service,
      cartCreateCount: () => transport.cartCreates,
    };
  };

  return { store, buildProcess };
}

class OperationTransport implements Transport {
  readonly name = "op";
  readonly sent: RequestInput[] = [];
  cartCreates = 0;
  private fulfilled = false;
  constructor(private readonly withPayment: boolean) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const op = operationOf(input);
    if (op === "AmcAuthCanary") {
      return graphJson({ data: { viewer: { user: { __typename: "User" } } } });
    }
    if (op === "CartCreateOrder") {
      this.cartCreates += 1;
      return graphJson({
        data: { orderCreate: { order: { token: ORDER_TOKEN } } },
      });
    }
    if (op === "OrderProjection") {
      // Once fulfilled, the same token projects a confirmed purchase so the
      // post-fulfill projection/reconcile succeeds; before that it is an open
      // pending cart.
      return graphJson(
        this.fulfilled ? confirmedOrderProjection() : pendingOrderProjection(),
      );
    }
    if (op === "BraintreeAuthorization" && this.withPayment) {
      return graphJson({
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
    }
    if (op === "OrderFulfill" && this.withPayment) {
      this.fulfilled = true;
      return graphJson({
        data: { orderFulfill: { order: { token: ORDER_TOKEN } } },
      });
    }
    throw new Error(`unexpected operation: ${op ?? "?"}`);
  }
}

function operationOf(input: RequestInput): string | null {
  if (!input.body) return null;
  try {
    return (
      (JSON.parse(input.body) as { operationName?: string }).operationName ??
      null
    );
  } catch {
    return null;
  }
}

function pendingOrderProjection() {
  return {
    data: {
      viewer: {
        order: {
          token: ORDER_TOKEN,
          orderId: null,
          status: "Pending",
          email: null,
          paid: 0,
          total: 12.44,
          feesTotal: 1.45,
          refundableTotal: 10.99,
          refundableType: "WHOLE",
          remainingBalance: 12.44,
          expirationDateUtc: "2099-08-15T22:04:35.163Z",
          isRefunded: false,
          groups: [
            {
              confirmationCode: null,
              reservedSeats: "A10",
              feesTotal: 1.45,
              subtotal: 12.44,
              tax: 0,
              total: 12.44,
              type: "TICKET-RS",
              showtime: { showtimeId: Number(SHOWTIME) },
              items: [
                {
                  sku: "TICKET-RS-146600823-ADULT",
                  name: "Adult",
                  quantity: 1,
                  cost: 10.99,
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

function confirmedOrderProjection() {
  return {
    data: {
      viewer: {
        order: {
          token: ORDER_TOKEN,
          orderId: "0000000001",
          status: "Fulfilled",
          email: "guest@example.test",
          paid: 12.44,
          total: 12.44,
          feesTotal: 1.45,
          refundableTotal: 10.99,
          refundableType: "WHOLE",
          remainingBalance: 0,
          expirationDateUtc: "2099-08-15T22:04:35.163Z",
          isRefunded: false,
          groups: [
            {
              confirmationCode: "0000000001",
              reservedSeats: "A10",
              feesTotal: 1.45,
              subtotal: 12.44,
              tax: 0,
              total: 12.44,
              type: "TICKET-RS",
              showtime: { showtimeId: Number(SHOWTIME) },
              items: [
                {
                  sku: "TICKET-RS-146600823-ADULT",
                  name: "Adult",
                  quantity: 1,
                  cost: 10.99,
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

function session(): AmcSession {
  return {
    version: 1,
    origin: "https://www.amctheatres.com",
    profile: "chrome147-mac",
    exportedAt: "2030-01-15T07:00:00.000Z",
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
  };
}

function intent(): CartCreateIntent {
  return {
    showtimeId: SHOWTIME,
    seats: [
      {
        name: "A10",
        sku: "TICKET-RS-146600823-ADULT",
        quantity: 1,
        row: 1,
        column: 10,
      },
    ],
    waiveSubscriptionDiscounts: false,
    expectedTotal: "12.44",
    holdAcknowledgement: "CREATE_HOLD",
  };
}

function graphJson(value: unknown): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: JSON.stringify(value),
    timingMs: 1,
    transport: "op",
    setCookieNames: [],
    setCookies: [],
  };
}

function sha256(value: string): string {
  // Mirror the journal's order-alias account hashing.
  return createHash("sha256").update(value).digest("hex");
}

class FakeCardProvider {
  getCard() {
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
class FakeDeviceData {
  collect() {
    return Promise.resolve({
      deviceData: '{"correlation_id":"fresh"}',
      fresh: true,
    });
  }
}
class FakeRiskHttp {
  request(input: { url: string }) {
    if (input.url.startsWith("https://c.paypal.com/")) {
      return Promise.resolve({ status: 200, bodyText: "<!doctype html>" });
    }
    if (input.url.includes("/cs/config?")) {
      return Promise.resolve({
        status: 200,
        bodyText: '{"collection":{"collect":true,"feature_flags":{}}}',
      });
    }
    if (input.url.includes("/session/")) {
      return Promise.resolve({ status: 201, bodyText: "" });
    }
    if (input.url.endsWith("/cs/storecookie")) {
      return Promise.resolve({ status: 200, bodyText: "" });
    }
    return Promise.reject(new Error("unexpected risk request"));
  }
}
class FakeBraintreeHttp {
  post() {
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
