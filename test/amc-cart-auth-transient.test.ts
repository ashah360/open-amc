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

class ScriptedTransport implements Transport {
  readonly name = "scripted";
  readonly sent: RequestInput[] = [];
  constructor(private readonly script: Array<ResponseOutput | Error>) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const entry = this.script.shift();
    if (!entry) throw new Error("unexpected request");
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
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-cart-auth-"));
  roots.push(root);
  return new FileSessionStore({ root, lockPollMs: 5 });
}

function session(): AmcSession {
  return {
    version: 1,
    origin: "https://www.amctheatres.com",
    profile: "chrome147-mac",
    exportedAt: "2030-01-15T07:00:00.000Z",
    cookies: [
      {
        name: "root",
        value: "secret",
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

const AUTHED: ResponseOutput = {
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  bodyText: JSON.stringify({
    data: { viewer: { user: { __typename: "User" } } },
  }),
  timingMs: 1,
  transport: "scripted",
  setCookieNames: [],
  setCookies: [],
};
function raw(status: number, bodyText: string): ResponseOutput {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText,
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}

describe("cart auth validation survives a transient canary interstitial", () => {
  it("does not escalate to listing-url-required when the canary is transient-then-healthy", async () => {
    // A fresh cart process (no theater URL / no admissionListingUrl) with a
    // valid persisted session. The auth canary's first attempt is a transient
    // interstitial; the bounded same-session retry validates the healthy
    // response, so the write path proceeds and NEVER escalates to
    // AMC_SESSION_REPAIR_REQUIRED(listing-url-required).
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new ScriptedTransport([
      raw(429, "<html>too many requests</html>"),
      AUTHED,
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    let dispatched = false;
    const result = await runtime.withAuthenticatedWrite(async () => {
      // Auth validation succeeded, so the cart dispatch is reached.
      dispatched = true;
      return "cart-dispatched";
    });

    expect(result).toBe("cart-dispatched");
    expect(dispatched).toBe(true);
    // Exactly one transient retry on the canary: two dispatches, no more.
    expect(transport.sent).toHaveLength(2);
  });

  it("never reaches cart dispatch when auth validation genuinely fails, and does not mislabel a persistent transient", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    // Persistent transient on the canary: retried once, then surfaces the
    // existing typed transport error — NOT listing-url-required, and the cart
    // callback must never run.
    const transport = new ScriptedTransport([
      raw(503, "<html>unavailable</html>"),
      raw(503, "<html>unavailable</html>"),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    let dispatched = false;
    const failure = await runtime
      .withAuthenticatedWrite(async () => {
        dispatched = true;
        return "should-not-happen";
      })
      .catch((error: unknown) => error);

    expect(dispatched).toBe(false);
    expect(failure).not.toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as { code?: string }).code).toBe("AMC_HTTP");
  });
});
