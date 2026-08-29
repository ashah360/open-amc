export const SYNTHETIC_PRIMARY_SHOWTIME_ID = "900000004";
export const SYNTHETIC_SECONDARY_SHOWTIME_ID = "900000001";
export const SYNTHETIC_ALT_SHOWTIME_ID = "900000005";

export function syntheticListingHtml(): string {
  return `<!doctype html><html><body>
    <section id="movie-80001" aria-label="Showtimes for Example Epic">
      <h2>AMC Metreon 16</h2>
      <li role="listitem" aria-label="IMAX 70MM Showtimes">
        <a href="/showtimes/${SYNTHETIC_PRIMARY_SHOWTIME_ID}">
          <time datetime="2030-01-16T06:00:00.000Z">10:00 PM</time>
          <span class="sr-only">AlmostFull</span>
        </a>
      </li>
    </section>
    <section id="movie-80002" aria-label="Showtimes for Example Feature">
      <h2>AMC Metreon 16</h2>
      <li role="listitem" aria-label="Dolby Cinema at AMC Showtimes">
        <a href="/showtimes/${SYNTHETIC_ALT_SHOWTIME_ID}">
          <time datetime="2030-01-16T03:00:00.000Z">7:00 PM</time>
          <span class="sr-only">Sellable</span>
        </a>
      </li>
    </section>
  </body></html>`;
}

export function syntheticSeatHtml(
  options: { columns?: number; rows?: number } = {},
): string {
  const columns = options.columns ?? 7;
  const rows = options.rows ?? 4;
  const seats = [];
  for (let row = 1; row <= rows; row++) {
    for (let column = 1; column <= columns; column++) {
      const primary = columns === 7 && rows === 4;
      const isB6 = primary && row === 2 && column === 6;
      const isC2 = primary && row === 3 && column === 2;
      const isA4 = primary && row === 1 && column === 4;
      const visible = isB6 || isC2 || isA4 || !primary;
      seats.push({
        available: isB6 || isC2 || (!primary && row === 2 && column === 2),
        column,
        row,
        name: isB6
          ? "B6"
          : isC2
            ? "C2"
            : isA4
              ? "A4"
              : visible
                ? `R${row}C${column}`
                : "",
        type: visible ? "CanReserve" : "NotASeat",
        seatTier: "Regular",
        shouldDisplay: visible,
      });
    }
  }
  const layout = { columns, rows, seats };
  const prices = [
    {
      sku: "TICKET-SYNTHETIC-ADULT",
      type: "Adult",
      price: 20.0,
      convenienceFee: 2.5,
      tax: 0,
    },
  ];
  const chunk = (payload: string) =>
    `<script>self.__next_f.push(${JSON.stringify([1, payload])})</script>`;
  return [
    chunk(`prefix{"seatingLayout":${JSON.stringify(layout)}}suffix`),
    chunk(`prefix "prices":${JSON.stringify(prices)} suffix`),
  ].join("");
}

export function fixture(name: string): string {
  if (name.startsWith("metreon-")) return syntheticListingHtml();
  if (name.startsWith("seat-")) return syntheticSeatHtml();
  throw new Error(`unknown synthetic fixture: ${name}`);
}
