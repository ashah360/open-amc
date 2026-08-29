import { describe, expect, it } from "vitest";
import {
  CheckoutReadinessError,
  DirectCheckoutReadiness,
  PreparedBraintreeClientTokenProvider,
  PreparedSecretCardProvider,
} from "../src/commerce/checkout-readiness";

function validCardLease(disposed: { value: boolean }) {
  return {
    card: {
      number: "4111111111111111",
      expirationMonth: "12",
      expirationYear: "2030",
      cvv: "123",
      postalCode: "94103",
    },
    dispose: () => {
      disposed.value = true;
    },
  };
}

function preparedTokens() {
  return new PreparedBraintreeClientTokenProvider({
    getClientToken: async () => "client-token",
  });
}

describe("AMC checkout readiness", () => {
  it("repairs Kount before preparing one exact card lease for later tokenization", async () => {
    let cookie: string | null = null;
    let repairs = 0;
    const disposed = { value: false };
    const cards = new PreparedSecretCardProvider({
      getCard: async () => validCardLease(disposed),
    });
    const readiness = new DirectCheckoutReadiness({
      receiptIdentity: { getEmail: async () => "guest@example.test" },
      defaultVaultPointer: "test-card",
      cards,
      clientTokens: preparedTokens(),
      deviceData: {
        collect: async () => ({
          deviceData: '{"correlation_id":"0123456789abcdef0123456789abcdef"}',
          fresh: true as const,
        }),
      },
      kountCookie: { getCookie: async () => cookie },
      repairKountCookie: async () => {
        repairs += 1;
        cookie = "browser-issued-kount-state";
      },
    });

    await expect(readiness.assertReady()).resolves.toBeUndefined();
    expect(repairs).toBe(1);
    expect(disposed.value).toBe(false);
    const lease = await cards.getCard("test-card");
    lease.dispose();
    expect(disposed.value).toBe(true);
  });

  it("fails before loading a card when browser refresh cannot restore Kount state", async () => {
    let providerCalls = 0;
    const cards = new PreparedSecretCardProvider({
      getCard: async () => {
        providerCalls += 1;
        return validCardLease({ value: false });
      },
    });
    const readiness = new DirectCheckoutReadiness({
      receiptIdentity: { getEmail: async () => "guest@example.test" },
      defaultVaultPointer: "test-card",
      cards,
      clientTokens: preparedTokens(),
      deviceData: {
        collect: async () => ({
          deviceData: '{"correlation_id":"0123456789abcdef0123456789abcdef"}',
          fresh: true as const,
        }),
      },
      kountCookie: { getCookie: async () => null },
      repairKountCookie: async () => undefined,
    });

    await expect(readiness.assertReady()).rejects.toBeInstanceOf(
      CheckoutReadinessError,
    );
    expect(providerCalls).toBe(0);
    await expect(cards.getCard("test-card")).rejects.toBeInstanceOf(
      CheckoutReadinessError,
    );
  });

  it("keeps concurrent prepared card and token material isolated by checkout binding", async () => {
    let cardLoads = 0;
    let tokenLoads = 0;
    const disposed: number[] = [];
    const cards = new PreparedSecretCardProvider({
      getCard: async () => {
        const id = ++cardLoads;
        const lease = validCardLease({ value: false });
        return { ...lease, dispose: () => disposed.push(id) };
      },
    });
    const tokens = new PreparedBraintreeClientTokenProvider({
      getClientToken: async () => `client-token-${++tokenLoads}`,
    });

    await Promise.all([
      cards.prepare("intent-a", "test-card"),
      cards.prepare("intent-b", "test-card"),
      tokens.prepare("intent-a"),
      tokens.prepare("intent-b"),
    ]);
    cards.bind("intent-a", "order-a");
    cards.bind("intent-b", "order-b");
    tokens.bind("intent-a", "order-a");
    tokens.bind("intent-b", "order-b");

    expect(await tokens.getClientToken("order-b")).toBe("client-token-2");
    expect(await tokens.getClientToken("order-a")).toBe("client-token-1");
    const second = await cards.getCard("test-card", "order-b");
    const first = await cards.getCard("test-card", "order-a");
    second.dispose();
    first.dispose();
    expect(cardLoads).toBe(2);
    expect(tokenLoads).toBe(2);
    expect(disposed.sort()).toEqual([1, 2]);
  });

  it("fails closed without provider reload when a recovered order lost ephemeral readiness", async () => {
    let cardLoads = 0;
    let tokenLoads = 0;
    const cards = new PreparedSecretCardProvider({
      getCard: async () => {
        cardLoads += 1;
        return validCardLease({ value: false });
      },
    });
    const tokens = new PreparedBraintreeClientTokenProvider({
      getClientToken: async () => {
        tokenLoads += 1;
        return "client-token";
      },
    });
    const readiness = new DirectCheckoutReadiness({
      receiptIdentity: { getEmail: async () => "guest@example.test" },
      defaultVaultPointer: "test-card",
      cards,
      clientTokens: tokens,
      deviceData: {
        collect: async () => ({
          deviceData: '{"correlation_id":"0123456789abcdef0123456789abcdef"}',
          fresh: true as const,
        }),
      },
      kountCookie: { getCookie: async () => "kount-cookie" },
    });

    expect(() =>
      readiness.assertPrepared("recovered-order", "test-card"),
    ).toThrow(CheckoutReadinessError);
    expect(cardLoads).toBe(0);
    expect(tokenLoads).toBe(0);
  });

  it("releases both prepared resources for a failed binding", async () => {
    const disposed = { value: false };
    const cards = new PreparedSecretCardProvider({
      getCard: async () => validCardLease(disposed),
    });
    const tokens = preparedTokens();
    await cards.prepare("failed-intent", "test-card");
    await tokens.prepare("failed-intent");

    cards.release("failed-intent");
    tokens.release("failed-intent");

    expect(disposed.value).toBe(true);
    expect(cards.isPreparedFor("test-card", "failed-intent")).toBe(false);
    expect(tokens.isPrepared("failed-intent")).toBe(false);
  });

  it("binds the prepared lease to the exact configured pointer", async () => {
    let providerCalls = 0;
    const cards = new PreparedSecretCardProvider({
      getCard: async () => {
        providerCalls += 1;
        return validCardLease({ value: false });
      },
    });
    await cards.prepare("test-card");

    await expect(cards.getCard("different-card")).rejects.toBeInstanceOf(
      CheckoutReadinessError,
    );
    expect(providerCalls).toBe(1);
  });
});
