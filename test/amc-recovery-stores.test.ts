import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../src/auth-session";
import {
  CartIntentStore,
  RecoveryStoreCorruptError,
} from "../src/commerce/cart-intent-store";
import { PendingWriteStore } from "../src/commerce/pending-write-store";
import { intentHash, sha256 } from "../src/commerce/intent-identity";
import { CartCreateIntent } from "../src/commerce/executor";

const TOKEN = "00000000-0000-4000-8000-000000000042";

function intent(overrides: Partial<CartCreateIntent> = {}): CartCreateIntent {
  return {
    showtimeId: "146600823",
    seats: [
      {
        name: "A9",
        sku: "TICKET-RS-146600823-ADULT",
        quantity: 1,
        row: 1,
        column: 9,
      },
    ],
    waiveSubscriptionDiscounts: false,
    expectedTotal: "12.44",
    holdAcknowledgement: "CREATE_HOLD",
    ...overrides,
  };
}

describe("CartIntentStore", () => {
  it("records an immutable intent and loads it back by token", async () => {
    const store = new CartIntentStore(new MemorySessionStore());
    await store.record({
      orderToken: TOKEN,
      intent: intent(),
      createdAt: "2030-01-15T08:00:00.000Z",
    });
    const record = await store.loadByToken(TOKEN);
    expect(record).not.toBeNull();
    expect(record!.orderToken).toBe(TOKEN);
    expect(record!.intent.seats[0]?.name).toBe("A9");
    expect(record!.intentHash).toBe(intentHash(intent()));
    // No lifecycle/total/confirmation fields exist on the record.
    expect(Object.keys(record!).sort()).toEqual(
      ["createdAt", "intent", "intentHash", "orderToken", "version"].sort(),
    );
  });

  it("returns null for an unknown token", async () => {
    const store = new CartIntentStore(new MemorySessionStore());
    expect(await store.loadByToken(TOKEN)).toBeNull();
  });

  it("resolves the newest token recorded for a physical seat selection", async () => {
    const store = new CartIntentStore(new MemorySessionStore());
    await store.record({
      orderToken: "tok-old",
      intent: intent(),
      createdAt: "2030-01-15T08:00:00.000Z",
    });
    await store.record({
      orderToken: "tok-new",
      intent: intent(),
      createdAt: "2030-01-15T08:05:00.000Z",
    });
    expect(await store.newestTokenForSelection("146600823", ["a9"])).toBe(
      "tok-new",
    );
  });

  it("fails closed when the stored token record is tampered", async () => {
    const backing = new MemorySessionStore();
    const store = new CartIntentStore(backing);
    await store.record({
      orderToken: TOKEN,
      intent: intent(),
      createdAt: "2030-01-15T08:00:00.000Z",
    });
    // Rewrite the record with a different token than its key hashes.
    await backing.save(
      { provider: "amc-cart-intent", account: sha256(TOKEN) },
      Buffer.from(
        JSON.stringify({
          version: 2,
          orderToken: "different-token",
          intent: intent(),
          intentHash: intentHash(intent()),
          createdAt: "2030-01-15T08:00:00.000Z",
        }),
        "utf8",
      ),
    );
    await expect(store.loadByToken(TOKEN)).rejects.toBeInstanceOf(
      RecoveryStoreCorruptError,
    );
  });

  it("fails closed when the intent hash does not match the stored intent", async () => {
    const backing = new MemorySessionStore();
    const store = new CartIntentStore(backing);
    await backing.save(
      { provider: "amc-cart-intent", account: sha256(TOKEN) },
      Buffer.from(
        JSON.stringify({
          version: 2,
          orderToken: TOKEN,
          intent: intent(),
          intentHash: "f".repeat(64),
          createdAt: "2030-01-15T08:00:00.000Z",
        }),
        "utf8",
      ),
    );
    await expect(store.loadByToken(TOKEN)).rejects.toBeInstanceOf(
      RecoveryStoreCorruptError,
    );
  });
});

describe("PendingWriteStore", () => {
  it("marks, loads, and clears a single outstanding write per operation+key", async () => {
    const store = new PendingWriteStore(new MemorySessionStore());
    expect(await store.load("purchase", TOKEN)).toBeNull();
    await store.mark({
      operation: "purchase",
      key: TOKEN,
      intentHash: intentHash(intent()),
      dispatchedAt: "2030-01-15T08:00:00.000Z",
    });
    const marker = await store.load("purchase", TOKEN);
    expect(marker).toMatchObject({
      operation: "purchase",
      key: TOKEN,
      dispatchedAt: "2030-01-15T08:00:00.000Z",
    });
    await store.clear("purchase", TOKEN);
    expect(await store.load("purchase", TOKEN)).toBeNull();
  });

  it("keeps at most one marker per operation+key (a re-mark overwrites dispatchedAt)", async () => {
    const store = new PendingWriteStore(new MemorySessionStore());
    await store.mark({
      operation: "cart",
      key: "sel-hash",
      intentHash: intentHash(intent()),
      dispatchedAt: "2030-01-15T08:00:00.000Z",
    });
    await store.mark({
      operation: "cart",
      key: "sel-hash",
      intentHash: intentHash(intent()),
      dispatchedAt: "2030-01-15T08:10:00.000Z",
    });
    expect((await store.load("cart", "sel-hash"))!.dispatchedAt).toBe(
      "2030-01-15T08:10:00.000Z",
    );
  });

  it("keeps markers for different operations on the same key independent", async () => {
    const store = new PendingWriteStore(new MemorySessionStore());
    await store.mark({
      operation: "purchase",
      key: TOKEN,
      intentHash: intentHash(intent()),
      dispatchedAt: "2030-01-15T08:00:00.000Z",
    });
    await store.clear("release", TOKEN);
    expect(await store.load("purchase", TOKEN)).not.toBeNull();
  });

  it("fails closed on a tampered marker", async () => {
    const backing = new MemorySessionStore();
    const store = new PendingWriteStore(backing);
    await backing.save(
      { provider: "amc-pending-write", account: sha256("purchase:" + TOKEN) },
      Buffer.from(JSON.stringify({ version: 1, operation: "nope" }), "utf8"),
    );
    await expect(store.load("purchase", TOKEN)).rejects.toBeInstanceOf(
      RecoveryStoreCorruptError,
    );
  });
});
