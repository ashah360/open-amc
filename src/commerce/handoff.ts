/**
 * The single canonical shape of the first-party AMC checkout continuation URL:
 * `https://www.amctheatres.com/orders/<orderToken>/purchase`.
 *
 * Provenance: this exact path is live-proven by the existing production cart
 * handoff flow that predates this repository; no live call is made here to
 * re-derive it. Every checkout URL the CLI or library emits is derived in
 * this one helper so any future provider path change is a one-line fix. The
 * resulting URL is bearer-like: whoever holds it can act on the open cart, so
 * it is returned only to the invoking caller and never logged implicitly.
 */
export const AMC_CHECKOUT_URL_BASE = "https://www.amctheatres.com/orders";

export class InvalidOrderTokenError extends Error {
  readonly code = "AMC_ORDER_TOKEN";
}

// Tokens are opaque but must be URL-safe path segments. Anything containing a
// separator, query, fragment, or whitespace character is rejected outright so
// a hostile token can never rewrite the URL we hand to a human. At least one
// alphanumeric is required: pure-punctuation values like "." or ".." are
// valid characters but URL-normalize into a different path entirely.
const ORDER_TOKEN_SHAPE = /^(?=[._~-]*[A-Za-z0-9])[A-Za-z0-9._~-]{1,512}$/;

/** Build the validated first-party checkout URL for a confirmed cart token. */
export function amcCheckoutUrl(orderToken: string): string {
  if (typeof orderToken !== "string" || !ORDER_TOKEN_SHAPE.test(orderToken)) {
    throw new InvalidOrderTokenError(
      "order token is not a safe AMC order token; refusing to build a checkout URL",
    );
  }
  return `${AMC_CHECKOUT_URL_BASE}/${orderToken}/purchase`;
}
