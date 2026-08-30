import { randomUUID } from "node:crypto";
import { CartCreateIntent, CartSnapshot } from "./executor";
import { AmcCommerceService, CheckoutSessionOwnershipError } from "./service";
export { CheckoutSessionOwnershipError } from "./service";

export class CheckoutSessionIdError extends Error {
  readonly code = "AMC_CHECKOUT_SESSION_ID";
  constructor() {
    super("AMC checkout session ID is invalid");
  }
}

export class AmcCheckoutSession {
  readonly id: string;
  private readonly orderTokens = new Set<string>();

  constructor(
    private readonly service: AmcCommerceService,
    id: string = randomUUID(),
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
      throw new CheckoutSessionIdError();
    }
    this.id = id;
  }

  async createCart(intent: CartCreateIntent): Promise<CartSnapshot> {
    const cart = await this.service.createCart(intent, this.id);
    this.orderTokens.add(cart.orderToken);
    return cart;
  }

  async releaseCart(orderToken: string): Promise<{ released: true }> {
    this.assertOwned(orderToken);
    return this.service.releaseCart(orderToken, this.id);
  }

  async previewCheckout(
    input: Parameters<AmcCommerceService["previewCheckout"]>[0],
  ): ReturnType<AmcCommerceService["previewCheckout"]> {
    this.assertOwned(input.orderToken);
    return this.service.previewCheckout(input);
  }

  async submitCheckout(
    input: Parameters<AmcCommerceService["submitCheckout"]>[0],
  ): ReturnType<AmcCommerceService["submitCheckout"]> {
    this.assertOwned(input.preview.orderToken);
    return this.service.submitCheckout(input);
  }

  owns(orderToken: string): boolean {
    return this.orderTokens.has(orderToken);
  }

  private assertOwned(orderToken: string): void {
    if (!this.owns(orderToken)) throw new CheckoutSessionOwnershipError();
  }
}
