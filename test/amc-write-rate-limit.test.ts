import { describe, expect, it } from "vitest";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { AmcRuntime, AmcSessionContext } from "../src/client/runtime";
import { AmcSession } from "../src/client/session";
import {
  AmcCommerceProjectionProvider,
  AmcGraphqlCommerceExecutor,
  ScopedAmcGraphqlClient,
} from "../src/commerce/graphql-executor";
import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  PurchaseResult,
  RefundOrderSnapshot,
  WriteRateLimitedError,
} from "../src/commerce/executor";

const ORDER_TOKEN = "00000000-0000-4000-8000-000000000042";

describe("explicit HTTP 429 on a provider write", () => {
  it("retries exactly once in the same session and succeeds", async () => {
    const harness = harnessFor([
      rateLimitedResponse(),
      cartCreateResponse(ORDER_TOKEN),
    ]);

    const tokens: string[] = [];
    const cart = await harness.executor.createCart(intent(), async (token) => {
      tokens.push(token);
    });
    expect(cart.orderToken).toBe(ORDER_TOKEN);
    expect(harness.transport.sent).toHaveLength(2);
    // Same session on both dispatches: identical scoped cookie header.
    expect(harness.transport.sent[1]?.headers.cookie).toBe(
      harness.transport.sent[0]?.headers.cookie,
    );
    expect(tokens).toEqual([ORDER_TOKEN]);
    expect(harness.projection.reconcileCalls).toBe(0);
  });

  it("surfaces a persistent 429 as a typed rate-limit failure, never AMC_WRITE_OUTCOME_UNKNOWN, after exactly two dispatches", async () => {
    const harness = harnessFor([rateLimitedResponse(), rateLimitedResponse()]);

    const error = await harness.executor
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteRateLimitedError);
    expect((error as WriteRateLimitedError).code).toBe(
      "AMC_WRITE_RATE_LIMITED",
    );
    expect(error).not.toBeInstanceOf(AmbiguousWriteError);
    expect(harness.transport.sent).toHaveLength(2);
    expect(harness.projection.reconcileCalls).toBe(0);
  });

  it("keeps a transport throw (no complete HTTP response) ambiguous with zero retry", async () => {
    const harness = harnessFor([
      () => {
        const error = new Error("write EPROTO 0A000410:SSL routines");
        (error as { code?: string }).code = "EPROTO";
        throw error;
      },
    ]);

    const error = await harness.executor
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmbiguousWriteError);
    expect((error as AmbiguousWriteError).code).toBe(
      "AMC_WRITE_OUTCOME_UNKNOWN",
    );
    expect(harness.transport.sent).toHaveLength(1);
  });

  it("applies the same 429 discipline to release writes", async () => {
    const harness = harnessFor([
      rateLimitedResponse(),
      jsonResponse({ data: { orderDelete: { success: true } } }),
    ]);

    await expect(
      harness.executor.deleteCart(ORDER_TOKEN),
    ).resolves.toBeUndefined();
    expect(harness.transport.sent).toHaveLength(2);
  });
});

type Scripted = ResponseOutput | (() => never);

class ScriptedTransport implements Transport {
  readonly name = "scripted";
  readonly sent: RequestInput[] = [];
  constructor(private readonly script: Scripted[]) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const next = this.script.shift();
    if (!next) throw new Error("unexpected AMC request");
    if (typeof next === "function") next();
    return next as ResponseOutput;
  }
}

function harnessFor(script: Scripted[]) {
  const transport = new ScriptedTransport(script);
  const session: AmcSession = {
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
  };
  const context: AmcSessionContext = {
    session,
    persistSetCookies: async () => undefined,
  };
  const runtime = {
    withAuthenticatedWrite: <T>(
      operation: (ctx: AmcSessionContext) => Promise<T>,
    ) => operation(context),
    withAuthenticatedRead: <T>(
      operation: (ctx: AmcSessionContext) => Promise<T>,
    ) => operation(context),
  } as unknown as AmcRuntime;
  const projection = new CountingProjectionProvider();
  const executor = new AmcGraphqlCommerceExecutor(
    new ScopedAmcGraphqlClient(transport, runtime),
    projection,
  );
  return { transport, projection, executor };
}

class CountingProjectionProvider implements AmcCommerceProjectionProvider {
  reconcileCalls = 0;
  assertReady(): void {}
  inspectCart(): Promise<CartSnapshot> {
    return Promise.resolve({
      orderToken: ORDER_TOKEN,
      showtimeId: "900000006",
      seats: [
        { name: "E9", sku: "TICKET-RS-900000006-ADULT", row: 3, column: 14 },
      ],
      tickets: [{ sku: "TICKET-RS-900000006-ADULT", quantity: 1 }],
      total: "31.98",
      expiresAt: "2099-08-15T09:45:00.000Z",
      status: "OPEN",
    });
  }
  reconcileCart(_intent: CartCreateIntent): Promise<CartSnapshot | null> {
    this.reconcileCalls += 1;
    return Promise.resolve(null);
  }
  projectRefundOrder(): Promise<RefundOrderSnapshot> {
    return Promise.reject(new Error("not needed"));
  }
  projectPurchase(): Promise<PurchaseResult> {
    return Promise.reject(new Error("not needed"));
  }
  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.resolve(null);
  }
  projectExpiration(): Promise<{ expiresAt: string }> {
    return Promise.resolve({ expiresAt: "2099-08-15T09:45:00.000Z" });
  }
  projectStatus(): Promise<"OPEN" | "FULFILLED" | "EXPIRED"> {
    return Promise.resolve("EXPIRED");
  }
}

function intent(): CartCreateIntent {
  return {
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
  };
}

function rateLimitedResponse(): ResponseOutput {
  return {
    status: 429,
    headers: { "content-type": "text/html" },
    bodyText: "<html><body>rate limited</body></html>",
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}

function cartCreateResponse(orderToken: string): ResponseOutput {
  return jsonResponse({
    data: { orderCreate: { order: { token: orderToken } } },
  });
}

function jsonResponse(body: unknown): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    bodyText: JSON.stringify(body),
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}
