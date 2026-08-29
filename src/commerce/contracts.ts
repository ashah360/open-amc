export const CART_CREATE_ORDER_DOCUMENT = `mutation CartCreateOrder($input: OrderCreateInput!) {
  orderCreate(input: $input) {
    order {
      token
    }
  }
}`;

export const BRAINTREE_AUTHORIZATION_DOCUMENT = `query BraintreeAuthorization {
  viewer {
    user {
      paymentVendor {
        clientToken
      }
    }
  }
}`;

export const ADD_CREDIT_CARD_MODAL_DOCUMENT = `query AddCreditCardModal {
  viewer {
    user {
      account {
        accountId
        address1
        address2
        city
        state
        postalCode
        wallet {
          creditCards {
            ...WalletCreditCard
          }
        }
      }
    }
  }
}

fragment WalletCreditCard on CreditCard {
  name
  cardType
  expirationDate
  lastFour
  merchantToken
  default
  cardHolderFirstName
  cardHolderLastName
  address1
  address2
  city
  state
  postalCode
  verified
}`;

export const ORDER_FULFILL_DOCUMENT = `mutation OrderFulfill($input: FulfillOrderInput!) {
  orderFulfill(input: $input) {
    order {
      token
    }
  }
}`;

export const ORDER_EXPIRATION_UPDATE_DOCUMENT = `mutation OrderExpirationUpdate($input: OrderInput!) {
  orderExpirationUpdate(input: $input) {
    order {
      token
    }
  }
}`;

export const ORDER_SEARCH_DOCUMENT = `query OrderSearch($orderNumber: String!, $email: String!) {
  viewer {
    order: orderByOrderNumber(orderNumber: $orderNumber, email: $email) {
      accountId
      error {
        message
      }
      token
    }
  }
}`;

export const ORDER_REFUND_DOCUMENT = `mutation OrderRefund($refundInput: RefundOrderInput!) {
  orderRefund(input: $refundInput) {
    order {
      id
    }
  }
}`;

export const ORDER_DELETE_DOCUMENT = `mutation OrderDelete($input: DeleteOrderInput!) {
  orderDelete(input: $input) {
    success
  }
}`;

export interface GraphqlEnvelope<Variables> {
  operationName: string;
  query: string;
  variables: Variables;
}

export type GraphqlEnvelopeWithoutVariables = Omit<
  GraphqlEnvelope<never>,
  "variables"
>;

export interface CartProductInput {
  sku: string;
  quantity: number;
  column: number;
  row: number;
}

export interface OrderFulfillInput {
  token: string;
  email: string;
  nonce: string;
  deviceData: string;
  paymentMethodType: "creditCard";
  postalCode: string;
}

export function buildCartCreateEnvelope(input: {
  products: CartProductInput[];
  waiveSubscriptionDiscounts: boolean;
}): GraphqlEnvelope<{ input: typeof input }> {
  validateProducts(input.products);
  if (typeof input.waiveSubscriptionDiscounts !== "boolean") {
    throw new Error("CartCreateOrder input drifted");
  }
  return {
    operationName: "CartCreateOrder",
    query: CART_CREATE_ORDER_DOCUMENT,
    variables: { input },
  };
}

export function buildBraintreeAuthorizationEnvelope(): GraphqlEnvelopeWithoutVariables {
  return {
    operationName: "BraintreeAuthorization",
    query: BRAINTREE_AUTHORIZATION_DOCUMENT,
  };
}

export function buildAddCreditCardModalEnvelope(): GraphqlEnvelopeWithoutVariables {
  return {
    operationName: "AddCreditCardModal",
    query: ADD_CREDIT_CARD_MODAL_DOCUMENT,
  };
}

export function buildOrderFulfillEnvelope(
  input: OrderFulfillInput,
): GraphqlEnvelope<{ input: OrderFulfillInput }> {
  if (
    !nonEmpty(input.token) ||
    !nonEmpty(input.email) ||
    !nonEmpty(input.nonce) ||
    !nonEmpty(input.deviceData) ||
    input.paymentMethodType !== "creditCard" ||
    !nonEmpty(input.postalCode)
  ) {
    throw new Error("OrderFulfill input drifted");
  }
  return {
    operationName: "OrderFulfill",
    query: ORDER_FULFILL_DOCUMENT,
    variables: {
      input: {
        token: input.token,
        email: input.email,
        paymentMethodType: input.paymentMethodType,
        nonce: input.nonce,
        postalCode: input.postalCode,
        deviceData: input.deviceData,
      },
    },
  };
}

export function buildOrderExpirationUpdateEnvelope(
  token: string,
): GraphqlEnvelope<{ input: { token: string } }> {
  if (!nonEmpty(token)) throw new Error("OrderExpirationUpdate input drifted");
  return {
    operationName: "OrderExpirationUpdate",
    query: ORDER_EXPIRATION_UPDATE_DOCUMENT,
    variables: { input: { token } },
  };
}

export function parseOrderExpirationUpdateResponse(value: unknown): {
  token: string;
} {
  rejectGraphqlErrors(value, "OrderExpirationUpdate");
  const token = nestedString(value, [
    "data",
    "orderExpirationUpdate",
    "order",
    "token",
  ]);
  if (!token) throw new Error("OrderExpirationUpdate response drifted");
  return { token };
}

export function buildOrderSearchEnvelope(input: {
  orderNumber: string;
  email: string;
}): GraphqlEnvelope<typeof input> {
  if (!nonEmpty(input.orderNumber) || !nonEmpty(input.email)) {
    throw new Error("OrderSearch input drifted");
  }
  return {
    operationName: "OrderSearch",
    query: ORDER_SEARCH_DOCUMENT,
    variables: { email: input.email, orderNumber: input.orderNumber },
  };
}

export function buildOrderRefundEnvelope(input: {
  token: string;
  lineNumbers: string[];
}): GraphqlEnvelope<{ refundInput: typeof input }> {
  if (
    !nonEmpty(input.token) ||
    !Array.isArray(input.lineNumbers) ||
    input.lineNumbers.length === 0 ||
    input.lineNumbers.some((line) => !nonEmpty(line))
  ) {
    throw new Error("OrderRefund input drifted");
  }
  return {
    operationName: "OrderRefund",
    query: ORDER_REFUND_DOCUMENT,
    variables: { refundInput: input },
  };
}

export function buildOrderDeleteEnvelope(token: string): GraphqlEnvelope<{
  input: { token: string };
}> {
  if (!nonEmpty(token)) throw new Error("OrderDelete input drifted");
  return {
    operationName: "OrderDelete",
    query: ORDER_DELETE_DOCUMENT,
    variables: { input: { token } },
  };
}

export function parseCartCreateResponse(value: unknown): { token: string } {
  rejectGraphqlErrors(value, "CartCreateOrder");
  const token = nestedString(value, ["data", "orderCreate", "order", "token"]);
  if (!token) throw new Error("CartCreateOrder response drifted");
  return { token };
}

export function parseBraintreeAuthorizationResponse(value: unknown): {
  clientToken: string;
} {
  rejectGraphqlErrors(value, "BraintreeAuthorization");
  const clientToken = nestedString(value, [
    "data",
    "viewer",
    "user",
    "paymentVendor",
    "clientToken",
  ]);
  if (!clientToken) throw new Error("BraintreeAuthorization response drifted");
  return { clientToken };
}

export function parseAddCreditCardModalResponse(value: unknown): {
  anonymous: boolean;
} {
  rejectGraphqlErrors(value, "AddCreditCardModal");
  const user = nestedRecord(value, ["data", "viewer", "user"]);
  if (!user || !Object.prototype.hasOwnProperty.call(user, "account")) {
    throw new Error("AddCreditCardModal response drifted");
  }
  if (user.account === null) return { anonymous: true };
  if (!isRecord(user.account))
    throw new Error("AddCreditCardModal response drifted");
  return { anonymous: false };
}

export function parseOrderFulfillResponse(value: unknown): { token: string } {
  rejectGraphqlErrors(value, "OrderFulfill");
  const token = nestedString(value, ["data", "orderFulfill", "order", "token"]);
  if (!token) throw new Error("OrderFulfill response drifted");
  return { token };
}

export interface OrderSearchResponse {
  accountId: string | null;
  error: { message: string } | null;
  token: string;
}

export function parseOrderSearchResponse(value: unknown): OrderSearchResponse {
  rejectGraphqlErrors(value, "OrderSearch");
  const order = nestedRecord(value, ["data", "viewer", "order"]);
  if (
    !order ||
    (order.accountId !== null && typeof order.accountId !== "string") ||
    !nonEmpty(order.token) ||
    !validProviderError(order.error)
  ) {
    throw new Error("OrderSearch response drifted");
  }
  return {
    accountId: order.accountId,
    error: order.error,
    token: order.token,
  };
}

export function parseOrderRefundResponse(value: unknown): { id: string } {
  rejectGraphqlErrors(value, "OrderRefund");
  const id = nestedString(value, ["data", "orderRefund", "order", "id"]);
  if (!id) throw new Error("OrderRefund response drifted");
  return { id };
}

export function parseOrderDeleteResponse(value: unknown): { success: true } {
  rejectGraphqlErrors(value, "OrderDelete");
  const payload = nestedRecord(value, ["data", "orderDelete"]);
  if (!payload || payload.success !== true)
    throw new Error("OrderDelete response drifted");
  return { success: true };
}

/** A sanitized, safe-to-surface projection of a single GraphQL error entry. */
export interface SanitizedGraphqlError {
  /** Provider/legacy numeric codes discovered anywhere in the entry. */
  codes: number[];
  /** Provider error classification, when it is a short, safe token. */
  classification?: string;
  /** GraphQL response path, when present and composed of safe tokens. */
  path?: Array<string | number>;
}

/**
 * Structured GraphQL error surfaced from an AMC response. It keeps only the
 * safe, structured signal needed to classify an outcome (numeric provider
 * codes, a classification token, and the response path) and deliberately drops
 * raw provider messages, extension payloads, and any other free-form fields so
 * that authorization, card, session, or personal data can never leak through
 * an error, its message, or logs.
 */
export class AmcGraphqlResponseError extends Error {
  readonly code = "AMC_GRAPHQL_RESPONSE_ERROR";
  readonly operation: string;
  readonly errors: SanitizedGraphqlError[];
  readonly providerCodes: number[];

  constructor(operation: string, rawErrors: unknown[]) {
    super(`${operation} returned ${rawErrors.length} sanitized GraphQL errors`);
    this.operation = operation;
    this.errors = rawErrors.map((entry) => sanitizeGraphqlError(entry));
    const codes = new Set<number>();
    for (const entry of this.errors) {
      for (const value of entry.codes) codes.add(value);
    }
    this.providerCodes = [...codes].sort((a, b) => a - b);
  }

  hasProviderCode(code: number): boolean {
    return this.providerCodes.includes(code);
  }
}

function rejectGraphqlErrors(value: unknown, operation: string): void {
  if (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "errors") &&
    (!Array.isArray(value.errors) || value.errors.length > 0)
  ) {
    const rawErrors = Array.isArray(value.errors)
      ? value.errors
      : [value.errors];
    throw new AmcGraphqlResponseError(operation, rawErrors);
  }
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;

function sanitizeGraphqlError(value: unknown): SanitizedGraphqlError {
  const result: SanitizedGraphqlError = { codes: collectProviderCodes(value) };
  if (!isRecord(value)) return result;
  const classification =
    safeToken(value.classification) ??
    (isRecord(value.extensions)
      ? safeToken(value.extensions.classification)
      : undefined);
  if (classification !== undefined) result.classification = classification;
  const path = safePath(value.path);
  if (path !== undefined) result.path = path;
  return result;
}

function collectProviderCodes(value: unknown, depth = 0): number[] {
  if (depth > 8) return [];
  const codes: number[] = [];
  if (Array.isArray(value)) {
    for (const item of value)
      codes.push(...collectProviderCodes(item, depth + 1));
    return codes;
  }
  if (!isRecord(value)) return codes;
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase().endsWith("code")) {
      const numeric = asProviderCode(entry);
      if (numeric !== null) codes.push(numeric);
    }
    if (entry !== null && typeof entry === "object") {
      codes.push(...collectProviderCodes(entry, depth + 1));
    }
  }
  return codes;
}

function asProviderCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d{1,9}$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value)
    ? value
    : undefined;
}

function safePath(value: unknown): Array<string | number> | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return undefined;
  }
  const path: Array<string | number> = [];
  for (const segment of value) {
    if (typeof segment === "number" && Number.isInteger(segment)) {
      path.push(segment);
    } else if (typeof segment === "string" && SAFE_TOKEN.test(segment)) {
      path.push(segment);
    } else {
      return undefined;
    }
  }
  return path;
}

function validateProducts(products: CartProductInput[]): void {
  if (
    !Array.isArray(products) ||
    products.length === 0 ||
    products.some(
      (product) =>
        !isRecord(product) ||
        !nonEmpty(product.sku) ||
        !positiveInteger(product.quantity) ||
        !positiveInteger(product.column) ||
        !positiveInteger(product.row),
    )
  ) {
    throw new Error("CartCreateOrder products drifted");
  }
}

function validProviderError(
  value: unknown,
): value is { message: string } | null {
  return (
    value === null || (isRecord(value) && typeof value.message === "string")
  );
}

function nestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return nonEmpty(current) ? current : null;
}

function nestedRecord(
  value: unknown,
  path: string[],
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) return null;
    current = current[part];
  }
  return isRecord(current) ? current : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
