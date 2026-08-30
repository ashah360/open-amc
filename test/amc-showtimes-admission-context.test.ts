import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { AMC_SESSION_KEY, AmcRuntime } from "../src/client/runtime";
import { AmcSession, encodeAmcSession } from "../src/client/session";
import { resolveOfficialAmcTheaterUrl } from "../src/client/theater-url";

const CENTURY_CITY =
  "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes";

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
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});
async function newStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-adm-ctx-"));
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
function html(status: number, body: string): ResponseOutput {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText: body,
    timingMs: 1,
    transport: "scripted",
    setCookieNames: [],
    setCookies: [],
  };
}
function redirect(location: string, setCookies: string[] = []): ResponseOutput {
  return {
    status: 302,
    headers: { location },
    bodyText: "",
    timingMs: 1,
    transport: "scripted",
    setCookieNames: setCookies.map((l) => l.slice(0, l.indexOf("="))),
    setCookies,
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
const DISCOVERY = graphJson({
  data: {
    viewer: {
      user: {
        movies: {
          items: [
            {
              movie: { movieId: 1, name: "M", slug: "m-1" },
              theatres: [
                {
                  theatre: {
                    theatreId: 2069,
                    name: "AMC Century City 15",
                    slug: "amc-century-city-15",
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
});

describe("showtimes provides its resolved listing URL to direct admission", () => {
  it("routes a graph-read challenge into direct admission against the EXACT caller URL, not listing-url-required", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new ScriptedTransport([
      // Graph DatedShowtimes POST is challenged (403 with markers -> repair).
      html(
        403,
        "<title>Just a moment... challenge-platform Cloudflare</title>",
      ),
      // Direct admission GET of the caller's listing URL hits a target
      // challenge -> browser required.
      html(403, "<title>Just a moment... cloudflare</title>"),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    const failure = await runtime
      .getShowtimes({
        venue: resolveOfficialAmcTheaterUrl(CENTURY_CITY),
        date: "2030-01-15",
      })
      .catch((error: unknown) => error);

    // The direct admission actually ran against the exact caller URL — the
    // theater context reached repair (NOT listing-url-required).
    const listingGets = transport.sent.filter(
      (r) => r.method === "GET" && r.url === CENTURY_CITY,
    );
    expect(listingGets.length).toBeGreaterThanOrEqual(1);
    expect(failure).toMatchObject({ code: "AMC_SESSION_REPAIR_REQUIRED" });
    expect((failure as { stage?: string }).stage).not.toBe(
      "listing-url-required",
    );
  });

  it("clears a graph-read challenge via direct Queue-it admission on the caller URL, then reads (no browser)", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new ScriptedTransport([
      // Graph POST challenged -> repair.
      html(
        403,
        "<title>Just a moment... challenge-platform Cloudflare</title>",
      ),
      // Direct Queue-it admission against the caller's listing URL succeeds.
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      redirect(`${CENTURY_CITY}?queueittoken=opaque-return`),
      redirect(CENTURY_CITY, [
        "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
      ]),
      // Post-admission validate canary (forceRefresh validates before persist).
      graphJson({ data: { viewer: { user: { __typename: "User" } } } }),
      // Retried graph read now succeeds.
      DISCOVERY,
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    const showtimes = await runtime.getShowtimes({
      venue: resolveOfficialAmcTheaterUrl(CENTURY_CITY),
      date: "2030-01-15",
    });

    expect(showtimes).toHaveLength(1);
    // The first admission GET targeted the exact caller listing URL.
    const firstGet = transport.sent.find((r) => r.method === "GET");
    expect(firstGet?.url).toBe(CENTURY_CITY);
  });

  it("rejects a non-AMC theater URL at the boundary before any transport", async () => {
    const store = await newStore();
    const transport = new ScriptedTransport([]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });
    // The resolver used at the command boundary rejects lookalikes; nothing
    // dispatches.
    expect(() =>
      resolveOfficialAmcTheaterUrl(
        "https://www.amctheatres.com.evil.example/movie-theatres/x/amc-y/showtimes",
      ),
    ).toThrow(/AMC/i);
    expect(transport.sent).toHaveLength(0);
    void runtime;
  });

  it("seats (no theater URL) still escalate a challenge to listing-url-required (existing behavior retained)", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    // A seat read carries no theater context, so a challenge it cannot clear
    // directly correctly asks for setup (listing-url-required). We must never
    // fabricate a theater URL for it.
    const transport = new ScriptedTransport([
      html(
        403,
        "<title>Just a moment... challenge-platform Cloudflare</title>",
      ),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    const failure = await runtime
      .getSeatLayout("900000001")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "AMC_SESSION_REPAIR_REQUIRED",
      stage: "listing-url-required",
    });
  });
});
