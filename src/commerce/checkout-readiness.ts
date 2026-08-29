import {
  BraintreeClientTokenProvider,
  DeviceDataProvider,
  SecretCard,
  SecretCardLease,
  SecretCardProvider,
} from "./direct-braintree-tokenizer";
import { KountFirstPartyCookieProvider } from "./direct-risk-providers";

export type CheckoutReadinessStage =
  "identity" | "card" | "braintree" | "fraudnet" | "kount";

export class CheckoutReadinessError extends Error {
  readonly code = "AMC_CHECKOUT_READINESS_REQUIRED";
  constructor(readonly stage: CheckoutReadinessStage) {
    super(`AMC checkout readiness failed (${stage})`);
  }
}

export interface DirectCheckoutReadinessOptions {
  receiptIdentity: { getEmail(): Promise<string> };
  defaultVaultPointer: string;
  cards: PreparedSecretCardProvider;
  clientTokens: PreparedBraintreeClientTokenProvider;
  deviceData: DeviceDataProvider;
  kountCookie: KountFirstPartyCookieProvider;
  repairKountCookie?: () => Promise<void>;
}

export class DirectCheckoutReadiness {
  constructor(private readonly options: DirectCheckoutReadinessOptions) {}

  async assertReady(
    binding = "__default__",
    vaultPointer = this.options.defaultVaultPointer,
  ): Promise<void> {
    if (vaultPointer !== this.options.defaultVaultPointer) {
      throw new CheckoutReadinessError("card");
    }
    await this.identity();
    await this.braintree(binding);
    await this.fraudnet();
    await this.kount();
    await this.card(binding, vaultPointer);
  }

  bind(binding: string, orderToken: string): void {
    this.options.cards.bind(binding, orderToken);
    this.options.clientTokens.bind(binding, orderToken);
  }

  assertPrepared(binding: string, vaultPointer: string): void {
    if (
      vaultPointer !== this.options.defaultVaultPointer ||
      !this.options.cards.isPreparedFor(vaultPointer, binding) ||
      !this.options.clientTokens.isPrepared(binding)
    ) {
      throw new CheckoutReadinessError("card");
    }
  }

  release(binding: string): void {
    this.options.cards.release(binding);
    this.options.clientTokens.release(binding);
  }

  private async identity(): Promise<void> {
    try {
      const email = await this.options.receiptIdentity.getEmail();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid");
    } catch {
      throw new CheckoutReadinessError("identity");
    }
  }

  private async braintree(binding: string): Promise<void> {
    try {
      if (!this.options.clientTokens.isPrepared(binding)) {
        await this.options.clientTokens.prepare(binding);
      }
    } catch {
      throw new CheckoutReadinessError("braintree");
    }
  }

  private async fraudnet(): Promise<void> {
    try {
      const result = await this.options.deviceData.collect({
        orderToken: "preflight",
        sessionId: "preflight",
      });
      if (
        result.fresh !== true ||
        typeof result.deviceData !== "string" ||
        !validCorrelationData(result.deviceData)
      ) {
        throw new Error("invalid");
      }
    } catch {
      throw new CheckoutReadinessError("fraudnet");
    }
  }

  private async card(binding: string, vaultPointer: string): Promise<void> {
    try {
      if (!vaultPointer) throw new Error("missing");
      if (!this.options.cards.isPreparedFor(vaultPointer, binding)) {
        await this.options.cards.prepare(binding, vaultPointer);
      }
    } catch {
      throw new CheckoutReadinessError("card");
    }
  }

  private async kount(): Promise<void> {
    const input = { orderToken: "preflight", sessionId: "preflight" };
    try {
      let cookie = await this.options.kountCookie.getCookie(input);
      if (!validCookie(cookie) && this.options.repairKountCookie) {
        await this.options.repairKountCookie();
        cookie = await this.options.kountCookie.getCookie(input);
      }
      if (!validCookie(cookie)) throw new Error("missing");
    } catch {
      throw new CheckoutReadinessError("kount");
    }
  }
}

export class PreparedBraintreeClientTokenProvider implements BraintreeClientTokenProvider {
  private readonly tokens = new Map<string, string>();

  constructor(private readonly source: BraintreeClientTokenProvider) {}

  isPrepared(binding = "__default__"): boolean {
    return this.tokens.has(binding);
  }

  async prepare(binding = "__default__"): Promise<void> {
    this.tokens.delete(binding);
    const token = await this.source.getClientToken("preflight");
    if (typeof token !== "string" || token.length === 0) {
      throw new CheckoutReadinessError("braintree");
    }
    this.tokens.set(binding, token);
  }

  bind(from: string, orderToken: string): void {
    const token = this.tokens.get(from);
    if (!token || this.tokens.has(orderToken))
      throw new CheckoutReadinessError("braintree");
    this.tokens.delete(from);
    this.tokens.set(orderToken, token);
  }

  getClientToken(orderToken = "__default__"): Promise<string> {
    const token = this.tokens.get(orderToken);
    this.tokens.delete(orderToken);
    return token
      ? Promise.resolve(token)
      : Promise.reject(new CheckoutReadinessError("braintree"));
  }

  release(binding = "__default__"): void {
    this.tokens.delete(binding);
  }
}

export class PreparedSecretCardProvider implements SecretCardProvider {
  private readonly prepared = new Map<
    string,
    { pointer: string; lease: SecretCardLease }
  >();

  constructor(private readonly source: SecretCardProvider) {}

  isPreparedFor(vaultPointer: string, binding = "__default__"): boolean {
    return this.prepared.get(binding)?.pointer === vaultPointer;
  }

  async prepare(
    bindingOrPointer: string,
    maybePointer?: string,
  ): Promise<void> {
    const binding =
      maybePointer === undefined ? "__default__" : bindingOrPointer;
    const vaultPointer = maybePointer ?? bindingOrPointer;
    this.release(binding);
    let lease: SecretCardLease | null = null;
    try {
      lease = await this.source.getCard(vaultPointer);
      if (!validCard(lease.card)) throw new Error("invalid");
      this.prepared.set(binding, { pointer: vaultPointer, lease });
      lease = null;
    } catch {
      safelyDispose(lease);
      throw new CheckoutReadinessError("card");
    }
  }

  bind(from: string, orderToken: string): void {
    const prepared = this.prepared.get(from);
    if (!prepared || this.prepared.has(orderToken))
      throw new CheckoutReadinessError("card");
    this.prepared.delete(from);
    this.prepared.set(orderToken, prepared);
  }

  getCard(
    vaultPointer: string,
    orderToken = "__default__",
  ): Promise<SecretCardLease> {
    const prepared = this.prepared.get(orderToken);
    if (!prepared || prepared.pointer !== vaultPointer) {
      return Promise.reject(new CheckoutReadinessError("card"));
    }
    this.prepared.delete(orderToken);
    return Promise.resolve(prepared.lease);
  }

  release(binding = "__default__"): void {
    const prepared = this.prepared.get(binding);
    if (!prepared) return;
    safelyDispose(prepared.lease);
    this.prepared.delete(binding);
  }
}

function validCorrelationData(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      isRecord(parsed) &&
      Object.keys(parsed).length === 1 &&
      typeof parsed.correlation_id === "string" &&
      /^[A-Za-z0-9_-]{16,128}$/.test(parsed.correlation_id)
    );
  } catch {
    return false;
  }
}

function validCard(card: SecretCard): boolean {
  return (
    isRecord(card) &&
    /^\d{12,19}$/.test(card.number) &&
    /^(?:0[1-9]|1[0-2])$/.test(card.expirationMonth) &&
    /^\d{4}$/.test(card.expirationYear) &&
    /^\d{3,4}$/.test(card.cvv) &&
    typeof card.postalCode === "string" &&
    card.postalCode.length > 0
  );
}

function validCookie(value: string | null): value is string {
  return (
    value !== null && value.length > 0 && !/[\u0000-\u0020;\u007f]/.test(value)
  );
}

function safelyDispose(lease: SecretCardLease | null): void {
  if (!lease) return;
  try {
    lease.dispose();
  } catch {
    // Readiness is already fail-closed; disposal remains best effort and secret-safe.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
