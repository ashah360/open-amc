import { randomUUID } from "node:crypto";
import { AmcGraphqlResponseError } from "./contracts";
import {
  AmbiguousWriteError,
  EphemeralCardHandle,
  EphemeralPaymentHandle,
  Money,
  PaymentExecutor,
  PaymentSecurityChallengeError,
  PurchaseNotCompletedError,
  PurchaseResult,
} from "./executor";

/**
 * Braintree/AMC gateway code for a definitive processor decline. A decline is a
 * conclusive "not purchased" outcome, so it must be classified as
 * PurchaseNotCompleted rather than treated as an ambiguous write.
 */
const PROVIDER_DECLINE_CODE = 4342;

export const BRAINTREE_TOKENIZE_CREDIT_CARD_DOCUMENT =
  "mutation TokenizeCreditCard($input: TokenizeCreditCardInput!" +
  ") { " +
  " tokenizeCreditCard(input: $input) { " +
  " token " +
  " creditCard { " +
  " bin " +
  " brandCode " +
  " last4 " +
  " cardholderName " +
  " expirationMonth" +
  " expirationYear" +
  " binData { " +
  " prepaid " +
  " healthcare " +
  " debit " +
  " durbinRegulated " +
  " commercial " +
  " payroll " +
  " issuingBank " +
  " countryOfIssuance " +
  " productId " +
  " business " +
  " consumer " +
  " purchase " +
  " corporate " +
  " } " +
  " } " +
  " } }";

const BRAINTREE_GRAPHQL_URL = "https://payments.braintree-api.com/graphql";
const BRAINTREE_VERSION = "2018-05-10";
const AMC_ORIGIN = "https://www.amctheatres.com";

export interface BraintreeHttpRequest {
  url: typeof BRAINTREE_GRAPHQL_URL;
  method: "POST";
  headers: {
    Authorization: string;
    "Braintree-Version": typeof BRAINTREE_VERSION;
    "Content-Type": "application/json";
    Origin: typeof AMC_ORIGIN;
    Referer: "https://www.amctheatres.com/";
  };
  body: string;
}

export interface HttpTransport {
  post(
    request: BraintreeHttpRequest,
  ): Promise<{ status: number; bodyText: string }>;
}

export class FetchHttpTransport implements HttpTransport {
  async post(
    request: BraintreeHttpRequest,
  ): Promise<{ status: number; bodyText: string }> {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      credentials: "omit",
      redirect: "error",
    });
    return { status: response.status, bodyText: await response.text() };
  }
}

export interface SecretCard {
  number: string;
  expirationMonth: string;
  expirationYear: string;
  cvv: string;
  postalCode: string;
  /** Optional cardholder name; forwarded verbatim to Braintree when present. */
  cardholderName?: string;
}

export interface SecretCardLease {
  readonly card: SecretCard;
  dispose(): void;
}

export interface SecretCardProvider {
  getCard(vaultPointer: string, orderToken?: string): Promise<SecretCardLease>;
}

export interface BraintreeClientTokenProvider {
  getClientToken(orderToken: string): Promise<string>;
}

export interface DeviceDataProvider {
  collect(input: {
    orderToken: string;
    sessionId: string;
    /**
     * Short-lived Braintree client-token authorization. It is handed to the
     * collector for the single collection call and must never be retained,
     * logged, or surfaced by the provider.
     */
    authorization?: string;
  }): Promise<{ deviceData: string | null; fresh: boolean }>;
}

export interface KountSessionProvider {
  initialize(input: {
    orderToken: string;
    sessionId: string;
  }): Promise<{ initialized: boolean; sessionId: string }>;
}

export class DirectPaymentContractError extends Error {
  readonly code = "AMC_DIRECT_PAYMENT_CONTRACT_ERROR";

  constructor(
    readonly stage:
      "session" | "client-token" | "card" | "tokenization" | "material",
  ) {
    super(`AMC direct payment contract failed (${stage})`);
  }
}

export class DirectPaymentExecutionError extends Error {
  readonly code = "AMC_DIRECT_PAYMENT_EXECUTION_FAILED";

  constructor(readonly stage: "authorization" | "card" | "tokenization") {
    super(`AMC direct payment execution failed (${stage})`);
  }
}

export class FraudContextRequiredOutcome {
  readonly reason = "fraud-context-required" as const;

  inspect(): {
    kind: "direct-braintree-unavailable";
    reason: "fraud-context-required";
  } {
    return {
      kind: "direct-braintree-unavailable",
      reason: this.reason,
    };
  }
}

interface MaterialSecret {
  nonce: string;
  deviceData: string;
  postalCode: string;
}

export class TransientPaymentMaterial {
  #nonce: string;
  #deviceData: string;
  #postalCode: string;
  #consumed = false;

  constructor(
    secret: MaterialSecret,
    private readonly verification: {
      brandCode: string;
      last4: string;
      expirationMonth: string;
      expirationYear: string;
    },
  ) {
    this.#nonce = secret.nonce;
    this.#deviceData = secret.deviceData;
    this.#postalCode = secret.postalCode;
  }

  inspect(): {
    kind: "direct-braintree-payment";
    fraudContext: "ready";
    card: { brandCode: string; last4: string; expiration: string };
    consumed: boolean;
  } {
    return {
      kind: "direct-braintree-payment",
      fraudContext: "ready",
      card: {
        brandCode: this.verification.brandCode,
        last4: `••••${this.verification.last4}`,
        expiration: `${this.verification.expirationMonth}/${this.verification.expirationYear}`,
      },
      consumed: this.#consumed,
    };
  }

  async consumeWith<T>(
    consumer: (secret: Readonly<MaterialSecret>) => Promise<T>,
  ): Promise<T> {
    if (this.#consumed) throw new DirectPaymentContractError("material");
    this.#consumed = true;
    const secret: MaterialSecret = {
      nonce: this.#nonce,
      deviceData: this.#deviceData,
      postalCode: this.#postalCode,
    };
    try {
      return await consumer(secret);
    } finally {
      secret.nonce = "";
      secret.deviceData = "";
      secret.postalCode = "";
      this.#nonce = "";
      this.#deviceData = "";
      this.#postalCode = "";
    }
  }
}

export interface DirectBraintreeTokenizerOptions {
  http?: HttpTransport;
  cards: SecretCardProvider;
  clientTokens: BraintreeClientTokenProvider;
  deviceData: DeviceDataProvider;
  kount: KountSessionProvider;
  createSessionId?: () => string;
}

export class DirectBraintreeTokenizer {
  private readonly http: HttpTransport;
  private readonly createSessionId: () => string;
  private readonly usedSessionIds = new Set<string>();
  private readonly usedCorrelationIds = new Set<string>();

  constructor(private readonly options: DirectBraintreeTokenizerOptions) {
    this.http = options.http ?? new FetchHttpTransport();
    this.createSessionId = options.createSessionId ?? randomUUID;
  }

  async tokenize(input: {
    orderToken: string;
    vaultPointer: string;
  }): Promise<TransientPaymentMaterial | FraudContextRequiredOutcome> {
    const sessionId = this.freshSessionId();
    let clientToken: string;
    try {
      clientToken = await this.options.clientTokens.getClientToken(
        input.orderToken,
      );
    } catch {
      throw new DirectPaymentExecutionError("authorization");
    }
    const authorizationFingerprint = parseAuthorizationFingerprint(clientToken);

    const expectedKountSessionId = input.orderToken.replace(
      /[^A-Za-z0-9]/g,
      "",
    );
    let device: { deviceData: string | null; fresh: boolean };
    let kount: { initialized: boolean; sessionId: string };
    try {
      device = await this.options.deviceData.collect({
        orderToken: input.orderToken,
        sessionId,
        authorization: clientToken,
      });
      kount = await this.options.kount.initialize({
        orderToken: input.orderToken,
        sessionId: expectedKountSessionId,
      });
    } catch {
      return new FraudContextRequiredOutcome();
    } finally {
      // The short-lived authorization is handed to collection once and never
      // retained on any exit path (success, risk-declined, or thrown).
      clientToken = "";
    }
    const correlation = device.deviceData
      ? correlationId(device.deviceData)
      : null;
    if (
      !device.fresh ||
      correlation === null ||
      this.usedCorrelationIds.has(correlation) ||
      !kount.initialized ||
      kount.sessionId !== expectedKountSessionId
    ) {
      return new FraudContextRequiredOutcome();
    }
    this.usedCorrelationIds.add(correlation);

    let lease: SecretCardLease;
    try {
      lease = await this.options.cards.getCard(
        input.vaultPointer,
        input.orderToken,
      );
    } catch {
      throw new DirectPaymentExecutionError("card");
    }
    if (!validCard(lease.card)) {
      safelyDispose(lease);
      throw new DirectPaymentContractError("card");
    }

    try {
      const tokenized = await this.tokenizeCard({
        authorizationFingerprint,
        sessionId,
        card: lease.card,
      });
      return new TransientPaymentMaterial(
        {
          nonce: tokenized.nonce,
          deviceData: device.deviceData!,
          postalCode: lease.card.postalCode,
        },
        tokenized.verification,
      );
    } finally {
      safelyDispose(lease);
    }
  }

  private freshSessionId(): string {
    const sessionId = this.createSessionId();
    if (!nonEmpty(sessionId) || this.usedSessionIds.has(sessionId)) {
      throw new DirectPaymentContractError("session");
    }
    this.usedSessionIds.add(sessionId);
    return sessionId;
  }

  private async tokenizeCard(input: {
    authorizationFingerprint: string;
    sessionId: string;
    card: SecretCard;
  }): Promise<{
    nonce: string;
    verification: {
      brandCode: string;
      last4: string;
      expirationMonth: string;
      expirationYear: string;
    };
  }> {
    const request: BraintreeHttpRequest = {
      url: BRAINTREE_GRAPHQL_URL,
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.authorizationFingerprint}`,
        "Braintree-Version": BRAINTREE_VERSION,
        "Content-Type": "application/json",
        Origin: AMC_ORIGIN,
        Referer: "https://www.amctheatres.com/",
      },
      body: JSON.stringify(tokenizationBody(input.card, input.sessionId)),
    };
    let response: { status: number; bodyText: string };
    try {
      response = await this.http.post(request);
    } catch {
      throw new DirectPaymentExecutionError("tokenization");
    } finally {
      request.body = "";
    }
    return parseTokenizationResponse(response, input.card);
  }
}

export interface DirectOrderFulfillProvider {
  fulfill(input: {
    token: string;
    email: string;
    paymentMethodType: "creditCard";
    nonce: string;
    postalCode: string;
    deviceData: string;
    expectedTotal: Money;
  }): Promise<PurchaseResult>;
  reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null>;
}

export class FraudContextRequiredError extends Error {
  readonly code = "AMC_FRAUD_CONTEXT_REQUIRED";
  readonly reason = "fraud-context-required" as const;

  constructor() {
    super("AMC direct payment requires fresh FraudNet and Kount context");
  }
}

export class DirectOrderFulfillError extends Error {
  readonly code = "AMC_DIRECT_ORDER_FULFILL_FAILED";

  constructor() {
    super("AMC direct order fulfillment failed");
  }
}

type PendingPaymentState = {
  orderToken: string;
  vaultPointer: string;
};

type PendingCardState = {
  orderToken: string;
  material: TransientPaymentMaterial;
  vaultPointer: string;
};

export interface DirectBraintreeTokenizerPaymentExecutorOptions {
  tokenizer: DirectBraintreeTokenizer;
  orders: DirectOrderFulfillProvider;
}

/**
 * PaymentExecutor wiring for the tokenizer. Direct mode fails closed on risk,
 * contract, transport, and challenge errors. Interactive challenge execution
 * is deliberately owned by the service's separately confirmed resume flow.
 */
export class DirectBraintreeTokenizerPaymentExecutor implements PaymentExecutor {
  private readonly paymentStates = new WeakMap<
    EphemeralPaymentHandle,
    PendingPaymentState
  >();
  private readonly cardStates = new WeakMap<
    EphemeralCardHandle,
    PendingCardState
  >();

  constructor(
    private readonly options: DirectBraintreeTokenizerPaymentExecutorOptions,
  ) {}

  async secureFill(input: {
    orderToken: string;
    vaultPointer: string;
  }): Promise<EphemeralPaymentHandle> {
    const handle: EphemeralPaymentHandle = { opaque: Symbol("payment") };
    this.paymentStates.set(handle, {
      orderToken: input.orderToken,
      vaultPointer: input.vaultPointer,
    });
    return handle;
  }

  async addCard(input: {
    orderToken: string;
    payment: EphemeralPaymentHandle;
  }): Promise<EphemeralCardHandle> {
    const state = this.paymentStates.get(input.payment);
    this.paymentStates.delete(input.payment);
    if (!state || state.orderToken !== input.orderToken) {
      throw new DirectPaymentContractError("material");
    }
    const vaultPointer = state.vaultPointer;
    const result = await this.options.tokenizer.tokenize({
      orderToken: input.orderToken,
      vaultPointer,
    });
    state.vaultPointer = "";
    if (result instanceof FraudContextRequiredOutcome) {
      throw new FraudContextRequiredError();
    }

    const handle: EphemeralCardHandle = { opaque: Symbol("direct-card") };
    this.cardStates.set(handle, {
      orderToken: input.orderToken,
      material: result,
      vaultPointer,
    });
    return handle;
  }

  async purchase(input: {
    orderToken: string;
    email: string;
    expectedTotal: Money;
    card: EphemeralCardHandle;
  }): Promise<PurchaseResult> {
    const state = this.cardStates.get(input.card);
    this.cardStates.delete(input.card);
    if (!state || state.orderToken !== input.orderToken) {
      throw new DirectPaymentContractError("material");
    }
    try {
      const result = await state.material.consumeWith((secret) =>
        this.options.orders.fulfill({
          token: input.orderToken,
          email: input.email,
          paymentMethodType: "creditCard",
          nonce: secret.nonce,
          postalCode: secret.postalCode,
          deviceData: secret.deviceData,
          expectedTotal: input.expectedTotal,
        }),
      );
      return result;
    } catch (error) {
      if (error instanceof PaymentSecurityChallengeError) {
        throw new PaymentSecurityChallengeError({
          opaque: Symbol("payment-challenge"),
        });
      }
      if (
        error instanceof AmcGraphqlResponseError &&
        error.hasProviderCode(PROVIDER_DECLINE_CODE)
      ) {
        throw new PurchaseNotCompletedError("Declined", PROVIDER_DECLINE_CODE);
      }
      if (error instanceof PurchaseNotCompletedError) throw error;
      if (error instanceof AmbiguousWriteError) throw error;
      throw new AmbiguousWriteError("purchase");
    } finally {
      state.vaultPointer = "";
    }
  }

  async reconcilePurchase(
    orderToken: string,
    email: string,
  ): Promise<PurchaseResult | null> {
    return this.options.orders.reconcilePurchase(orderToken, email);
  }
}

function tokenizationBody(card: SecretCard, sessionId: string): unknown {
  return {
    clientSdkMetadata: {
      source: "client",
      integration: "custom",
      sessionId,
    },
    operationName: "TokenizeCreditCard",
    query: BRAINTREE_TOKENIZE_CREDIT_CARD_DOCUMENT,
    variables: {
      input: {
        creditCard: {
          number: card.number,
          expirationMonth: card.expirationMonth,
          expirationYear: card.expirationYear,
          cvv: card.cvv,
          cardholderName: card.cardholderName ?? "",
          billingAddress: {
            firstName: "",
            lastName: "",
            streetAddress: "",
            extendedAddress: "",
            locality: "",
            region: "",
            postalCode: card.postalCode,
            countryCodeAlpha3: "USA",
          },
        },
        options: { validate: false },
      },
    },
  };
}

function parseAuthorizationFingerprint(clientToken: string): string {
  if (
    typeof clientToken !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(clientToken) ||
    clientToken.length % 4 !== 0
  ) {
    throw new DirectPaymentContractError("client-token");
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(clientToken, "base64").toString("utf8"),
    );
    if (!isRecord(decoded) || !nonEmpty(decoded.authorizationFingerprint)) {
      throw new Error("invalid");
    }
    return decoded.authorizationFingerprint;
  } catch {
    throw new DirectPaymentContractError("client-token");
  }
}

function parseTokenizationResponse(
  response: { status: number; bodyText: string },
  card: SecretCard,
): {
  nonce: string;
  verification: {
    brandCode: string;
    last4: string;
    expirationMonth: string;
    expirationYear: string;
  };
} {
  if (response.status !== 200)
    throw new DirectPaymentContractError("tokenization");
  let body: unknown;
  try {
    body = JSON.parse(response.bodyText);
  } catch {
    throw new DirectPaymentContractError("tokenization");
  }
  if (
    !isRecord(body) ||
    (Object.prototype.hasOwnProperty.call(body, "errors") &&
      (!Array.isArray(body.errors) || body.errors.length > 0))
  ) {
    throw new DirectPaymentContractError("tokenization");
  }
  const tokenized = nestedRecord(body, ["data", "tokenizeCreditCard"]);
  const tokenizedCard =
    tokenized && isRecord(tokenized.creditCard) ? tokenized.creditCard : null;
  if (
    !tokenized ||
    !nonEmpty(tokenized.token) ||
    !tokenizedCard ||
    !nonEmpty(tokenizedCard.brandCode) ||
    tokenizedCard.last4 !== card.number.slice(-4) ||
    tokenizedCard.expirationMonth !== card.expirationMonth ||
    tokenizedCard.expirationYear !== card.expirationYear ||
    !validBinData(tokenizedCard.binData)
  ) {
    throw new DirectPaymentContractError("tokenization");
  }
  return {
    nonce: tokenized.token,
    verification: {
      brandCode: tokenizedCard.brandCode,
      last4: tokenizedCard.last4,
      expirationMonth: tokenizedCard.expirationMonth,
      expirationYear: tokenizedCard.expirationYear,
    },
  };
}

function correlationId(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) &&
      Object.keys(parsed).length === 1 &&
      nonEmpty(parsed.correlation_id)
      ? parsed.correlation_id
      : null;
  } catch {
    return null;
  }
}

function validBinData(value: unknown): boolean {
  const keys = [
    "prepaid",
    "healthcare",
    "debit",
    "durbinRegulated",
    "commercial",
    "payroll",
    "issuingBank",
    "countryOfIssuance",
    "productId",
    "business",
    "consumer",
    "purchase",
    "corporate",
  ];
  return isRecord(value) && keys.every((key) => nonEmpty(value[key]));
}

function validCard(card: SecretCard): boolean {
  return (
    isRecord(card) &&
    /^\d{12,19}$/.test(card.number) &&
    /^(?:0[1-9]|1[0-2])$/.test(card.expirationMonth) &&
    /^\d{4}$/.test(card.expirationYear) &&
    /^\d{3,4}$/.test(card.cvv) &&
    nonEmpty(card.postalCode)
  );
}

function safelyDispose(lease: SecretCardLease): void {
  try {
    lease.dispose();
  } catch {
    // Best effort; provider/card details must never escape through disposal errors.
  }
}

function nestedRecord(
  value: unknown,
  path: string[],
): Record<string, unknown> | null {
  let current = value;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return isRecord(current) ? current : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
