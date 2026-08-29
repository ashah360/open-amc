import { describe, expect, it } from "vitest";
import {
  AmcGraphqlResponseError,
  parseOrderFulfillResponse,
} from "../src/commerce/contracts";

function capture(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error: unknown) {
    return error;
  }
}

describe("AmcGraphqlResponseError", () => {
  it("captures GraphQL errors structurally while dropping raw provider detail", () => {
    const failure = capture(() =>
      parseOrderFulfillResponse({
        data: null,
        errors: [
          {
            message:
              "Declined for guest@example.test using card 4111111111111111",
            path: ["orderFulfill", "order"],
            extensions: {
              legacyCode: "4342",
              classification: "ValidationError",
              customerEmail: "guest@example.test",
            },
          },
        ],
      }),
    );

    expect(failure).toBeInstanceOf(AmcGraphqlResponseError);
    const error = failure as AmcGraphqlResponseError;
    expect(error.operation).toBe("OrderFulfill");
    expect(error.message).toMatch(/GraphQL errors/);

    const serialized = [
      String(error),
      error.message,
      JSON.stringify(error.errors),
      JSON.stringify(error.providerCodes),
    ].join("|");
    expect(serialized).not.toContain("guest@example.test");
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("Declined for");

    expect(error.providerCodes).toEqual([4342]);
    expect(error.errors[0]?.classification).toBe("ValidationError");
    expect(error.errors[0]?.path).toEqual(["orderFulfill", "order"]);
    expect(error.errors[0]?.codes).toEqual([4342]);
  });

  it("exposes hasProviderCode for definitive decline classification", () => {
    const failure = capture(() =>
      parseOrderFulfillResponse({
        errors: [{ extensions: { legacyCode: "4342" } }],
      }),
    ) as AmcGraphqlResponseError;

    expect(failure).toBeInstanceOf(AmcGraphqlResponseError);
    expect(failure.hasProviderCode(4342)).toBe(true);
    expect(failure.hasProviderCode(2000)).toBe(false);
  });
});
