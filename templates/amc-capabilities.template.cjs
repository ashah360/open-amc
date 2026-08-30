"use strict";
/**
 * SYNTHETIC capability-module template for the `amc` CLI.
 *
 * Point AMC_CAPABILITY_MODULE at a copy of this file to wire optional
 * operational capabilities. The template is intentionally NONFUNCTIONAL for
 * payment: it fails closed until you implement a real, secret-manager-backed
 * CardProvider below. It contains no card values, no personal identity, and no
 * live provider identifiers, and it does not require any specific secret
 * manager — any vault (OS keychain, cloud secret manager, encrypted file you
 * control, a password manager CLI, ...) works behind the same seam.
 *
 * The CLI contract: this module must export a no-argument
 * `createAmcCapabilities()` factory. The CLI never passes secrets in; the
 * module reads its own configuration.
 *
 * Note: `amc auth repair --listing-url <official AMC theater URL>` already
 * ships built-in browser repair, so most users need NO module for repair.
 * Provide `browserRepair` here only to customize the adapter.
 *
 * Install requirements when you opt in to agent-paid checkout: the optional
 * Playwright FraudNet collector needs both optional peers installed next to
 * the package (`npm install playwright-core braintree-web@3.144.0`). Neither
 * is required for reads, cart holds, human handoff, or auth repair via the
 * pinned installer (which installs playwright-core for you).
 */

exports.createAmcCapabilities = function createAmcCapabilities() {
  return {
    /**
     * Payment seam. `getCard` receives an opaque vault pointer (whatever you
     * pass to `--vault`, e.g. "vault://personal-visa") plus the order token,
     * and must return a short-lived lease over the raw card material fetched
     * from YOUR secret manager. Raw card values must never be hardcoded here,
     * logged, or written to disk.
     */
    cardProvider: {
      async getCard(_vaultPointer, _orderToken) {
        // Fail closed until a real vault adapter is implemented, e.g.:
        //
        //   const card = await mySecretManager.read(_vaultPointer);
        //   let disposed = false;
        //   return {
        //     card: {
        //       number: card.number,
        //       expirationMonth: card.expirationMonth, // "01".."12"
        //       expirationYear: card.expirationYear,   // "2030"
        //       cvv: card.cvv,
        //       postalCode: card.postalCode,
        //     },
        //     dispose() { disposed = true; /* zero buffers if you can */ },
        //   };
        throw new Error(
          "cardProvider is not configured: implement getCard() against your own secret manager before any payment is possible",
        );
      },
    },

    // Optional: custom browser repair (the built-in `auth repair
    // --listing-url` path is usually enough). Example wiring:
    //
    //   const {
    //     PlaywrightBrowserRuntime,
    //     PlaywrightAmcBrowserRefresher,
    //   } = require("@ashah360/open-amc/playwright");
    //   browserRepair: new PlaywrightAmcBrowserRefresher({
    //     runtime: new PlaywrightBrowserRuntime({
    //       kind: "launch",
    //       channel: "chrome", // an installed Chrome; nothing is downloaded
    //       headless: false,
    //     }),
    //     listingUrl:
    //       "https://www.amctheatres.com/movie-theatres/<market>/<amc-theatre>/showtimes",
    //   }),

    // Optional one-time defaults: with both configured,
    // `amc checkout submit --token <orderToken>` is sufficient. Each remains
    // overridable per command with --email / --vault.
    //   defaultReceiptEmail: "guest@example.test",
    //   defaultVaultPointer: "vault://your-card-alias",
  };
};
