import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../src/auth-session";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { resolveOfficialAmcTheaterUrl } from "../src/client/theater-url";
import {
  AmcRuntime,
  AmcSessionRepairRequiredError,
} from "../src/client/runtime";
import type { AmcSession } from "../src/client/session";

class QueueTransport implements Transport {
  readonly name = "recording";
  readonly sent: RequestInput[] = [];
  constructor(private readonly responses: ResponseOutput[]) {}
  async request(input: RequestInput): Promise<ResponseOutput> {
    this.sent.push(input);
    const response = this.responses.shift();
    if (!response) throw new Error("unexpected AMC request");
    return response;
  }
}

class FakeBrowserRefresher {
  calls = 0;
  constructor(private readonly result: AmcSession) {}
  async refresh(): Promise<AmcSession> {
    this.calls += 1;
    return this.result;
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function newStore(): Promise<FileSessionStore> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amc-dynamic-test-"));
  roots.push(root);
  return new FileSessionStore({ root, lockPollMs: 5 });
}

// Three diverse official theater URLs/markets; none is a built-in default.
const THEATERS = [
  {
    url: "https://www.amctheatres.com/movie-theatres/new-york-city/amc-empire-25/showtimes",
    slug: "amc-empire-25",
    name: "AMC Empire 25",
    providerTheatreId: 411,
  },
  {
    url: "https://www.amctheatres.com/movie-theatres/los-angeles/amc-century-city-15/showtimes",
    slug: "amc-century-city-15",
    name: "AMC Century City 15",
    providerTheatreId: 2069,
  },
  {
    url: "https://www.amctheatres.com/movie-theatres/chicago/amc-river-east-21/showtimes",
    slug: "amc-river-east-21",
    name: "AMC River East 21",
    providerTheatreId: 1990,
  },
] as const;

describe("dynamic theater flow: resolver -> slug -> direct admission -> GraphQL", () => {
  it.each(THEATERS)(
    "admits against $slug's exact listing URL and matches its slug in GraphQL",
    async (theater) => {
      const store = await newStore();
      const venue = resolveOfficialAmcTheaterUrl(theater.url);
      const transport = new QueueTransport([
        graphChallenge(),
        redirect(
          "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
        ),
        redirect(`${theater.url}?queueittoken=opaque-return`),
        redirect(theater.url, [
          "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
        ]),
        authenticatedCanary(),
        jsonResponse(discoveryPayloadFor(theater)),
      ]);
      const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

      const showtimes = await runtime.getShowtimes({
        venue,
        date: "2030-01-15",
      });

      // Direct admission targeted EXACTLY the caller's listing URL.
      expect(transport.sent[1]?.url).toBe(theater.url);
      // Slug-only matching picked the right theatre; the id is the provider's.
      expect(showtimes).toEqual([
        expect.objectContaining({
          id: "900000001",
          theaterId: String(theater.providerTheatreId),
          theaterName: theater.name,
        }),
      ]);
    },
  );

  it("runs the exact request sequence: graph challenge, admission at the theater, canary, retry", async () => {
    const theater = THEATERS[0];
    const store = await newStore();
    const venue = resolveOfficialAmcTheaterUrl(theater.url);
    const transport = new QueueTransport([
      graphChallenge(),
      redirect(
        "https://queue.amctheatres.com/?c=amctheatres&e=globalsafetynetweb",
      ),
      redirect(`${theater.url}?queueittoken=opaque-return`),
      redirect(theater.url, [
        "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=EventId%3Dglobalsafetynetweb%26RedirectType%3Ddisabled%26IssueTime%3D1893456000%26Hash%3Dopaque; Domain=.amctheatres.com; Path=/; Max-Age=86400",
      ]),
      authenticatedCanary(),
      jsonResponse(discoveryPayloadFor(theater)),
    ]);
    const runtime = new AmcRuntime({ transport, store, readMode: "graphql" });

    await runtime.getShowtimes({ venue, date: "2030-01-15" });

    expect(
      transport.sent.map(
        (request) => `${request.method} ${new URL(request.url).hostname}`,
      ),
    ).toEqual([
      "POST graph.amctheatres.com",
      "GET www.amctheatres.com",
      "GET queue.amctheatres.com",
      "GET www.amctheatres.com",
      "POST graph.amctheatres.com",
      "POST graph.amctheatres.com",
    ]);
    expect(transport.sent[1]?.url).toBe(theater.url);
    expect(transport.sent[3]?.url).toBe(
      `${theater.url}?queueittoken=opaque-return`,
    );
  });

  it("fails with listing-url-required (never the browser) when no theater context exists", async () => {
    const store = await newStore();
    const browser = new FakeBrowserRefresher(session("browser"));
    const transport = new QueueTransport([graphChallenge()]);
    const runtime = new AmcRuntime({
      transport,
      store,
      readMode: "graphql",
      browserRefresher: browser,
    });

    const failure = await runtime.getSeatLayout("900000004").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as AmcSessionRepairRequiredError).stage).toBe(
      "listing-url-required",
    );
    // No admission was attempted against any assumed venue, and the browser
    // is never opened automatically.
    expect(transport.sent).toHaveLength(1);
    expect(browser.calls).toBe(0);
  });

  it("plain explicit repair without a listing URL or browser is a typed instruction", async () => {
    const store = await newStore();
    const runtime = new AmcRuntime({
      transport: new QueueTransport([]),
      store,
      readMode: "graphql",
    });

    const failure = await runtime.repairSession().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AmcSessionRepairRequiredError);
    expect((failure as AmcSessionRepairRequiredError).stage).toBe(
      "listing-url-required",
    );
    expect((failure as Error).message).toContain("--listing-url");
  });

  it("plain explicit repair uses a deliberately configured browser capability", async () => {
    const store = await newStore();
    const browser = new FakeBrowserRefresher(session("browser-fresh"));
    const transport = new QueueTransport([authenticatedCanary()]);
    const runtime = new AmcRuntime({
      transport,
      store,
      readMode: "graphql",
      browserRefresher: browser,
    });

    await runtime.repairSession();

    expect(browser.calls).toBe(1);
    // The exported jar was still validated by the direct canary before save.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.method).toBe("POST");
  });
});

function session(rootValue: string): AmcSession {
  return {
    version: 1,
    origin: "https://www.amctheatres.com",
    profile: "chrome147-mac",
    exportedAt: "2030-01-15T17:00:00.000Z",
    cookies: [
      {
        name: "root",
        value: rootValue,
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

function graphChallenge(): ResponseOutput {
  return {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText: "<html>Just a moment... challenge-platform Cloudflare</html>",
    timingMs: 1,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}

function authenticatedCanary(): ResponseOutput {
  return jsonResponse({ data: { viewer: { user: { __typename: "User" } } } });
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

function redirect(location: string, setCookies: string[] = []): ResponseOutput {
  return {
    status: 302,
    headers: { location },
    bodyText: "",
    timingMs: 1,
    transport: "recording",
    setCookieNames: setCookies.map((line) => line.slice(0, line.indexOf("="))),
    setCookies,
  };
}

function discoveryPayloadFor(theater: {
  slug: string;
  name: string;
  providerTheatreId: number;
}) {
  const showtime = {
    showtimeId: 900000001,
    businessDate: "2030-01-15",
    when: "2030-01-16T01:00:00.000Z",
    status: "Sellable",
    display: { time: "6:00", amPm: "PM" },
  };
  const theatre = (theatreId: number, name: string, slug: string) => ({
    theatre: { theatreId, name, slug },
    formats: {
      date: "2030-01-15",
      items: [
        {
          attributes: [{ name: "Laser at AMC" }],
          groups: {
            edges: [
              {
                node: {
                  showtimeGroupHeadingAttribute: { name: "Laser at AMC" },
                  showtimes: { edges: [{ node: showtime }] },
                },
              },
            ],
          },
        },
      ],
    },
  });
  return {
    data: {
      viewer: {
        user: {
          movies: {
            items: [
              {
                movie: {
                  movieId: 80002,
                  name: "Example Feature",
                  slug: "example-feature-80002",
                },
                theatres: [
                  // A decoy theatre proves slug matching is exact.
                  theatre(7777, "AMC Other 10", "amc-other-10"),
                  theatre(
                    theater.providerTheatreId,
                    theater.name,
                    theater.slug,
                  ),
                ],
              },
            ],
          },
        },
      },
    },
  };
}
