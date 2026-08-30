import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import {
  AMC_SESSION_KEY,
  AmcRuntime,
  AmcSessionRepairRequiredError,
} from "../src/client/runtime";
import { AmcSession, encodeAmcSession } from "../src/client/session";
import { buildAmcCheckoutService } from "../src/commerce/wiring";
import {
  AmcCommerceProjectionProvider,
  AmcGraphqlCommerceExecutor,
  ScopedAmcGraphqlClient,
} from "../src/commerce/graphql-executor";
import {
  AmbiguousWriteError,
  CartCreateIntent,
  CartSnapshot,
  OrderLifecycle,
  PurchaseResult,
  RefundOrderSnapshot,
  WriteChallengedError,
  WriteRateLimitedError,
} from "../src/commerce/executor";

const CENTURY_CITY =
  "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes";
const ORDER_TOKEN = "00000000-0000-4000-8000-000000000042";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

describe("write recovery on a complete anti-bot challenge", () => {
  it("clears a first challenge via bounded DIRECT re-admission then redispatches the SAME write once (2 mutations, onToken once, no browser)", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      cartChallenge(),
      ...directAdmissionOk(),
      canaryOk(),
      cartCreateOk(ORDER_TOKEN),
    ]);

    // Executor seam so onToken is observable: the recovery lives entirely
    // inside graph.write, so the single createCart call fires onToken once.
    const tokens: string[] = [];
    const cart = await harness.executor.createCart(intent(), (token) => {
      tokens.push(token);
      return Promise.resolve();
    });
    expect(cart.orderToken).toBe(ORDER_TOKEN);
    expect(cartMutations(harness)).toBe(2);
    expect(tokens).toEqual([ORDER_TOKEN]);
    expect(harness.projection.reconcileCalls).toBe(0);
    // Never launched a browser: no browser refresher was ever configured and
    // admission stayed on the direct Queue-it GET path.
  });

  it("returns typed AMC_SESSION_REPAIR_REQUIRED with zero second mutation when direct re-admission needs a browser", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      cartChallenge(),
      // Direct admission GET of the listing URL is itself challenged -> browser.
      html(403, "<title>Just a moment... cloudflare</title>"),
    ]);

    const error = await harness.service
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmcSessionRepairRequiredError);
    expect(error).not.toBeInstanceOf(AmbiguousWriteError);
    expect(cartMutations(harness)).toBe(1);
  });

  it("surfaces a persistent challenge as typed AMC_WRITE_CHALLENGED (definite, not unknown) after exactly two mutations", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      cartChallenge(),
      ...directAdmissionOk(),
      canaryOk(),
      cartChallenge(),
    ]);

    const error = await harness.service
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteChallengedError);
    expect((error as WriteChallengedError).code).toBe("AMC_WRITE_CHALLENGED");
    expect(error).not.toBeInstanceOf(AmbiguousWriteError);
    expect(cartMutations(harness)).toBe(2);
  });

  it("uses the refreshed session cookies on the redispatched mutation", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      cartChallenge(),
      ...directAdmissionOk(),
      canaryOk(),
      cartCreateOk(ORDER_TOKEN),
    ]);

    await harness.service.createCart(intent());
    const mutations = harness.transport.sent.filter(isCartMutation);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.headers.cookie ?? "").not.toContain("QueueITAccepted");
    expect(mutations[1]?.headers.cookie ?? "").toContain("QueueITAccepted");
  });

  it("does NOT make a third dispatch when a 429 retry is itself challenged (budget of two)", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      rateLimited(),
      cartChallenge(),
    ]);

    const error = await harness.service
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WriteChallengedError);
    expect(cartMutations(harness)).toBe(2);
  });

  it("keeps a 429-then-success flow at exactly two mutations", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      rateLimited(),
      cartCreateOk(ORDER_TOKEN),
    ]);

    const cart = await harness.service.createCart(intent());
    expect(cart.orderToken).toBe(ORDER_TOKEN);
    expect(cartMutations(harness)).toBe(2);
  });

  it("preserves a complete non-challenge 400 as typed AMC_HTTP (definite, not unknown) with one mutation", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      html(400, "<html>bad request</html>"),
    ]);

    const error = await harness.executor
      .createCart(intent())
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("AMC_HTTP");
    expect(error).not.toBeInstanceOf(AmbiguousWriteError);
    expect(cartMutations(harness)).toBe(1);
  });

  it("keeps a complete 5xx AMBIGUOUS (origin may have mutated): one mutation, no retry, reconcile-only", async () => {
    // Executor seam: a complete 500 is ambiguous, not a definite AMC_HTTP.
    const executorHarness = await harnessFor([
      preflightCanaryOk(),
      html(500, "<html>upstream error</html>"),
    ]);
    const rawError = await executorHarness.executor
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(rawError).toBeInstanceOf(AmbiguousWriteError);
    expect((rawError as AmbiguousWriteError).code).toBe(
      "AMC_WRITE_OUTCOME_UNKNOWN",
    );
    expect(cartMutations(executorHarness)).toBe(1);

    // Service seam: the ambiguity is reconciled exactly once, never retried.
    const serviceHarness = await harnessFor([
      preflightCanaryOk(),
      html(500, "<html>upstream error</html>"),
    ]);
    const error = await serviceHarness.service
      .createCart(intent())
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("AMC_WRITE_OUTCOME_UNKNOWN");
    expect(cartMutations(serviceHarness)).toBe(1);
    expect(serviceHarness.projection.reconcileCalls).toBe(1);
  });

  it("keeps a transport throw (no complete response) ambiguous with one mutation and no retry", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      () => {
        const error = new Error("write EPROTO 0A000410:SSL routines");
        (error as { code?: string }).code = "EPROTO";
        throw error;
      },
    ]);

    // At the executor seam the raw ambiguity is preserved as AmbiguousWriteError
    // (the service later wraps it into the reconcile-only unknown-outcome error,
    // still AMC_WRITE_OUTCOME_UNKNOWN); either way, exactly one mutation, no
    // retry.
    const error = await harness.executor
      .createCart(intent())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmbiguousWriteError);
    expect((error as AmbiguousWriteError).code).toBe(
      "AMC_WRITE_OUTCOME_UNKNOWN",
    );
    expect(cartMutations(harness)).toBe(1);
  });

  it("wraps a transport throw as the reconcile-only unknown outcome at the service seam (one mutation, reconcile once)", async () => {
    const harness = await harnessFor([
      preflightCanaryOk(),
      () => {
        const error = new Error("write EPROTO 0A000410:SSL routines");
        (error as { code?: string }).code = "EPROTO";
        throw error;
      },
    ]);

    const error = await harness.service
      .createCart(intent())
      .catch((e: unknown) => e);
    expect((error as { code?: string }).code).toBe("AMC_WRITE_OUTCOME_UNKNOWN");
    expect(cartMutations(harness)).toBe(1);
    expect(harness.projection.reconcileCalls).toBe(1);
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

async function harnessFor(script: Scripted[]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-write-challenge-"));
  roots.push(root);
  const store = new FileSessionStore({
    root: path.join(root, "s"),
    lockPollMs: 5,
  });
  await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
  const transport = new ScriptedTransport(script);
  const runtime = new AmcRuntime({
    transport,
    store,
    readMode: "graphql",
    listingUrl: CENTURY_CITY,
  });
  const projection = new CountingProjectionProvider();
  const { service } = buildAmcCheckoutService({
    transport,
    store,
    runtime,
    projections: projection,
  });
  const executor = new AmcGraphqlCommerceExecutor(
    new ScopedAmcGraphqlClient(transport, runtime),
    projection,
  );
  return { service, executor, transport, projection };
}

function isCartMutation(request: RequestInput): boolean {
  return (
    request.method === "POST" &&
    request.url.includes("graph.") &&
    (request.body ?? "").includes("CartCreateOrder")
  );
}

function cartMutations(harness: { transport: ScriptedTransport }): number {
  return harness.transport.sent.filter(isCartMutation).length;
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
  async projectLifecycle(): Promise<OrderLifecycle> {
    return { kind: "open", cart: await this.inspectCart() };
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
    ],
  };
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

/** A successful AccessCheck canary response (write preflight + post-admission). */
function canaryOk(): ResponseOutput {
  return graphJson({ data: { viewer: { user: { __typename: "User" } } } });
}
const preflightCanaryOk = canaryOk;

function cartCreateOk(orderToken: string): ResponseOutput {
  return graphJson({ data: { orderCreate: { order: { token: orderToken } } } });
}

function cartChallenge(): ResponseOutput {
  return html(
    403,
    "<title>Just a moment... challenge-platform Cloudflare</title>",
  );
}

function rateLimited(): ResponseOutput {
  return html(429, "<html><body>rate limited</body></html>");
}

/** The three-hop direct Queue-it admission GET sequence that succeeds. */
function directAdmissionOk(): ResponseOutput[] {
  return [
    redirect(
      "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
    ),
    redirect(`${CENTURY_CITY}?queueittoken=opaque-return`),
    redirect(CENTURY_CITY, [
      "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
    ]),
  ];
}

function html(status: number, body: string): ResponseOutput {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText: body,
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}

function redirect(location: string, setCookies: string[] = []): ResponseOutput {
  return {
    status: 302,
    headers: { location },
    bodyText: "",
    timingMs: 1,
    transport: "scripted",
    setCookieNames: setCookies.map((l) => l.slice(0, l.indexOf("="))),
    setCookies,
  };
}

function graphJson(value: unknown): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: JSON.stringify(value),
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}
