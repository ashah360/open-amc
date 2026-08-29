import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AmcChallengeError,
  AmcClient,
  AmcHttpError,
} from "../src/client/client";
import {
  availableOrdinarySeats,
  parseSeatPageHtml,
} from "../src/client/seat-layout";
import {
  AmcVenueDefinition,
  parseShowtimePageHtml,
} from "../src/client/showtimes";
import { RequestInput, ResponseOutput, Transport } from "../src/transport";
import { syntheticListingHtml, syntheticSeatHtml } from "./fixtures";

// One labeled example venue descriptor (matches the synthetic fixture); any
// official AMC theater works — there is no built-in venue anywhere.
const EXAMPLE_VENUE: AmcVenueDefinition = {
  id: "2325",
  name: "AMC Metreon 16",
  slug: "amc-metreon-16",
  path: "/movie-theatres/san-francisco/amc-metreon-16/showtimes",
};

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

describe("AMC seat page parser", () => {
  it("extracts AMC’s structured seatingLayout rather than inferring geometry from rendered seats", () => {
    const html = syntheticSeatHtml();
    const layout = parseSeatPageHtml(html);

    expect(layout).toMatchObject({ columns: 7, rows: 4 });
    expect(layout.seats).toHaveLength(28);
    expect(layout.seats.find((seat) => seat.name === "C2")).toEqual({
      available: true,
      column: 2,
      row: 3,
      name: "C2",
      type: "CanReserve",
      seatTier: "Regular",
      shouldDisplay: true,
    });
    expect(layout.seats.slice(0, 4)).toMatchObject([
      { column: 1, row: 1, name: "", type: "NotASeat", shouldDisplay: false },
      { column: 2, row: 1, name: "", type: "NotASeat", shouldDisplay: false },
      { column: 3, row: 1, name: "", type: "NotASeat", shouldDisplay: false },
      {
        column: 4,
        row: 1,
        name: "A4",
        type: "CanReserve",
        shouldDisplay: true,
      },
    ]);
  });

  it("derives stable normalized coordinates directly from AMC row and column slots", () => {
    const html = syntheticSeatHtml();
    const available = availableOrdinarySeats(parseSeatPageHtml(html));

    expect(available.map((seat) => seat.name)).toEqual(["B6", "C2"]);
    expect(available.find((seat) => seat.name === "B6")).toMatchObject({
      column: 6,
      row: 2,
      x: 5.5 / 7,
      y: 1.5 / 4,
    });
    expect(available.find((seat) => seat.name === "C2")).toMatchObject({
      column: 2,
      row: 3,
      x: 1.5 / 7,
      y: 2.5 / 4,
    });
  });

  it("parses a second synthetic auditorium shape without assuming the primary grid", () => {
    const html = syntheticSeatHtml({ columns: 3, rows: 2 });
    const layout = parseSeatPageHtml(html);

    expect(layout).toMatchObject({ columns: 3, rows: 2 });
    expect(layout.seats).toHaveLength(layout.columns * layout.rows);
    expect(layout.seats.filter((seat) => seat.shouldDisplay)).toHaveLength(6);
    expect(availableOrdinarySeats(layout)).toHaveLength(1);
    expect(layout).not.toMatchObject({ columns: 7, rows: 4 });
  });

  it("skips a truncated streamed price marker when a later payload is complete", () => {
    const layout = {
      columns: 1,
      rows: 1,
      seats: [
        {
          available: true,
          column: 1,
          row: 1,
          name: "A1",
          type: "CanReserve",
          seatTier: "Regular",
          shouldDisplay: true,
        },
      ],
    };
    const chunk = (payload: string) =>
      `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
    const html = [
      chunk(`prefix{"seatingLayout":${JSON.stringify(layout)}}suffix`),
      chunk('prefix "prices":['),
      chunk(
        `prefix "prices":${JSON.stringify([
          {
            sku: "TICKET-RS-1-ADULT",
            type: "Adult",
            price: 20.99,
            convenienceFee: 2.69,
            tax: 0,
          },
        ])}`,
      ),
    ].join("");

    expect(parseSeatPageHtml(html).prices).toEqual([
      {
        sku: "TICKET-RS-1-ADULT",
        type: "Adult",
        price: 20.99,
        convenienceFee: 2.69,
        tax: 0,
      },
    ]);
  });

  it("rejects nested seat drift rather than accepting unknown slot types", () => {
    const layout = {
      columns: 1,
      rows: 1,
      seats: [
        {
          available: true,
          column: 1,
          row: 1,
          name: "A1",
          type: "StandingRoom",
          seatTier: "Regular",
          shouldDisplay: true,
        },
      ],
    };
    const payload = `prefix{"seatingLayout":${JSON.stringify(layout)}}suffix`;
    const html = `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;

    expect(() => parseSeatPageHtml(html)).toThrow(/seat 0 drifted/);
  });

  it("performs a named seat-layout read through the injected browser-coherent transport", async () => {
    const html = syntheticSeatHtml();
    const transport = new QueueTransport([
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        bodyText: html,
        timingMs: 10,
        transport: "recording",
        setCookieNames: [],
        setCookies: [],
      },
    ]);
    const client = new AmcClient({ transport, cookieHeader: "session=opaque" });

    const layout = await client.getSeatLayout("900000004");

    expect(layout).toMatchObject({ columns: 7, rows: 4 });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      method: "GET",
      url: "https://www.amctheatres.com/showtimes/900000004/seats",
      headers: {
        accept: "text/html,application/xhtml+xml",
        cookie: "session=opaque",
      },
      followRedirect: true,
      verifyTLS: true,
    });
  });
});

describe("AMC dated showtime discovery", () => {
  it("extracts typed Metreon movies, format groups, and stable showtime ids from the real listing", () => {
    const html = syntheticListingHtml();
    const showtimes = parseShowtimePageHtml(html, {
      venue: EXAMPLE_VENUE,
      date: "2030-01-15",
    });

    expect(
      showtimes.find((showtime) => showtime.id === "900000004"),
    ).toMatchObject({
      movieTitle: "Example Epic",
      theaterName: "AMC Metreon 16",
      date: "2030-01-15",
      format: "IMAX 70MM",
    });
    expect(
      showtimes.find((showtime) => showtime.id === "900000005"),
    ).toMatchObject({
      movieTitle: "Example Feature",
      theaterName: "AMC Metreon 16",
      date: "2030-01-15",
      format: "Dolby Cinema at AMC",
    });
  });

  it("filters movie and format within the exact format group", async () => {
    const html = syntheticListingHtml();
    const transport = new QueueTransport([htmlResponse(html)]);
    const client = new AmcClient({ transport, cookieHeader: "session=opaque" });

    const showtimes = await client.getShowtimes({
      venue: EXAMPLE_VENUE,
      date: "2030-01-15",
      movie: "example epic",
      format: "IMAX 70MM",
    });

    expect(showtimes.map((showtime) => showtime.id)).toContain("900000004");
    expect(
      showtimes.every((showtime) => showtime.movieTitle === "Example Epic"),
    ).toBe(true);
    expect(showtimes.every((showtime) => showtime.format === "IMAX 70MM")).toBe(
      true,
    );
  });

  it("retries one verified AMC partial render before parsing showtimes", async () => {
    const complete = syntheticListingHtml();
    const partial =
      "<html><title>AMC Metreon 16 Showtimes</title><h2>AMC Metreon 16</h2></html>";
    const transport = new QueueTransport([
      htmlResponse(partial),
      htmlResponse(complete),
    ]);
    const client = new AmcClient({ transport, cookieHeader: "session=opaque" });

    const showtimes = await client.getShowtimes({
      venue: EXAMPLE_VENUE,
      date: "2030-01-15",
      movie: "example epic",
    });

    expect(showtimes.some((showtime) => showtime.id === "900000004")).toBe(
      true,
    );
    expect(transport.sent).toHaveLength(2);
  });

  it("classifies an auto-followed Queue-it return by its accepted-cookie evidence", async () => {
    const response = htmlResponse("");
    response.status = 302;
    response.headers = {
      location:
        "https://www.amctheatres.com/movie-theatres/san-francisco/amc-metreon-16/showtimes",
    };
    response.setCookieNames = [
      "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb",
    ];
    response.setCookies = [
      "QueueITAccepted-SDFrts345E-V3_globalsafetynetweb=opaque; Domain=.amctheatres.com; Path=/",
    ];
    const client = new AmcClient({
      transport: new QueueTransport([response]),
      cookieHeader: "session=opaque",
      accessCheckPath: EXAMPLE_VENUE.path,
    });

    await expect(client.checkAccess()).rejects.toBeInstanceOf(
      AmcChallengeError,
    );
  });

  it("classifies provider challenges distinctly while leaving generic 429 non-auth", async () => {
    const challenged = new AmcClient({
      transport: new QueueTransport([
        {
          ...htmlResponse("<title>Waiting Room powered by Queue-it</title>"),
          status: 429,
        },
      ]),
      cookieHeader: "session=opaque",
    });
    await expect(
      challenged.getShowtimes({ venue: EXAMPLE_VENUE, date: "2030-01-15" }),
    ).rejects.toMatchObject({
      name: "Error",
      code: "AMC_CHALLENGE",
      message: expect.stringContaining("Queue-it/Cloudflare challenge"),
    } satisfies Partial<AmcChallengeError>);

    const limited = new AmcClient({
      transport: new QueueTransport([
        {
          ...htmlResponse("rate limit"),
          status: 429,
          headers: {
            "content-type": "text/html; charset=utf-8",
            server: "cloudflare",
            "cf-ray": "ordinary-edge-request",
          },
        },
      ]),
      cookieHeader: "session=opaque",
    });
    await expect(
      limited.getShowtimes({ venue: EXAMPLE_VENUE, date: "2030-01-15" }),
    ).rejects.toBeInstanceOf(AmcHttpError);
  });
});

function htmlResponse(bodyText: string): ResponseOutput {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    bodyText,
    timingMs: 10,
    transport: "recording",
    setCookieNames: [],
    setCookies: [],
  };
}
