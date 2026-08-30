import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore, SessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import {
  AMC_SESSION_KEY,
  AmcRuntime,
  WriteChallengeCooldownError,
  clearAmcSession,
} from "../src/client/runtime";
import { AmcSession, encodeAmcSession } from "../src/client/session";
import {
  buildAmcCheckoutService,
  createFileCheckoutRecovery,
} from "../src/commerce/wiring";
import { PendingWriteStore } from "../src/commerce/pending-write-store";
import { selectionHash } from "../src/commerce/intent-identity";
import {
  AmcCommerceProjectionProvider,
  AmcGraphqlCommerceExecutor,
  ScopedAmcGraphqlClient,
} from "../src/commerce/graphql-executor";
import {
  CartCreateIntent,
  CartSnapshot,
  OrderLifecycle,
  PurchaseResult,
  RefundOrderSnapshot,
} from "../src/commerce/executor";

const CENTURY_CITY =
  "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes";
const ORDER_TOKEN = "00000000-0000-4000-8000-000000000042";
const COOLDOWN_KEY = { provider: "amc", account: "write-cooldown" } as const;
const COOLDOWN_MS = 30 * 60_000;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
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

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-write-cooldown-"));
  roots.push(root);
  const store = new FileSessionStore({
    root: path.join(root, "s"),
    lockPollMs: 5,
  });
  await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
  return store;
}

interface Clock {
  t: Date;
}

function runtimeOn(
  store: SessionStore,
  script: Scripted[],
  clock: Clock,
  options: {
    sessionRefresher?: { refresh: () => Promise<AmcSession> };
    cooldownMs?: number;
  } = {},
) {
  const transport = new ScriptedTransport(script);
  const runtime = new AmcRuntime({
    transport,
    store,
    readMode: "graphql",
    listingUrl: CENTURY_CITY,
    now: () => clock.t,
    writeChallengeCooldownMs: options.cooldownMs ?? COOLDOWN_MS,
    ...(options.sessionRefresher
      ? { sessionRefresher: options.sessionRefresher }
      : {}),
  });
  const projection = new CountingProjectionProvider();
  const { service } = buildAmcCheckoutService({
    transport,
    store,
    runtime,
    projections: projection,
    now: () => clock.t,
    // Durable file-backed recovery so cart markers are cross-process real.
    capabilities: { recovery: createFileCheckoutRecovery(store) },
  });
  const executor = new AmcGraphqlCommerceExecutor(
    new ScopedAmcGraphqlClient(transport, runtime),
    projection,
  );
  return { runtime, transport, service, executor, projection };
}

function isCartMutation(request: RequestInput): boolean {
  return (
    request.method === "POST" &&
    request.url.includes("graph.") &&
    (request.body ?? "").includes("CartCreateOrder")
  );
}
function cartMutations(t: ScriptedTransport): number {
  return t.sent.filter(isCartMutation).length;
}

describe("write-challenge cooldown circuit breaker", () => {
  it("Proof 1: a first Cloudflare CAPTCHA trips the cooldown in one dispatch, no direct refresh", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    const h = runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock);

    const error = await h.executor.createCart(intent()).catch((e) => e);
    expect(error).toBeInstanceOf(WriteChallengeCooldownError);
    expect((error as WriteChallengeCooldownError).code).toBe(
      "AMC_WRITE_CHALLENGE_COOLDOWN",
    );
    expect((error as WriteChallengeCooldownError).retryAt).toBe(
      "2030-01-15T08:30:00.000Z",
    );
    expect(cartMutations(h.transport)).toBe(1);
    // No bounded direct re-admission was attempted (no Queue-it GET).
    expect(h.transport.sent.some((r) => r.url.includes("queue."))).toBe(false);
    // Cooldown persisted.
    const bytes = await store.load(COOLDOWN_KEY);
    expect(bytes).not.toBeNull();
  });

  it("Proof 2: a NEW runtime sharing the same store fails with zero transport during cooldown", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    await runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock)
      .executor.createCart(intent())
      .catch(() => undefined);

    // A genuinely separate runtime + transport, same on-disk store.
    const second = runtimeOn(store, [], clock);
    const error = await second.executor.createCart(intent()).catch((e) => e);
    expect(error).toBeInstanceOf(WriteChallengeCooldownError);
    expect(second.transport.sent).toHaveLength(0);
    expect(cartMutations(second.transport)).toBe(0);
  });

  it("Proof 3: reads still dispatch and succeed during cooldown", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    await runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock)
      .executor.createCart(intent())
      .catch(() => undefined);

    const reader = runtimeOn(store, [canaryOk()], clock);
    const value = await reader.runtime.withAuthenticatedRead(() =>
      Promise.resolve("read-ok"),
    );
    expect(value).toBe("read-ok");
    expect(reader.transport.sent.length).toBeGreaterThan(0);
  });

  it("Proof 4: blocked at 29:59, one probe allowed at 30:00, and a renewed CAPTCHA re-arms after one dispatch", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    await runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock)
      .executor.createCart(intent())
      .catch(() => undefined);

    // 29:59 -> still blocked, zero transport.
    clock.t = new Date("2030-01-15T08:29:59.000Z");
    const blocked = runtimeOn(store, [], clock);
    await expect(blocked.executor.createCart(intent())).rejects.toBeInstanceOf(
      WriteChallengeCooldownError,
    );
    expect(blocked.transport.sent).toHaveLength(0);

    // 30:00 -> exactly one probe write; a renewed CAPTCHA re-arms cooldown.
    clock.t = new Date("2030-01-15T08:30:00.000Z");
    const probe = runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock);
    const error = await probe.executor.createCart(intent()).catch((e) => e);
    expect(error).toBeInstanceOf(WriteChallengeCooldownError);
    expect((error as WriteChallengeCooldownError).retryAt).toBe(
      "2030-01-15T09:00:00.000Z",
    );
    expect(cartMutations(probe.transport)).toBe(1);
  });

  it("Proof 5: a successful explicit repair clears the cooldown; a failed repair does not", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    await runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock)
      .executor.createCart(intent())
      .catch(() => undefined);

    // Failed explicit repair: injected refresher throws -> cooldown remains.
    const failing = runtimeOn(store, [], clock, {
      sessionRefresher: {
        refresh: () => Promise.reject(new Error("repair failed")),
      },
    });
    await expect(failing.runtime.repairSession()).rejects.toThrow(
      /repair failed/,
    );
    expect(await store.load(COOLDOWN_KEY)).not.toBeNull();

    // Successful explicit repair (fresh session + passing canary) clears it.
    const repaired = runtimeOn(
      store,
      [canaryOk(), canaryOk(), cartCreateOk()],
      clock,
      {
        sessionRefresher: { refresh: () => Promise.resolve(session()) },
      },
    );
    await repaired.runtime.repairSession();
    expect(await store.load(COOLDOWN_KEY)).toBeNull();

    const cart = await repaired.service.createCart(intent());
    expect(cart.orderToken).toBe(ORDER_TOKEN);
    expect(cartMutations(repaired.transport)).toBe(1);
  });

  it("Proof 6: auth clear removes the session AND the cooldown", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    await runtimeOn(store, [canaryOk(), cloudflareCaptcha403()], clock)
      .executor.createCart(intent())
      .catch(() => undefined);
    expect(await store.load(COOLDOWN_KEY)).not.toBeNull();

    await clearAmcSession(store);
    expect(await store.load(AMC_SESSION_KEY)).toBeNull();
    expect(await store.load(COOLDOWN_KEY)).toBeNull();
  });

  it("Proof 7: a service-level CAPTCHA clears the tokenless cart marker, so a fresh service dispatches after expiry instead of hitting stale ambiguity", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    // 5m cooldown < 30m CART_HOLD_TTL: a stale marker at the probe time would
    // still block with AMC_WRITE_OUTCOME_UNKNOWN, so this cannot pass vacuously.
    const first = runtimeOn(
      store,
      [canaryOk(), cloudflareCaptcha403()],
      clock,
      {
        cooldownMs: 5 * 60_000,
      },
    );
    const error = await first.service.createCart(intent()).catch((e) => e);
    expect(error).toBeInstanceOf(WriteChallengeCooldownError);
    // The definite rejection cleared the tokenless cart marker immediately.
    const selKey = selectionHash("900000006", ["E9"]);
    expect(await new PendingWriteStore(store).load("cart", selKey)).toBeNull();

    // At expiry a genuinely fresh service/runtime dispatches exactly one cart
    // mutation (blocked neither by the cooldown nor by marker ambiguity).
    clock.t = new Date("2030-01-15T08:05:00.000Z");
    const second = runtimeOn(store, [canaryOk(), cartCreateOk()], clock);
    const cart = await second.service.createCart(intent());
    expect(cart.orderToken).toBe(ORDER_TOKEN);
    expect(cartMutations(second.transport)).toBe(1);
  });

  it("fails closed (session-corrupt family) on a tampered cooldown record", async () => {
    const store = await newStore();
    const clock: Clock = { t: new Date("2030-01-15T08:00:00.000Z") };
    await store.save(COOLDOWN_KEY, Buffer.from("{not json", "utf8"));
    const h = runtimeOn(store, [], clock);
    const error = await h.executor.createCart(intent()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WriteChallengeCooldownError);
    expect(h.transport.sent).toHaveLength(0);
  });
});

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
  reconcileCart(): Promise<CartSnapshot | null> {
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

function canaryOk(): ResponseOutput {
  return graphJson({ data: { viewer: { user: { __typename: "User" } } } });
}
function cartCreateOk(): ResponseOutput {
  return graphJson({
    data: { orderCreate: { order: { token: ORDER_TOKEN } } },
  });
}

/** The exact SAFE shape observed live on an Empire CartCreateOrder 403. */
function cloudflareCaptcha403(): ResponseOutput {
  return {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      server: "cloudflare",
      "cf-ray": "8f0000000000abcd-LAX",
    },
    bodyText:
      "<html><head><title>Attention Required! | Cloudflare</title></head>" +
      "<body>Please complete the security check to access: captcha required. " +
      "Cloudflare Ray ID below. Performance &amp; security by Cloudflare.</body></html>",
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
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
