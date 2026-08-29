import { describe, expect, it } from "vitest";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { AmcGraphAuthProbe } from "../src/client/auth-probe";
import {
  AmcAuthRejectedError,
  AmcChallengeError,
  AmcHttpError,
} from "../src/client/client";

class ScriptedTransport implements Transport {
  readonly name = "scripted";
  readonly sent: RequestInput[] = [];
  constructor(private readonly script: Array<ResponseOutput | Error>) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const entry = this.script.shift();
    if (!entry) throw new Error("unexpected canary request");
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

const AUTHED = jsonResponse({
  data: { viewer: { user: { __typename: "User" } } },
});

function jsonResponse(value: unknown): ResponseOutput {
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

function probe(script: Array<ResponseOutput | Error>) {
  const transport = new ScriptedTransport(script);
  const reads: string[] = [];
  const p = new AmcGraphAuthProbe({
    transport,
    cookieHeader: () => "session=opaque",
    onSuccessfulRead: async (url) => {
      reads.push(url);
    },
  });
  return { p, transport, reads };
}

describe("AmcGraphAuthProbe transient same-session retry", () => {
  it("retries once past a transient 429 interstitial and validates the healthy response", async () => {
    const { p, transport, reads } = probe([
      raw(429, "<html>too many requests</html>"),
      AUTHED,
    ]);
    await expect(p.check()).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(2);
    // Same session on the retry — never a browser repair.
    expect(transport.sent[1]?.headers.cookie).toBe("session=opaque");
    expect(reads).toHaveLength(1);
  });

  it("retries once past a 200 interstitial body", async () => {
    const { p, transport } = probe([
      raw(200, "<html>please wait</html>"),
      AUTHED,
    ]);
    await expect(p.check()).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(2);
  });

  it("retries once past a first-attempt transport throw (EPROTO/TLS)", async () => {
    const eproto = Object.assign(
      new Error("write EPROTO ... TLS fatal alert"),
      {
        code: "EPROTO",
      },
    );
    const { p, transport } = probe([eproto, AUTHED]);
    await expect(p.check()).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(2);
  });

  it("fails after exactly two dispatches when the transient persists (existing typed error)", async () => {
    const { p, transport } = probe([
      raw(503, "<html>unavailable</html>"),
      raw(503, "<html>unavailable</html>"),
    ]);
    await expect(p.check()).rejects.toBeInstanceOf(AmcHttpError);
    expect(transport.sent).toHaveLength(2);
  });

  it("does not retry a nontransient authenticated failure (drifted 200 JSON)", async () => {
    const { p, transport } = probe([
      jsonResponse({ data: { viewer: { user: null } } }),
    ]);
    await expect(p.check()).rejects.toBeInstanceOf(AmcAuthRejectedError);
    expect(transport.sent).toHaveLength(1);
  });

  it("does not retry a nontransient 401 rejection", async () => {
    const { p, transport } = probe([raw(401, "unauthorized")]);
    await expect(p.check()).rejects.toBeInstanceOf(AmcAuthRejectedError);
    expect(transport.sent).toHaveLength(1);
  });

  it("treats a genuine nontransient 403 challenge immediately, without retry", async () => {
    const { p, transport } = probe([
      raw(403, "<html>Just a moment... challenge-platform Cloudflare</html>"),
    ]);
    await expect(p.check()).rejects.toBeInstanceOf(AmcChallengeError);
    expect(transport.sent).toHaveLength(1);
  });
});
