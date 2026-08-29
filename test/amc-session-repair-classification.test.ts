import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import {
  AMC_SESSION_KEY,
  AmcRuntime,
  AmcSessionRepairRequiredError,
} from "../src/client/runtime";
import { AmcSession, encodeAmcSession } from "../src/client/session";
import { runAmcCli } from "../src/cli";
import type { AmcClient } from "../src/client";
import { syntheticListingHtml } from "./fixtures";

class ScriptedTransport implements Transport {
  readonly name = "scripted";
  readonly sent: RequestInput[] = [];
  constructor(private readonly script: Array<ResponseOutput | Error>) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const entry = this.script.shift();
    if (!entry) throw new Error("unexpected AMC request");
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-classify-test-"));
  roots.push(root);
  return new FileSessionStore({ root, lockPollMs: 5 });
}

// One labeled example theater; any official AMC theater URL works.
const LISTING_URL =
  "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes";

function session(rootValue = "secret"): AmcSession {
  return {
    version: 1,
    origin: "https://www.amctheatres.com",
    profile: "chrome147-mac",
    exportedAt: "2030-01-15T07:00:00.000Z",
    cookies: [
      {
        name: "root",
        value: rootValue,
        domain: ".amctheatres.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
  };
}

function htmlResponse(bodyText: string, status = 200): ResponseOutput {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText,
    timingMs: 10,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}

function tlsFatalError(): Error {
  return Object.assign(
    new Error(
      "write EPROTO 0088ECEC: error: SSL routines: TLS fatal alert from server",
    ),
    { code: "EPROTO" },
  );
}

describe("direct-admission failures classify as typed session repair", () => {
  it("maps a TLS fatal during direct admission to AMC_SESSION_REPAIR_REQUIRED", async () => {
    const store = await newStore();
    // No usable session; the read triggers bounded direct admission whose
    // very first transport request dies with a server TLS fatal alert.
    const transport = new ScriptedTransport([tlsFatalError()]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });

    const failure = await runtime.getSeatLayout("900000004").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as { code: string }).code).toBe(
      "AMC_SESSION_REPAIR_REQUIRED",
    );
    expect((failure as Error).message).toContain("amc auth repair");
  });

  it("maps a typed direct-admission failure to AMC_SESSION_REPAIR_REQUIRED", async () => {
    const store = await newStore();
    // Direct admission expects a Queue-it 302; a plain 200 page is the typed
    // AMC_DIRECT_ADMISSION_FAILED (target) path.
    const transport = new ScriptedTransport([
      htmlResponse("<html><body>plain page, no queue redirect</body></html>"),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });

    const failure = await runtime.getSeatLayout("900000004").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as { code: string }).code).toBe(
      "AMC_SESSION_REPAIR_REQUIRED",
    );
  });

  it("does not reclassify non-transport errors raised during admission", async () => {
    const store = await newStore();
    const programmerError = Object.assign(
      new Error('The "options" argument must be of type object'),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
    const transport = new ScriptedTransport([programmerError]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });

    const failure = await runtime.getSeatLayout("900000004").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as { code?: string }).code).toBe("ERR_INVALID_ARG_TYPE");
  });

  it("preserves raw transport errors after a validated session", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new ScriptedTransport([
      // The saved session validates against the listing canary...
      htmlResponse(syntheticListingHtml()),
      // ...then the actual seat read hits an unrelated network failure, which
      // must NOT be rebranded as session repair.
      tlsFatalError(),
    ]);
    const runtime = new AmcRuntime({
      transport,
      store,
      listingUrl: LISTING_URL,
    });

    const failure = await runtime.getSeatLayout("900000004").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).not.toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as { code?: string }).code).toBe("EPROTO");
  });

  it("CLI showtimes emits one JSON error with the stable repair-required code", async () => {
    const repairRequired = new AmcSessionRepairRequiredError(
      "target-challenge",
    );
    const client = {
      showtimes: {
        list: vi.fn(async () => {
          throw repairRequired;
        }),
      },
      inventory: { get: vi.fn(), getBatch: vi.fn() },
      auth: {
        status: vi.fn(),
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
    const output: string[] = [];
    const code = await runAmcCli(
      [
        "node",
        "amc",
        "showtimes",
        "--theater-url",
        LISTING_URL,
        "--date",
        "2030-01-15",
        "--json",
      ],
      {
        client,
        writeOut: (line) => output.push(line),
        writeErr: (line) => output.push(line),
      },
    );
    expect(code).toBe(1);
    expect(output).toHaveLength(1);
    const { error } = JSON.parse(output[0]!);
    expect(error.code).toBe("AMC_SESSION_REPAIR_REQUIRED");
    expect(error.message).toContain("amc auth repair --listing-url");
  });
});
