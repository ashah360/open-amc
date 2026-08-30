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
import {
  AmcSession,
  decodeAmcSession,
  encodeAmcSession,
} from "../src/client/session";
import { resolveOfficialAmcTheaterUrl } from "../src/client/theater-url";

const CENTURY_CITY =
  "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes";
const KABUKI =
  "https://www.amctheatres.com/movie-theatres/san-francisco/amc-kabuki-8/showtimes";

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
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-adm-persist-"));
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
const CHALLENGE = html(
  403,
  "<title>Just a moment... challenge-platform Cloudflare</title>",
);
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
function discovery(slug: string, theatreId: number) {
  return graphJson({
    data: {
      viewer: {
        user: {
          movies: {
            items: [
              {
                movie: { movieId: 1, name: "M", slug: "m-1" },
                theatres: [
                  {
                    theatre: { theatreId, name: "T", slug },
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
}

async function savedAdmissionUrl(
  store: FileSessionStore,
): Promise<string | undefined> {
  const bytes = await store.load(AMC_SESSION_KEY);
  return bytes ? decodeAmcSession(bytes).admissionListingUrl : undefined;
}

describe("admission listing URL persists across processes", () => {
  it("a successful showtimes read persists the theater URL onto the session", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new ScriptedTransport([
      discovery("amc-century-city-15", 2069),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    await runtime.getShowtimes({
      venue: resolveOfficialAmcTheaterUrl(CENTURY_CITY),
      date: "2030-01-15",
    });

    expect(await savedAdmissionUrl(store)).toBe(CENTURY_CITY);
  });

  it("restores the persisted URL in a fresh process so a challenged seat read admits directly (no listing-url-required, no browser)", async () => {
    const store = await newStore();
    // Process A already persisted Century City onto a valid session.
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({ ...session(), admissionListingUrl: CENTURY_CITY }),
    );
    // Process B: brand-new runtime, NO options.listingUrl (seats has only an id).
    const transport = new ScriptedTransport([
      CHALLENGE, // seat graph read challenged -> repair -> direct admission
      html(403, "<title>Just a moment... cloudflare</title>"), // admission GET target-challenge -> browser required
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    const failure = await runtime
      .getSeatLayout("146600823")
      .catch((error: unknown) => error);

    // Direct admission ran against the RESTORED caller URL (not id-derived).
    const listingGet = transport.sent.find(
      (r) => r.method === "GET" && r.url === CENTURY_CITY,
    );
    expect(listingGet).toBeDefined();
    // Browser required is a typed, actionable outcome — NOT listing-url-required,
    // and no browser was launched (none configured).
    expect(failure).toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as { stage?: string }).stage).not.toBe(
      "listing-url-required",
    );
  });

  it("a failed showtimes read does not replace the previously persisted URL", async () => {
    const store = await newStore();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({ ...session(), admissionListingUrl: CENTURY_CITY }),
    );
    // New theater read that FAILS (persistent challenge -> direct admission
    // browser-required); the prior Century City URL must survive.
    const transport = new ScriptedTransport([
      CHALLENGE,
      html(403, "<title>Just a moment... cloudflare</title>"),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    await runtime
      .getShowtimes({
        venue: resolveOfficialAmcTheaterUrl(KABUKI),
        date: "2030-01-15",
      })
      .catch(() => undefined);

    expect(await savedAdmissionUrl(store)).toBe(CENTURY_CITY);
  });

  it("a later successful theater read replaces the persisted URL with the newest", async () => {
    const store = await newStore();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({ ...session(), admissionListingUrl: CENTURY_CITY }),
    );
    const transport = new ScriptedTransport([discovery("amc-kabuki-8", 9999)]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    await runtime.getShowtimes({
      venue: resolveOfficialAmcTheaterUrl(KABUKI),
      date: "2030-01-15",
    });

    expect(await savedAdmissionUrl(store)).toBe(KABUKI);
  });

  it("a legacy session without the field still returns listing-url-required on a challenged seat read", async () => {
    const store = await newStore();
    await store.save(AMC_SESSION_KEY, encodeAmcSession(session()));
    const transport = new ScriptedTransport([CHALLENGE]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    const failure = await runtime
      .getSeatLayout("146600823")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "AMC_SESSION_REPAIR_REQUIRED",
      stage: "listing-url-required",
    });
  });

  it("cart preflight uses the restored URL for auth direct admission; the write dispatches only after auth validates, with no write retry", async () => {
    const store = await newStore();
    await store.save(
      AMC_SESSION_KEY,
      encodeAmcSession({ ...session(), admissionListingUrl: CENTURY_CITY }),
    );
    // Cart preflight canary is challenged -> direct admission against the
    // restored URL clears it -> canary revalidates -> write callback runs once.
    const transport = new ScriptedTransport([
      CHALLENGE, // preflight canary challenged (initial validate)
      CHALLENGE, // canary revalidated under the refresh lock, still challenged
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      redirect(`${CENTURY_CITY}?queueittoken=opaque-return`),
      redirect(CENTURY_CITY, [
        "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
      ]),
      graphJson({ data: { viewer: { user: { __typename: "User" } } } }), // post-admission canary validates the refreshed session
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    let dispatched = 0;
    const result = await runtime.withAuthenticatedWrite(async () => {
      dispatched += 1;
      return "one-dispatch";
    });

    expect(result).toBe("one-dispatch");
    expect(dispatched).toBe(1);
    // Direct admission targeted the restored caller URL.
    expect(
      transport.sent.some((r) => r.method === "GET" && r.url === CENTURY_CITY),
    ).toBe(true);
  });
});

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
