import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAmcCli, AmcCliDependencies } from "../src/cli";
import type { AmcClient } from "../src/client";
import type { AmcSeatingLayout } from "../src/client/seat-layout";
import type { CartSnapshot } from "../src/commerce/executor";
import type { CheckoutPreview } from "../src/commerce/service";
import {
  CartCreationOutcomeUnknownError,
  CheckoutOutcomeUnknownError,
  RefundOutcomeUnknownError,
  ReleaseOutcomeUnknownError,
} from "../src/commerce/service";
import type { RefundPreview } from "../src/commerce/service";

function fullCheckoutPreview(): CheckoutPreview {
  return {
    kind: "checkout",
    orderToken: "tok",
    showtimeId: "900000004",
    seats: [{ name: "A2", sku: "TICKET-ADULT", row: 1, column: 1 }],
    tickets: [{ sku: "TICKET-ADULT", quantity: 1 }],
    total: "22.50",
    expiresAt: "2030-01-15T09:00:00.000Z",
    emailBinding: "binding",
    observedAt: "2030-01-15T08:00:00.000Z",
    confirmationToken: "ct",
  };
}

function fullRefundPreview(): RefundPreview {
  return {
    kind: "refund",
    orderNumber: "1234567890",
    orderToken: "tok",
    lineNumbers: ["1", "2"],
    scope: "full",
    refundTotal: "20.00",
    remainingRefundableTotal: "0.00",
    nonRefundableFee: "2.50",
    chargedTotal: "22.50",
    status: "CONFIRMED",
    emailBinding: "binding",
    observedAt: "2030-01-15T08:00:00.000Z",
    confirmationToken: "rt",
  };
}

function stubClient(overrides: DeepPartial<AmcClient> = {}): AmcClient {
  const base: AmcClient = {
    showtimes: { list: vi.fn(async () => []) },
    inventory: {
      get: vi.fn(async () => layoutWithSeat()),
      getBatch: vi.fn(async () => ({ observedAt: "t", results: [] })),
    },
    auth: {
      status: vi.fn(async () => ({
        provider: "amc" as const,
        account: "personal" as const,
        status: "valid" as const,
      })),
      bootstrap: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
      repair: vi.fn(async () => undefined),
    },
    orders: {
      createCart: vi.fn(),
      get: vi.fn(),
      extendExpiration: vi.fn(),
      release: vi.fn(async () => ({ released: true as const })),
    },
    checkout: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    refunds: { preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn() },
    close: vi.fn(async () => undefined),
  };
  return merge(base, overrides);
}

function run(
  argv: string[],
  client: AmcClient,
  extra: Partial<AmcCliDependencies> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  return runAmcCli(["node", "amc", ...argv], {
    client,
    writeOut: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    ...extra,
  }).then((code) => ({ code, out, err }));
}

function singleJsonError(out: string[]): {
  error: Record<string, unknown>;
} {
  expect(out).toHaveLength(1);
  const parsed = JSON.parse(out[0]!) as { error: Record<string, unknown> };
  expect(parsed.error).toBeTypeOf("object");
  return parsed;
}

describe("CLI JSON error envelope preserves safe reconciliation context", () => {
  it("retains cart-creation reconciliation identifiers", async () => {
    const client = stubClient({
      orders: {
        createCart: vi.fn(async () => {
          throw new CartCreationOutcomeUnknownError("ambiguous", {
            showtimeId: "900000004",
            seatNames: ["A2"],
          });
        }),
      },
    });
    const { code, out } = await run(
      ["cart", "create", "--showtime", "900000004", "--seat", "A2", "--json"],
      client,
    );
    expect(code).toBe(1);
    const { error } = singleJsonError(out);
    expect(error).toEqual({
      code: "AMC_WRITE_OUTCOME_UNKNOWN",
      message: "ambiguous",
      operation: "cart",
      reconciliation: { showtimeId: "900000004", seatNames: ["A2"] },
    });
  });

  it("retains the order token when a checkout submit is ambiguous", async () => {
    const preview = fullCheckoutPreview();
    const client = stubClient({
      checkout: {
        preview: vi.fn(async () => preview),
        submit: vi.fn(async () => {
          throw new CheckoutOutcomeUnknownError("ambiguous", {
            orderToken: "tok",
            showtimeId: "900000004",
            seatNames: ["A2"],
          });
        }),
      },
    });
    const { code, out } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "tok",
        "--email",
        "guest@example.test",
        "--vault",
        "vault://synthetic",
        "--json",
      ],
      client,
    );
    expect(code).toBe(1);
    const { error } = singleJsonError(out);
    expect(error).toEqual({
      code: "AMC_WRITE_OUTCOME_UNKNOWN",
      message: "ambiguous",
      operation: "checkout",
      reconciliation: {
        orderToken: "tok",
        showtimeId: "900000004",
        seatNames: ["A2"],
      },
    });
  });

  it("retains refund reconciliation identifiers", async () => {
    const preview = fullRefundPreview();
    const client = stubClient({
      refunds: {
        preview: vi.fn(async () => preview),
        submit: vi.fn(async () => {
          throw new RefundOutcomeUnknownError("ambiguous", {
            orderNumber: "1234567890",
            lineNumbers: ["1", "2"],
          });
        }),
      },
    });
    const { code, out } = await run(
      [
        "refund",
        "submit",
        "--confirmation",
        "1234567890",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(code).toBe(1);
    const { error } = singleJsonError(out);
    expect(error).toEqual({
      code: "AMC_WRITE_OUTCOME_UNKNOWN",
      message: "ambiguous",
      operation: "refund",
      reconciliation: { orderNumber: "1234567890", lineNumbers: ["1", "2"] },
    });
  });

  it("retains the order token when a release is ambiguous", async () => {
    const client = stubClient({
      orders: {
        release: vi.fn(async () => {
          throw new ReleaseOutcomeUnknownError("ambiguous", {
            orderToken: "tok",
          });
        }),
      },
    });
    const { code, out } = await run(
      ["order", "release", "--token", "tok", "--json"],
      client,
    );
    expect(code).toBe(1);
    const { error } = singleJsonError(out);
    expect(error).toEqual({
      code: "AMC_WRITE_OUTCOME_UNKNOWN",
      message: "ambiguous",
      operation: "release",
      reconciliation: { orderToken: "tok" },
    });
  });

  it("excludes adversarial extra properties and non-allowlisted reconciliation keys", async () => {
    const hostile = new CheckoutOutcomeUnknownError("ambiguous", {
      orderToken: "tok",
      // Adversarial extras smuggled into the reconciliation record.
      ...({
        sessionCookie: "amc-session=SECRET",
        cardNumber: "4111111111111111",
        requestBody: { pan: "SECRET" },
        url: "https://provider.example/checkout?auth=SECRET",
        seatNames: [{ nested: "not-a-string" }],
      } as object),
    });
    Object.assign(hostile, {
      cause: new Error("raw provider error with Bearer SECRET"),
      response: { headers: { cookie: "SECRET" } },
      vaultPointer: "vault://SECRET",
    });
    const client = stubClient({
      orders: {
        release: vi.fn(async () => {
          throw hostile;
        }),
      },
    });
    const { code, out } = await run(
      ["order", "release", "--token", "tok", "--json"],
      client,
    );
    expect(code).toBe(1);
    const { error } = singleJsonError(out);
    expect(error).toEqual({
      code: "AMC_WRITE_OUTCOME_UNKNOWN",
      message: "ambiguous",
      operation: "checkout",
      reconciliation: { orderToken: "tok" },
    });
    expect(out[0]).not.toContain("SECRET");
    expect(out[0]).not.toContain("4111111111111111");
  });

  it("keeps human output concise and secret-safe without --json", async () => {
    const client = stubClient({
      orders: {
        release: vi.fn(async () => {
          throw new ReleaseOutcomeUnknownError("ambiguous", {
            orderToken: "tok",
          });
        }),
      },
    });
    const { code, out, err } = await run(
      ["order", "release", "--token", "tok"],
      client,
    );
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    expect(err).toEqual(["error: ambiguous"]);
  });
});

describe("CLI --json is machine-readable for parse and usage failures", () => {
  it("emits one JSON error object for a missing required option", async () => {
    const { code, out, err } = await run(
      [
        "showtimes",
        "--theater-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
        "--json",
      ],
      stubClient(),
    );
    expect(code).not.toBe(0);
    expect(err).toHaveLength(0);
    const { error } = singleJsonError(out);
    expect(error.code).toBe("AMC_USAGE");
    expect(error.message).toContain("--date");
  });

  it("emits one JSON error object for an unknown subcommand", async () => {
    const { code, out, err } = await run(
      ["frobnicate", "--json"],
      stubClient(),
    );
    expect(code).not.toBe(0);
    expect(err).toHaveLength(0);
    const { error } = singleJsonError(out);
    expect(error.code).toBe("AMC_USAGE");
    expect(error.message).toContain("frobnicate");
  });

  it("honors --json placed before the subcommand", async () => {
    const { code, out, err } = await run(["--json", "showtimes"], stubClient());
    expect(code).not.toBe(0);
    expect(err).toHaveLength(0);
    const { error } = singleJsonError(out);
    expect(error.code).toBe("AMC_USAGE");
  });

  it("emits one JSON error object for command validation failures", async () => {
    const { code, out, err } = await run(
      [
        "refund",
        "preview",
        "--confirmation",
        "not-a-number",
        "--email",
        "guest@example.test",
        "--json",
      ],
      stubClient(),
    );
    expect(code).toBe(1);
    expect(err).toHaveLength(0);
    const { error } = singleJsonError(out);
    expect(error.code).toBe("AMC_ERROR");
    expect(error.message).toContain("confirmation");
  });

  it("preserves human usage errors and help without --json", async () => {
    const usage = await run(
      [
        "showtimes",
        "--theater-url",
        "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
      ],
      stubClient(),
    );
    expect(usage.code).not.toBe(0);
    expect(usage.out).toHaveLength(0);
    expect(usage.err.join("\n")).toContain("--date");

    const help = await run(["--help"], stubClient());
    expect(help.code).toBe(0);
    expect(help.err).toHaveLength(0);
    expect(help.out.join("\n")).toContain("Usage:");
  });
});

describe("CLI capability module contract", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    delete process.env.AMC_CAPABILITY_MODULE;
  });

  function writeCapabilityModule(source: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "amc-capability-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "capabilities.cjs");
    writeFileSync(file, source);
    return file;
  }

  it("invokes createAmcCapabilities with no arguments and uses its result", async () => {
    const probe = globalThis as { __amcFactoryArgCount?: number };
    delete probe.__amcFactoryArgCount;
    process.env.AMC_CAPABILITY_MODULE = writeCapabilityModule(
      `"use strict";
       exports.createAmcCapabilities = function () {
         globalThis.__amcFactoryArgCount = arguments.length;
         return {
           defaultVaultPointer: "vault://synthetic-module",
         };
       };
      `,
    );
    const preview = fullCheckoutPreview();
    const submit = vi.fn(async () => ({
      orderToken: "tok",
      confirmationNumber: "42",
      chargedTotal: "22.50" as const,
      status: "CONFIRMED" as const,
      reconciled: false,
    }));
    const client = stubClient({
      checkout: {
        preview: vi.fn(async () => preview),
        submit,
      },
    });
    const { code } = await run(
      [
        "checkout",
        "submit",
        "--token",
        "tok",
        "--email",
        "guest@example.test",
        "--json",
      ],
      client,
    );
    expect(code).toBe(0);
    expect(probe.__amcFactoryArgCount).toBe(0);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "guest@example.test",
        vaultPointer: "vault://synthetic-module",
      }),
    );
  });

  it("reports a module without the export as one JSON error, not a crash", async () => {
    process.env.AMC_CAPABILITY_MODULE = writeCapabilityModule(
      `"use strict"; exports.somethingElse = () => ({});`,
    );
    const { code, out, err } = await run(
      ["auth", "status", "--json"],
      stubClient(),
    );
    expect(code).toBe(1);
    expect(err).toHaveLength(0);
    const { error } = singleJsonError(out);
    expect(error.code).toBe("AMC_ERROR");
    expect(error.message).toContain("createAmcCapabilities()");
  });

  it("reports a broken module as a human fatal error without --json", async () => {
    process.env.AMC_CAPABILITY_MODULE = writeCapabilityModule(
      `"use strict"; exports.createAmcCapabilities = () => "not-an-object";`,
    );
    const { code, out, err } = await run(["auth", "status"], stubClient());
    expect(code).toBe(1);
    expect(out).toHaveLength(0);
    expect(err).toEqual([
      "fatal: createAmcCapabilities() must return an object",
    ]);
  });
});

type DeepPartial<T> = { [K in keyof T]?: Partial<T[K]> };

function merge(base: AmcClient, overrides: DeepPartial<AmcClient>): AmcClient {
  const out = { ...base } as unknown as Record<string, unknown>;
  const source = base as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    out[key] = { ...(source[key] as object), ...(value as object) };
  }
  return out as unknown as AmcClient;
}

function layoutWithSeat(): AmcSeatingLayout {
  return {
    columns: 1,
    rows: 1,
    seats: [
      {
        name: "A2",
        available: true,
        column: 1,
        row: 1,
        type: "CanReserve",
        seatTier: "Regular",
        shouldDisplay: true,
      },
    ],
    prices: [
      {
        sku: "TICKET-ADULT",
        type: "Adult",
        price: 20,
        convenienceFee: 2.5,
        tax: 0,
      },
    ],
  };
}
