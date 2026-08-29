/**
 * Local, deterministic resolution of an official amctheatres.com theater URL
 * into a typed venue descriptor. Everything returned here is derived only from
 * facts truly encoded in the URL (market, slug, canonical listing path); no
 * network read happens and no internal identifier is invented. GraphQL
 * showtime reads key on the slug, so the descriptor is directly usable as a
 * showtimes query venue.
 */

export class AmcTheaterUrlError extends Error {
  readonly code = "AMC_THEATER_URL";
}

export interface ResolvedAmcTheater {
  kind: "amc-theater";
  /** GraphQL theatre slug encoded in the URL, e.g. "amc-empire-25". */
  slug: string;
  /** Market segment encoded in the URL, e.g. "new-york-city". */
  market: string;
  /** Display name derived from the slug, e.g. "AMC Empire 25". */
  name: string;
  /** Canonical SSR listing path. */
  path: string;
  /** Canonical listing URL. */
  url: string;
}

// Exact-origin allowlist. Matching is on the full hostname, never a suffix, so
// lookalikes (amctheatres.com.evil.example, evil-amctheatres.com) are rejected.
const ALLOWED_HOSTS = new Set(["www.amctheatres.com", "amctheatres.com"]);

const THEATER_PATH =
  /^\/movie-theatres\/([a-z0-9][a-z0-9-]*)\/(amc-[a-z0-9][a-z0-9-]*)(?:\/showtimes(?:\/[a-z0-9-]+)*)?\/?$/;

export function resolveOfficialAmcTheaterUrl(raw: string): ResolvedAmcTheater {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AmcTheaterUrlError(
      "theater URL must be an absolute https://www.amctheatres.com URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new AmcTheaterUrlError("theater URL must use https");
  }
  if (url.username || url.password || url.port) {
    throw new AmcTheaterUrlError(
      "theater URL must not carry credentials or a custom port",
    );
  }
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new AmcTheaterUrlError(
      "theater URL host is not the official amctheatres.com origin",
    );
  }
  const match = THEATER_PATH.exec(url.pathname.toLowerCase());
  if (!match) {
    throw new AmcTheaterUrlError(
      "theater URL path is not a supported /movie-theatres/<market>/<amc-...>/showtimes shape",
    );
  }
  const market = match[1]!;
  const slug = match[2]!;
  const path = `/movie-theatres/${market}/${slug}/showtimes`;
  return {
    kind: "amc-theater",
    slug,
    market,
    name: displayNameFromSlug(slug),
    path,
    url: `https://www.amctheatres.com${path}`,
  };
}

function displayNameFromSlug(slug: string): string {
  return slug
    .split("-")
    .map((segment) =>
      segment === "amc"
        ? "AMC"
        : segment.charAt(0).toUpperCase() + segment.slice(1),
    )
    .join(" ");
}
