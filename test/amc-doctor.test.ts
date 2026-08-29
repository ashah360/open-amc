import { afterEach, describe, expect, it, vi } from "vitest";
import { runAmcCli } from "../src/cli";
import type { AmcClient } from "../src/client";

function stubClient(
  status: "valid" | "stale" | "missing" | "challenged" = "valid",
  overrides: { failStatus?: boolean } = {},
): { client: AmcClient; writes: { count: number } } {
  const writes = { count: 0 };
  const client = {
    showtimes: { list: vi.fn(async () => []) },
    inventory: { get: vi.fn(), getBatch: vi.fn() },
    auth: {
      status: vi.fn(async () => {
        if (overrides.failStatus) throw new Error("transport unreachable");
        return {
          provider: "amc" as const,
          account: "personal" as const,
          status,
        };
      }),
      bootstrap: vi.fn(),
      clear: vi.fn(),
      repair: vi.fn(),
    },
    orders: {
      createCart: vi.fn(async () => {
        writes.count += 1;
        return {};
      }),
      get: vi.fn(),
      extendExpiration: vi.fn(),
      release: vi.fn(),
    },
    checkout: {
      preview: vi.fn(),
      submit: vi.fn(async () => {
        writes.count += 1;
        return {};
      }),
      reconcile: vi.fn(),
    },
    refunds: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    close: vi.fn(async () => undefined),
  } as unknown as AmcClient;
  return { client, writes };
}

function run(
  argv: string[],
  client: AmcClient,
  capabilities: Record<string, unknown> = {},
) {
  const output: string[] = [];
  return runAmcCli(["node", "amc", ...argv], {
    client,
    capabilities,
    writeOut: (line) => output.push(line),
    writeErr: (line) => output.push(line),
  }).then((code) => ({ code, output }));
}

const ENV_KEYS = [
  "AMC_SESSION_ROOT",
  "AMC_PROXY_URL",
  "AMC_HELLO_PROFILE_PATH",
  "AMC_CAPABILITY_MODULE",
];
const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("amc doctor --json", () => {
  it("reports configuration presence as booleans and never leaks values", async () => {
    process.env.AMC_SESSION_ROOT = "/secret-session-root-sentinel";
    process.env.AMC_PROXY_URL = "http://user:proxy-secret-sentinel@host:1";
    process.env.AMC_HELLO_PROFILE_PATH = "/secret-profile-sentinel.json";
    process.env.AMC_CAPABILITY_MODULE = "/secret-module-sentinel.cjs";
    const { client } = stubClient("valid");
    const { code, output } = await run(["doctor", "--json"], client, {
      cardProvider: { secretHint: "raw-card-secret-sentinel" },
      defaultVaultPointer: "vault://sentinel-pointer",
      defaultReceiptEmail: "sentinel-receipt@example.test",
    });
    expect(code).toBe(0);
    const raw = output[0]!;
    const doctor = JSON.parse(raw);
    expect(doctor.kind).toBe("doctor");
    expect(doctor.node.supported).toBe(true);
    expect(doctor.sessionStore.rootConfigured).toBe(true);
    expect(doctor.transport.proxyConfigured).toBe(true);
    expect(doctor.transport.profileConfigured).toBe(true);
    expect(doctor.capabilities.moduleConfigured).toBe(true);
    expect(doctor.capabilities.cardProvider).toBe(true);
    expect(doctor.capabilities.browserRepair).toBe(false);
    expect(doctor.capabilities.defaultVaultPointer).toBe(true);
    expect(doctor.capabilities.defaultReceiptEmail).toBe(true);
    // The CLI always wires a durable cart journal, so recovery is available
    // even with a capability module present.
    expect(doctor.capabilities.recovery).toBe(true);
    expect(typeof doctor.playwright.playwrightCoreInstalled).toBe("boolean");
    for (const secret of [
      "secret-session-root-sentinel",
      "proxy-secret-sentinel",
      "secret-profile-sentinel",
      "secret-module-sentinel",
      "raw-card-secret-sentinel",
      "sentinel-pointer",
      "sentinel-receipt",
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("recommends explicit auth repair when the session is stale, with zero writes", async () => {
    const { client, writes } = stubClient("stale");
    const { code, output } = await run(["doctor", "--json"], client);
    expect(code).toBe(0);
    const doctor = JSON.parse(output[0]!);
    expect(doctor.auth.status).toBe("stale");
    expect(doctor.recommendedAction.action).toBe("auth-repair");
    // Directly executable for the common installed-Chrome path.
    expect(doctor.recommendedAction.command).toBe(
      "amc auth repair --listing-url <official AMC theater URL> --browser-channel chrome --json",
    );
    expect(writes.count).toBe(0);
  });

  it("reports built-in cart recovery available even with no capability module", async () => {
    const { client } = stubClient("valid");
    const { code, output } = await run(["doctor", "--json"], client);
    expect(code).toBe(0);
    const doctor = JSON.parse(output[0]!);
    expect(doctor.capabilities.moduleConfigured).toBe(false);
    expect(doctor.capabilities.recovery).toBe(true);
  });

  it("reports none when the session is valid", async () => {
    const { client } = stubClient("valid");
    const { output } = await run(["doctor", "--json"], client);
    expect(JSON.parse(output[0]!).recommendedAction.action).toBe("none");
  });

  it("survives an unreachable auth canary and still reports", async () => {
    const { client } = stubClient("valid", { failStatus: true });
    const { code, output } = await run(["doctor", "--json"], client);
    expect(code).toBe(0);
    const doctor = JSON.parse(output[0]!);
    expect(doctor.auth.status).toBe("unreachable");
    expect(doctor.recommendedAction.action).toBe("auth-repair");
  });

  it("renders useful human output without --json", async () => {
    const { client } = stubClient("valid");
    const { code, output } = await run(["doctor"], client);
    expect(code).toBe(0);
    expect(output.join("\n")).toMatch(/node/i);
    expect(output.join("\n")).toMatch(/session/i);
  });
});
