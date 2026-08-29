import { describe, expect, it } from "vitest";
import {
  amcCheckoutUrl,
  InvalidOrderTokenError,
} from "../src/commerce/handoff";

describe("first-party checkout URL helper", () => {
  it("builds the live-proven first-party purchase URL from an order token", () => {
    expect(amcCheckoutUrl("synthetic-order-token")).toBe(
      "https://www.amctheatres.com/orders/synthetic-order-token/purchase",
    );
  });

  it("rejects hostile or malformed tokens instead of building a URL", () => {
    for (const bad of [
      "",
      " ",
      "tok/../../admin",
      "tok?x=1",
      "tok#frag",
      "tok en",
      "a\nb",
      "https://evil.example/",
    ]) {
      expect(() => amcCheckoutUrl(bad)).toThrow(InvalidOrderTokenError);
    }
  });

  it("rejects pure-punctuation tokens that URL-normalize into other paths", () => {
    // "." and ".." are valid characters per the opaque-token alphabet but a
    // browser normalizes /orders/../purchase away from the intended resource.
    for (const bad of [".", "..", "...", "-", "~", "._~-", "--.."]) {
      expect(() => amcCheckoutUrl(bad)).toThrow(InvalidOrderTokenError);
    }
    // Punctuation remains allowed once at least one alphanumeric is present.
    expect(amcCheckoutUrl("a.b~c-d_e")).toBe(
      "https://www.amctheatres.com/orders/a.b~c-d_e/purchase",
    );
    expect(amcCheckoutUrl("..a")).toBe(
      "https://www.amctheatres.com/orders/..a/purchase",
    );
  });
});

describe("handoff module exposes no synthetic approval/quote hash helpers", () => {
  it("exports only the checkout URL surface", async () => {
    const surface = await import("../src/commerce/handoff");
    expect(Object.keys(surface).sort()).toEqual([
      "AMC_CHECKOUT_URL_BASE",
      "InvalidOrderTokenError",
      "amcCheckoutUrl",
    ]);
  });
});
