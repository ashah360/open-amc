import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { HelloTransport } from "../src/transport";
import {
  AMC_SESSION_KEY,
  AmcRuntime,
  adoptPersistedFingerprint,
} from "../src/client/runtime";
import {
  AmcSession,
  decodeAmcSession,
  encodeAmcSession,
} from "../src/client/session";
import { sanitizePeetFingerprint } from "../src/client/fingerprint";

// A realistic (still synthetic) peet.ws capture that hellojs `fromPeet` accepts,
// carrying identifying/ephemeral fields the sanitizer must strip.
function realisticPeet(): Record<string, unknown> {
  return {
    ip: "203.0.113.7:51000",
    donate: "coffee",
    tcpip: { ip: { ttl: 64 }, tcp: { window: 65535 } },
    http_version: "h2",
    tls: {
      ciphers: ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384"],
      extensions: [
        { name: "supported_groups (10)", supported_groups: ["X25519 (29)"] },
        {
          name: "application_layer_protocol_negotiation (16)",
          protocols: ["h2", "http/1.1"],
        },
        { name: "supported_versions (43)", versions: ["TLS 1.3", "TLS 1.2"] },
      ],
      ja3: "771,4865-4866,10-16-43,29,0",
      ja3_hash: "hash3",
      ja4: "t13d1516h2_aaaa_bbbb",
      peetprint: "pp",
      peetprint_hash: "pph",
      client_random: "deadbeefdeadbeefdeadbeefdeadbeef",
      session_id: "cafebabecafebabecafebabecafebabe",
    },
    http2: {
      akamai_fingerprint: "1:65536,4:6291456|15663105|0|m,a,s,p",
      akamai_fingerprint_hash: "ah",
      sent_frames: [
        {
          frame_type: "SETTINGS",
          settings: [
            "HEADER_TABLE_SIZE = 65536",
            "INITIAL_WINDOW_SIZE = 6291456",
          ],
        },
        { frame_type: "WINDOW_UPDATE", increment: 15663105 },
        {
          frame_type: "HEADERS",
          flags: ["EndStream", "EndHeaders"],
          headers: [
            ":method: GET",
            ":authority: www.amctheatres.com",
            ":scheme: https",
            ":path: /",
            "user-agent: Mozilla/5.0 Chrome/147",
          ],
        },
      ],
    },
    user_agent: "Mozilla/5.0 Chrome/147",
  };
}

const FINGERPRINT = sanitizePeetFingerprint(realisticPeet());

// A fingerprint-adopting transport that records the profile active at the time
// of each request, so tests can prove adoption happened BEFORE the read.
class RecordingGraphTransport implements Transport {
  readonly name = "recording";
  readonly requests: Array<{ url: string; profileAtRequest: string }> = [];
  readonly adopted: string[] = [];
  profile = "chrome147-mac";
  constructor(private readonly responses: ResponseOutput[]) {}
  async adoptFingerprint(fingerprint: {
    name: string;
    peet: Record<string, unknown>;
  }): Promise<boolean> {
    this.adopted.push(fingerprint.name);
    this.profile = fingerprint.name;
    return true;
  }
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.requests.push({ url: input.url, profileAtRequest: this.profile });
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected request");
    return response;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-fp-adopt-"));
  roots.push(root);
  return new FileSessionStore({ root, lockPollMs: 5 });
}

function persistedSession(withFingerprint: boolean): AmcSession {
  const base: AmcSession = {
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
  return withFingerprint ? { ...base, fingerprint: FINGERPRINT } : base;
}

function jsonResponse(value: unknown): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: JSON.stringify(value),
    timingMs: 1,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}

function discoveryPayload() {
  return {
    data: {
      viewer: {
        user: {
          movies: {
            items: [
              {
                movie: { movieId: 1, name: "Example", slug: "example-1" },
                theatres: [
                  {
                    theatre: {
                      theatreId: 411,
                      name: "AMC Empire 25",
                      slug: "amc-empire-25",
                    },
                    formats: {
                      date: "2030-01-15",
                      items: [
                        {
                          attributes: [{ name: "Digital" }],
                          groups: {
                            edges: [
                              {
                                node: {
                                  showtimeGroupHeadingAttribute: {
                                    name: "Digital",
                                  },
                                  showtimes: {
                                    edges: [
                                      {
                                        node: {
                                          showtimeId: 900000001,
                                          businessDate: "2030-01-15",
                                          when: "2030-01-16T01:00:00.000Z",
                                          status: "Sellable",
                                          display: { time: "6:00", amPm: "PM" },
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

describe("HelloTransport fingerprint adoption", () => {
  it("adopts a registered fingerprint and pins it as the profile", async () => {
    const transport = new HelloTransport();
    expect(transport.profile).toBe("chrome147-mac");
    expect(await transport.adoptFingerprint(FINGERPRINT)).toBe(true);
    expect(transport.profile).toBe(FINGERPRINT.name);
  });

  it("refuses adoption when a manual profile is pinned (operator override wins)", async () => {
    const transport = new HelloTransport({
      profile: "amc-browser",
      allowFingerprintAdoption: false,
    });
    expect(await transport.adoptFingerprint(FINGERPRINT)).toBe(false);
    expect(transport.profile).toBe("amc-browser");
  });
});

describe("runtime adopts a persisted fingerprint before the read", () => {
  it("a fresh process re-adopts the persisted fingerprint before the graph read", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(persistedSession(true)));
    const transport = new RecordingGraphTransport([
      jsonResponse(discoveryPayload()),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    await runtime.getShowtimes({
      venue: {
        name: "AMC Empire 25",
        slug: "amc-empire-25",
        path: "/movie-theatres/new-york-city/amc-empire-25/showtimes",
      },
      date: "2030-01-15",
    });

    expect(transport.adopted).toEqual([FINGERPRINT.name]);
    // The read ran with the adopted profile, not the stock one.
    expect(transport.requests[0]?.profileAtRequest).toBe(FINGERPRINT.name);
  });

  it("does not adopt anything when the persisted session has no fingerprint", async () => {
    const store = await newStore();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession(persistedSession(false)),
    );
    const transport = new RecordingGraphTransport([
      jsonResponse(discoveryPayload()),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    await runtime.getShowtimes({
      venue: {
        name: "AMC Empire 25",
        slug: "amc-empire-25",
        path: "/movie-theatres/new-york-city/amc-empire-25/showtimes",
      },
      date: "2030-01-15",
    });

    expect(transport.adopted).toEqual([]);
    expect(transport.requests[0]?.profileAtRequest).toBe("chrome147-mac");
    // Ordinary reads never contact the fingerprint capture endpoint.
    expect(transport.requests.some((r) => r.url.includes("tls.peet.ws"))).toBe(
      false,
    );
  });
});

describe("adoptPersistedFingerprint (CLI fresh-process choke point)", () => {
  it("adopts from the persisted record onto an adopting transport", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(persistedSession(true)));
    const transport = new RecordingGraphTransport([]);
    const adopted = await adoptPersistedFingerprint(transport, store);
    expect(adopted).toBe(true);
    expect(transport.profile).toBe(FINGERPRINT.name);
  });

  it("is a no-op with no session and never throws on a malformed record", async () => {
    const store = await newStore();
    const transport = new RecordingGraphTransport([]);
    expect(await adoptPersistedFingerprint(transport, store)).toBe(false);
    await store.save(AMC_SESSION_KEY, Buffer.from("{not json"));
    expect(await adoptPersistedFingerprint(transport, store)).toBe(false);
    expect(transport.profile).toBe("chrome147-mac");
  });

  it("re-adoption survives a store round-trip (persisted fingerprint intact)", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(persistedSession(true)));
    const reloaded = decodeAmcSession((await store.load(AMC_SESSION_KEY))!);
    expect(reloaded.fingerprint?.name).toBe(FINGERPRINT.name);
    const serialized = JSON.stringify(reloaded.fingerprint);
    expect(serialized).not.toContain("client_random");
    expect(serialized).not.toContain('"ip"');
  });
});
