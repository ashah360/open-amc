import { describe, expect, it, vi } from "vitest";
import {
  BRAINTREE_TOKENIZE_CREDIT_CARD_DOCUMENT,
  BraintreeClientTokenProvider,
  BraintreeHttpRequest,
  DeviceDataProvider,
  DirectBraintreeTokenizer,
  DirectBraintreeTokenizerPaymentExecutor,
  DirectOrderFulfillProvider,
  DirectPaymentContractError,
  FraudContextRequiredOutcome,
  FraudContextRequiredError,
  HttpTransport,
  KountSessionProvider,
  SecretCardLease,
  SecretCardProvider,
  TransientPaymentMaterial,
} from "../src/commerce/direct-braintree-tokenizer";
import {
  AmbiguousWriteError,
  EphemeralCardHandle,
  EphemeralPaymentHandle,
  PaymentExecutor,
  PaymentSecurityChallengeError,
  PurchaseNotCompletedError,
  PurchaseResult,
} from "../src/commerce/executor";
import { AmcGraphqlResponseError } from "../src/commerce/contracts";

const ORDER_TOKEN = "00000000-0000-4000-8000-000000000003";
const KOUNT_SESSION = "00000000000040008000000000000003";

describe("DirectBraintreeTokenizer", () => {
  it("sends the exact Braintree Web 3.143.0 request and returns transient material", async () => {
    const fixture = setup();
    const result = await fixture.tokenizer.tokenize({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });

    expect(result).toBeInstanceOf(TransientPaymentMaterial);
    expect(fixture.http.calls).toBe(1);
    expect(fixture.http.request).toMatchObject({
      url: "https://payments.braintree-api.com/graphql",
      method: "POST",
      headers: {
        Authorization: "Bearer authorization-fingerprint",
        "Braintree-Version": "2018-05-10",
        "Content-Type": "application/json",
        Origin: "https://www.amctheatres.com",
        Referer: "https://www.amctheatres.com/",
      },
    });
    expect(fixture.http.body).toEqual({
      clientSdkMetadata: {
        source: "client",
        integration: "custom",
        sessionId: "fresh-session-1",
      },
      operationName: "TokenizeCreditCard",
      query: BRAINTREE_TOKENIZE_CREDIT_CARD_DOCUMENT,
      variables: {
        input: {
          creditCard: {
            number: "4111111111111111",
            expirationMonth: "12",
            expirationYear: "2030",
            cvv: "123",
            cardholderName: "",
            billingAddress: {
              firstName: "",
              lastName: "",
              streetAddress: "",
              extendedAddress: "",
              locality: "",
              region: "",
              postalCode: "94103",
              countryCodeAlpha3: "USA",
            },
          },
          options: { validate: false },
        },
      },
    });
    expect(fixture.device.input?.sessionId).toBe("fresh-session-1");
    expect(fixture.kount.input).toEqual({
      orderToken: ORDER_TOKEN,
      sessionId: KOUNT_SESSION,
    });
    expect(fixture.cards.disposals).toBe(1);

    const material = result as TransientPaymentMaterial;
    expect(material.inspect()).toEqual({
      kind: "direct-braintree-payment",
      fraudContext: "ready",
      card: { brandCode: "VISA", last4: "••••1111", expiration: "12/2030" },
      consumed: false,
    });
    await expect(
      material.consumeWith(async (secret) => ({
        nonce: secret.nonce,
        deviceData: secret.deviceData,
        postalCode: secret.postalCode,
      })),
    ).resolves.toEqual({
      nonce: "synthetic-nonce",
      deviceData: '{"correlation_id":"fresh-fraudnet-1"}',
      postalCode: "94103",
    });
    expect(material.inspect().consumed).toBe(true);
  });

  it("hands the short-lived Braintree client-token authorization to device-data collection", async () => {
    const clientToken = encodeToken("authorization-fingerprint");
    const fixture = setup({ clientToken });

    await fixture.tokenizer.tokenize({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });

    expect(fixture.device.authorizations).toEqual([clientToken]);
    expect(fixture.device.input?.orderToken).toBe(ORDER_TOKEN);
  });

  it("sends the cardholder name and the real billing postal code in the tokenization payload", async () => {
    const fixture = setup({
      cardholderName: "Ada Lovelace",
      postalCode: "10001",
    });

    await fixture.tokenizer.tokenize({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });

    const body = fixture.http.body as {
      variables: {
        input: {
          creditCard: {
            cardholderName: string;
            billingAddress: { postalCode: string; countryCodeAlpha3: string };
          };
        };
      };
    };
    expect(body.variables.input.creditCard.cardholderName).toBe("Ada Lovelace");
    expect(body.variables.input.creditCard.billingAddress.postalCode).toBe(
      "10001",
    );
    expect(
      body.variables.input.creditCard.billingAddress.countryCodeAlpha3,
    ).toBe("USA");
  });

  it("uses a fresh per-attempt session ID", async () => {
    const fixture = setup({
      sessionIds: ["fresh-session-1", "fresh-session-2"],
    });
    await fixture.tokenizer.tokenize({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });
    fixture.device.deviceData = '{"correlation_id":"fresh-fraudnet-2"}';
    await fixture.tokenizer.tokenize({
      orderToken: `${ORDER_TOKEN}-2`,
      vaultPointer: "vault://synthetic-card",
    });

    expect(fixture.device.sessionIds).toEqual([
      "fresh-session-1",
      "fresh-session-2",
    ]);
  });

  it("rejects malformed client tokens before card access", async () => {
    const fixture = setup({ clientToken: "not-base64-json" });

    await expect(
      fixture.tokenizer.tokenize({
        orderToken: ORDER_TOKEN,
        vaultPointer: "vault://synthetic-card",
      }),
    ).rejects.toBeInstanceOf(DirectPaymentContractError);
    expect(fixture.cards.calls).toBe(0);
    expect(fixture.http.calls).toBe(0);
  });

  it("fails closed on HTTP 200 GraphQL errors", async () => {
    const fixture = setup({
      response: {
        status: 200,
        bodyText: JSON.stringify({
          data: null,
          errors: [{ message: "synthetic failure" }],
        }),
      },
    });

    await expect(
      fixture.tokenizer.tokenize({
        orderToken: ORDER_TOKEN,
        vaultPointer: "vault://synthetic-card",
      }),
    ).rejects.toBeInstanceOf(DirectPaymentContractError);
    expect(fixture.http.calls).toBe(1);
    expect(fixture.cards.disposals).toBe(1);
  });

  it("does not retry transport failure or expose secret strings", async () => {
    const fixture = setup({
      transportError: new Error("failed 4111111111111111"),
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const failure = await fixture.tokenizer
        .tokenize({
          orderToken: ORDER_TOKEN,
          vaultPointer: "vault://synthetic-card",
        })
        .catch((error: unknown) => error);

      expect(fixture.http.calls).toBe(1);
      expect(String(failure)).not.toContain("4111111111111111");
      expect(log).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      errorLog.mockRestore();
    }
  });

  it.each([
    ["missing device data", { deviceData: null }],
    ["stale device data", { deviceFresh: false }],
    ["missing Kount", { kountInitialized: false }],
    ["wrong Kount ID", { kountSessionId: "wrong" }],
  ])("returns typed fraud-context-required for %s", async (_name, options) => {
    const fixture = setup(options);
    const result = await fixture.tokenizer.tokenize({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });

    expect(result).toBeInstanceOf(FraudContextRequiredOutcome);
    expect(result.inspect()).toEqual({
      kind: "direct-braintree-unavailable",
      reason: "fraud-context-required",
    });
    expect(fixture.cards.calls).toBe(0);
    expect(fixture.http.calls).toBe(0);
  });

  it.each([
    ["missing FraudNet", { deviceData: null }],
    ["stale FraudNet", { deviceFresh: false }],
    ["missing Kount", { kountInitialized: false }],
    ["mismatched Kount", { kountSessionId: "wrong-session" }],
  ])(
    "refuses direct mode for %s without browser or card access",
    async (_name, options) => {
      const fixture = setup(options);
      const browser = new FakeBrowserPaymentExecutor();
      const executor = new DirectBraintreeTokenizerPaymentExecutor({
        tokenizer: fixture.tokenizer,
        orders: new FakeOrderFulfillProvider(),
      });
      const payment = await executor.secureFill({
        orderToken: ORDER_TOKEN,
        vaultPointer: "vault://synthetic-card",
      });

      await expect(
        executor.addCard({ orderToken: ORDER_TOKEN, payment }),
      ).rejects.toBeInstanceOf(FraudContextRequiredError);
      expect(browser.calls).toEqual([]);
      expect(fixture.cards.calls).toBe(0);
    },
  );

  it("never calls browser for tokenization or transport failures", async () => {
    const fixture = setup({
      transportError: new Error("synthetic transport failure"),
    });
    const browser = new FakeBrowserPaymentExecutor();
    const executor = new DirectBraintreeTokenizerPaymentExecutor({
      tokenizer: fixture.tokenizer,
      orders: new FakeOrderFulfillProvider(),
    });
    const payment = await executor.secureFill({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });

    await expect(
      executor.addCard({ orderToken: ORDER_TOKEN, payment }),
    ).rejects.toThrow(/tokenization/);
    expect(browser.calls).toEqual([]);
  });

  it("classifies an unrecognized post-dispatch fulfillment failure as ambiguous", async () => {
    const fixture = setup();
    const orders = new FakeOrderFulfillProvider();
    orders.fulfillError = new Error("projection drift after provider dispatch");
    const executor = new DirectBraintreeTokenizerPaymentExecutor({
      tokenizer: fixture.tokenizer,
      orders,
    });
    const payment = await executor.secureFill({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });
    const card = await executor.addCard({ orderToken: ORDER_TOKEN, payment });

    await expect(
      executor.purchase({
        orderToken: ORDER_TOKEN,
        email: "guest@example.test",
        expectedTotal: "55.56",
        card,
      }),
    ).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(orders.fulfillCalls).toBe(1);
  });

  it("classifies provider code 4342 as a definitive decline rather than ambiguous", async () => {
    const fixture = setup();
    const orders = new FakeOrderFulfillProvider();
    orders.fulfillError = new AmcGraphqlResponseError("OrderFulfill", [
      { path: ["orderFulfill"], extensions: { legacyCode: "4342" } },
    ]);
    const executor = new DirectBraintreeTokenizerPaymentExecutor({
      tokenizer: fixture.tokenizer,
      orders,
    });
    const payment = await executor.secureFill({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });
    const card = await executor.addCard({ orderToken: ORDER_TOKEN, payment });

    const failure = await executor
      .purchase({
        orderToken: ORDER_TOKEN,
        email: "guest@example.test",
        expectedTotal: "55.56",
        card,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PurchaseNotCompletedError);
    expect(failure).not.toBeInstanceOf(AmbiguousWriteError);
    expect(failure).toMatchObject({
      code: "AMC_PURCHASE_NOT_COMPLETED",
      providerStatus: "Declined",
      providerCode: 4342,
    });
    expect(orders.fulfillCalls).toBe(1);
  });

  it("surfaces a typed challenge without invoking browser or dispatching again", async () => {
    const fixture = setup();
    const browser = new FakeBrowserPaymentExecutor();
    const orders = new FakeOrderFulfillProvider();
    orders.fulfillError = new PaymentSecurityChallengeError();
    const executor = new DirectBraintreeTokenizerPaymentExecutor({
      tokenizer: fixture.tokenizer,
      orders,
    });
    const payment = await executor.secureFill({
      orderToken: ORDER_TOKEN,
      vaultPointer: "vault://synthetic-card",
    });
    const card = await executor.addCard({ orderToken: ORDER_TOKEN, payment });
    const challenge = await executor
      .purchase({
        orderToken: ORDER_TOKEN,
        email: "guest@example.test",
        expectedTotal: "55.56",
        card,
      })
      .catch((error: unknown) => error);

    expect(challenge).toBeInstanceOf(PaymentSecurityChallengeError);
    expect(challenge).toMatchObject({
      code: "AMC_PAYMENT_SECURITY_CHALLENGE",
      challengeContext: { opaque: expect.any(Symbol) },
    });
    expect(browser.calls).toEqual([]);
  });
});

function setup(
  options: {
    clientToken?: string;
    deviceData?: string | null;
    deviceFresh?: boolean;
    kountInitialized?: boolean;
    kountSessionId?: string;
    response?: { status: number; bodyText: string };
    transportError?: Error;
    sessionIds?: string[];
    cardholderName?: string;
    postalCode?: string;
  } = {},
) {
  const sessionIds = [...(options.sessionIds ?? ["fresh-session-1"])];
  const clientTokens = new FakeClientTokenProvider(
    options.clientToken ?? encodeToken("authorization-fingerprint"),
  );
  const device = new FakeDeviceDataProvider(
    options.deviceData === undefined
      ? '{"correlation_id":"fresh-fraudnet-1"}'
      : options.deviceData,
    options.deviceFresh ?? true,
  );
  const kount = new FakeKountSessionProvider(
    options.kountInitialized ?? true,
    options.kountSessionId,
  );
  const cards = new FakeSecretCardProvider(
    options.cardholderName,
    options.postalCode,
  );
  const http = new FakeHttpTransport(
    options.response ?? successfulResponse(),
    options.transportError,
  );
  return {
    clientTokens,
    device,
    kount,
    cards,
    http,
    tokenizer: new DirectBraintreeTokenizer({
      http,
      cards,
      clientTokens,
      deviceData: device,
      kount,
      createSessionId: () => sessionIds.shift() ?? "reused-session",
    }),
  };
}

class FakeClientTokenProvider implements BraintreeClientTokenProvider {
  constructor(private readonly token: string) {}
  getClientToken(): Promise<string> {
    return Promise.resolve(this.token);
  }
}

class FakeDeviceDataProvider implements DeviceDataProvider {
  input: { orderToken: string; sessionId: string } | null = null;
  sessionIds: string[] = [];
  authorizations: Array<string | undefined> = [];

  constructor(
    public deviceData: string | null,
    private readonly fresh: boolean,
  ) {}

  collect(input: {
    orderToken: string;
    sessionId: string;
    authorization?: string;
  }): Promise<{ deviceData: string | null; fresh: boolean }> {
    this.input = input;
    this.sessionIds.push(input.sessionId);
    this.authorizations.push(input.authorization);
    return Promise.resolve({ deviceData: this.deviceData, fresh: this.fresh });
  }
}

class FakeKountSessionProvider implements KountSessionProvider {
  input: { orderToken: string; sessionId: string } | null = null;

  constructor(
    private readonly initialized: boolean,
    private readonly sessionId?: string,
  ) {}

  initialize(input: {
    orderToken: string;
    sessionId: string;
  }): Promise<{ initialized: boolean; sessionId: string }> {
    this.input = input;
    return Promise.resolve({
      initialized: this.initialized,
      sessionId: this.sessionId ?? input.sessionId,
    });
  }
}

class FakeSecretCardProvider implements SecretCardProvider {
  calls = 0;
  disposals = 0;

  constructor(
    private readonly cardholderName?: string,
    private readonly postalCode = "94103",
  ) {}

  getCard(): Promise<SecretCardLease> {
    this.calls += 1;
    return Promise.resolve({
      card: {
        number: "4111111111111111",
        expirationMonth: "12",
        expirationYear: "2030",
        cvv: "123",
        postalCode: this.postalCode,
        ...(this.cardholderName === undefined
          ? {}
          : { cardholderName: this.cardholderName }),
      },
      dispose: () => {
        this.disposals += 1;
      },
    });
  }
}

class FakeHttpTransport implements HttpTransport {
  calls = 0;
  request: Omit<BraintreeHttpRequest, "body"> | null = null;
  body: unknown;

  constructor(
    private readonly response: { status: number; bodyText: string },
    private readonly failure?: Error,
  ) {}

  post(
    request: BraintreeHttpRequest,
  ): Promise<{ status: number; bodyText: string }> {
    this.calls += 1;
    this.request = {
      url: request.url,
      method: request.method,
      headers: { ...request.headers },
    };
    this.body = JSON.parse(request.body);
    return this.failure
      ? Promise.reject(this.failure)
      : Promise.resolve(this.response);
  }
}

class FakeOrderFulfillProvider implements DirectOrderFulfillProvider {
  fulfillError: Error | null = null;
  fulfillCalls = 0;

  fulfill(input: {
    token: string;
    expectedTotal: `${number}.${number}`;
  }): Promise<PurchaseResult> {
    this.fulfillCalls += 1;
    if (this.fulfillError) return Promise.reject(this.fulfillError);
    return Promise.resolve({
      orderToken: input.token,
      confirmationNumber: "0000000001",
      chargedTotal: input.expectedTotal,
      status: "CONFIRMED",
    });
  }

  reconcilePurchase(): Promise<PurchaseResult | null> {
    return Promise.resolve(null);
  }
}

class FakeBrowserPaymentExecutor implements PaymentExecutor {
  calls: string[] = [];

  secureFill(): Promise<EphemeralPaymentHandle> {
    this.calls.push("secure-fill");
    return Promise.resolve({ opaque: Symbol("browser-payment") });
  }

  addCard(): Promise<EphemeralCardHandle> {
    this.calls.push("add-card");
    return Promise.resolve({ opaque: Symbol("browser-card") });
  }

  purchase(input: { orderToken: string }): Promise<PurchaseResult> {
    this.calls.push("purchase");
    return Promise.resolve({
      orderToken: input.orderToken,
      confirmationNumber: "0000000001",
      chargedTotal: "55.56",
      status: "CONFIRMED",
    });
  }

  reconcilePurchase(): Promise<PurchaseResult | null> {
    this.calls.push("reconcile");
    return Promise.resolve(null);
  }
}

function encodeToken(authorizationFingerprint: string): string {
  return Buffer.from(JSON.stringify({ authorizationFingerprint })).toString(
    "base64",
  );
}

function successfulResponse(): { status: number; bodyText: string } {
  return {
    status: 200,
    bodyText: JSON.stringify({
      data: {
        tokenizeCreditCard: {
          token: "synthetic-nonce",
          creditCard: {
            bin: "411111",
            brandCode: "VISA",
            last4: "1111",
            cardholderName: "",
            expirationMonth: "12",
            expirationYear: "2030",
            binData: {
              prepaid: "NO",
              healthcare: "UNKNOWN",
              debit: "NO",
              durbinRegulated: "NO",
              commercial: "NO",
              payroll: "NO",
              issuingBank: "TEST BANK",
              countryOfIssuance: "USA",
              productId: "TEST",
              business: "UNKNOWN",
              consumer: "YES",
              purchase: "UNKNOWN",
              corporate: "UNKNOWN",
            },
          },
        },
      },
    }),
  };
}
