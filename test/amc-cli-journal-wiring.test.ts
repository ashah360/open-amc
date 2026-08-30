import { describe, expect, it, vi } from "vitest";
import { runAmcCli, AmcCliCapabilities } from "../src/cli";
import type { AmcClient, AmcClientConfig } from "../src/client";
import { CartIntentStore } from "../src/commerce/cart-intent-store";
import { PendingWriteStore } from "../src/commerce/pending-write-store";
import type { CheckoutRecovery } from "../src/commerce/service";

function stubClient(): AmcClient {
  return {
    showtimes: { list: vi.fn(async () => []) },
    inventory: { get: vi.fn(), getBatch: vi.fn() },
    auth: {
      status: vi.fn(async () => ({
        provider: "amc" as const,
        account: "personal" as const,
        status: "valid" as const,
      })),
      bootstrap: vi.fn(),
      clear: vi.fn(),
      repair: vi.fn(),
    },
    orders: {
      createCart: vi.fn(),
      get: vi.fn(),
      extendExpiration: vi.fn(),
      release: vi.fn(),
    },
    checkout: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    refunds: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as AmcClient;
}

async function captureConfig(
  capabilities?: AmcCliCapabilities,
): Promise<AmcClientConfig> {
  let captured: AmcClientConfig | undefined;
  const createClient = (config: AmcClientConfig): AmcClient => {
    captured = config;
    return stubClient();
  };
  const code = await runAmcCli(["node", "amc", "auth", "status", "--json"], {
    createClient,
    ...(capabilities ? { capabilities } : {}),
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  expect(code).toBe(0);
  if (!captured) throw new Error("createClient was not invoked");
  return captured;
}

describe("CLI checkout recovery wiring", () => {
  it("wires a durable recovery bundle (intent store + uncertainty ledger) by default", async () => {
    const config = await captureConfig();
    expect(config.checkout?.recovery?.intents).toBeInstanceOf(CartIntentStore);
    expect(config.checkout?.recovery?.pending).toBeInstanceOf(
      PendingWriteStore,
    );
  });

  it("lets a capability-supplied recovery bundle override the built-in default", async () => {
    const supplied = {
      marker: "capability-recovery",
    } as unknown as CheckoutRecovery;
    const config = await captureConfig({ recovery: supplied });
    expect(config.checkout?.recovery).toBe(supplied);
  });
});
