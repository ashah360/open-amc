import { describe, expect, it } from "vitest";
import {
  AmcGraphqlOrderProjectionProvider,
  AmcOrderProjectionError,
} from "../src/commerce/graphql-order-projection";
import {
  CartCreateIntent,
  PurchaseNotCompletedError,
} from "../src/commerce/executor";

const token = "00000000-0000-4000-8000-000000000002";
const intent: CartCreateIntent = {
  showtimeId: "900000006",
  seats: [
    {
      name: "E9",
      sku: "TICKET-RS-900000006-ADULT",
      quantity: 1,
      row: 3,
      column: 14,
    },
  ],
  waiveSubscriptionDiscounts: false,
  expectedTotal: "31.98",
  holdAcknowledgement: "CREATE_HOLD",
};

describe("AMC GraphQL order projections", () => {
  it("projects an open cart against the original seat intent without another seat lookup", async () => {
    const response = pendingOrderResponse();
    response.data.viewer.order.email = "";
    const graph = new FakeGraph([response]);
    const provider = new AmcGraphqlOrderProjectionProvider(graph);

    await expect(
      provider.inspectCart(token, "guest@example.test", intent),
    ).resolves.toEqual({
      orderToken: token,
      showtimeId: "900000006",
      seats: [
        {
          name: "E9",
          sku: "TICKET-RS-900000006-ADULT",
          row: 3,
          column: 14,
        },
      ],
      tickets: [{ sku: "TICKET-RS-900000006-ADULT", quantity: 1 }],
      total: "31.98",
      expiresAt: "2030-01-15T22:04:35.163Z",
      status: "OPEN",
    });
    expect(graph.envelopes).toHaveLength(1);
    expect(graph.envelopes[0]).toMatchObject({
      operationName: "OrderProjection",
      variables: { token },
    });
  });

  it("returns the authoritative provider total even when it differs from the pre-cart estimate", async () => {
    // Reproduced River East 21: seat-map estimate 56.04, authoritative
    // created-cart remainingBalance 51.93. The exact valid cart must project
    // successfully and return the provider total, not throw cart.total.
    const response = pendingOrderResponse();
    response.data.viewer.order.remainingBalance = 51.93;
    const graph = new FakeGraph([response]);
    const provider = new AmcGraphqlOrderProjectionProvider(graph);

    await expect(
      provider.inspectCart(token, "guest@example.test", {
        ...intent,
        expectedTotal: "56.04",
      }),
    ).resolves.toMatchObject({
      orderToken: token,
      showtimeId: "900000006",
      seats: [
        { name: "E9", sku: "TICKET-RS-900000006-ADULT", row: 3, column: 14 },
      ],
      tickets: [{ sku: "TICKET-RS-900000006-ADULT", quantity: 1 }],
      total: "51.93",
      status: "OPEN",
    });
  });

  it("still fails closed on seat, showtime, and ticket mismatches", async () => {
    const wrongSeat = pendingOrderResponse();
    wrongSeat.data.viewer.order.groups[0]!.reservedSeats = "E8";
    await expect(
      new AmcGraphqlOrderProjectionProvider(
        new FakeGraph([wrongSeat]),
      ).inspectCart(token, "guest@example.test", intent),
    ).rejects.toBeInstanceOf(AmcOrderProjectionError);

    const wrongShowtime = pendingOrderResponse();
    wrongShowtime.data.viewer.order.groups[0]!.showtime.showtimeId = 900099999;
    await expect(
      new AmcGraphqlOrderProjectionProvider(
        new FakeGraph([wrongShowtime]),
      ).inspectCart(token, "guest@example.test", intent),
    ).rejects.toBeInstanceOf(AmcOrderProjectionError);

    const wrongTicket = pendingOrderResponse();
    wrongTicket.data.viewer.order.groups[0]!.items[0]!.quantity = 2;
    await expect(
      new AmcGraphqlOrderProjectionProvider(
        new FakeGraph([wrongTicket]),
      ).inspectCart(token, "guest@example.test", intent),
    ).rejects.toBeInstanceOf(AmcOrderProjectionError);
  });

  it("projects confirmed purchase and exact refundable lines from viewer.order", async () => {
    const graph = new FakeGraph([
      fulfilledOrderResponse(),
      fulfilledOrderResponse(),
    ]);
    const provider = new AmcGraphqlOrderProjectionProvider(graph);

    await expect(
      provider.projectPurchase({
        orderToken: token,
        email: "guest@example.test",
        expectedTotal: "31.98",
      }),
    ).resolves.toEqual({
      orderToken: token,
      confirmationNumber: "0000000002",
      chargedTotal: "31.98",
      status: "CONFIRMED",
    });
    await expect(
      provider.projectRefundOrder({
        orderNumber: "0000000002",
        email: "guest@example.test",
        orderToken: token,
      }),
    ).resolves.toEqual({
      orderNumber: "0000000002",
      orderToken: token,
      status: "CONFIRMED",
      chargedTotal: "31.98",
      nonRefundableFee: "2.99",
      lines: [
        {
          lineNumber: "1",
          label: "Adult E9",
          refundableAmount: "28.99",
          status: "PAID",
        },
      ],
    });
  });

  it("projects pending and mixed refund states without claiming completion", async () => {
    const pending = fulfilledOrderResponse();
    const pendingOrder = pending.data.viewer.order;
    pendingOrder.groups[0]!.items[0]!.lineItems[0]!.refundableStatus.isRefunded = true;
    pendingOrder.refundedPaymentGroups = [
      {
        isPending: true,
        refundStatus: "Pending",
        refundDateUtc: null,
        refundedPayments: [],
      },
    ];
    const partial = fulfilledOrderResponse();
    const partialOrder = partial.data.viewer.order;
    const first = partialOrder.groups[0]!.items[0]!.lineItems[0]!;
    first.refundableStatus.isRefunded = true;
    partialOrder.groups[0]!.items[0]!.lineItems.push({
      ...structuredClone(first),
      lineNumber: 2,
      seatName: "E10",
      refundableStatus: {
        isRefunded: false,
        selfServiceRefundable: true,
        nonSelfServiceRefundableReason: null,
      },
    });
    partialOrder.groups[0]!.reservedSeats = "E9, E10";
    const provider = new AmcGraphqlOrderProjectionProvider(
      new FakeGraph([pending, partial]),
    );

    await expect(
      provider.projectRefundOrder({
        orderNumber: "0000000002",
        email: "guest@example.test",
        orderToken: token,
      }),
    ).resolves.toMatchObject({
      status: "REFUND_REQUESTED",
      lines: [{ lineNumber: "1", status: "REFUND_REQUESTED" }],
    });
    await expect(
      provider.projectRefundOrder({
        orderNumber: "0000000002",
        email: "guest@example.test",
        orderToken: token,
      }),
    ).resolves.toMatchObject({
      status: "REFUND_REQUESTED",
      lines: [
        { lineNumber: "1", status: "REFUNDED" },
        { lineNumber: "2", status: "PAID" },
      ],
    });
  });

  it("classifies an expired unpaid order as conclusively not purchased", async () => {
    const expired = orderResponse({
      status: "Expired",
      paid: 0,
      remainingBalance: 31.98,
      confirmationCode: null,
    });
    expired.data.viewer.order.groups = [];
    const provider = new AmcGraphqlOrderProjectionProvider(
      new FakeGraph([expired]),
    );

    await expect(
      provider.reconcilePurchase(token, "guest@example.test"),
    ).rejects.toBeInstanceOf(PurchaseNotCompletedError);
  });

  it("fails closed when the returned order does not match the bound intent", async () => {
    const response = pendingOrderResponse();
    response.data.viewer.order.groups[0]!.reservedSeats = "E8";
    const provider = new AmcGraphqlOrderProjectionProvider(
      new FakeGraph([response]),
    );

    await expect(
      provider.inspectCart(token, undefined, intent),
    ).rejects.toBeInstanceOf(AmcOrderProjectionError);
  });
});

class FakeGraph {
  readonly envelopes: unknown[] = [];
  constructor(private readonly responses: unknown[]) {}
  read(envelope: unknown): Promise<unknown> {
    this.envelopes.push(envelope);
    const response = this.responses.shift();
    if (!response) return Promise.reject(new Error("unexpected Graph read"));
    return Promise.resolve(response);
  }
}

function pendingOrderResponse() {
  return orderResponse({
    status: "Pending",
    paid: 0,
    remainingBalance: 31.98,
    confirmationCode: null,
  });
}

function fulfilledOrderResponse() {
  return orderResponse({
    status: "Fulfilled",
    paid: 31.98,
    remainingBalance: 0,
    confirmationCode: "0000000002",
  });
}

function orderResponse(input: {
  status: string;
  paid: number;
  remainingBalance: number;
  confirmationCode: string | null;
}) {
  return {
    data: {
      viewer: {
        order: {
          token,
          orderId: 1232031893,
          status: input.status,
          email: "guest@example.test",
          paid: input.paid,
          total: 31.98,
          feesTotal: 2.99,
          refundableTotal: 28.99,
          refundableType: "WHOLE",
          remainingBalance: input.remainingBalance,
          expirationDateUtc: "2030-01-15T22:04:35.163Z",
          isRefunded: false,
          refundedPaymentGroups: [] as Array<Record<string, unknown>>,
          groups: [
            {
              confirmationCode: input.confirmationCode,
              reservedSeats: "E9",
              feesTotal: 2.99,
              subtotal: 31.98,
              tax: 0,
              total: 31.98,
              type: "TICKET-RS",
              showtime: { showtimeId: 900000006 },
              items: [
                {
                  sku: "TICKET-RS-900000006-ADULT",
                  name: "Adult",
                  quantity: 1,
                  cost: 28.99,
                  tax: 0,
                  lineItems: [
                    {
                      lineNumber: 1,
                      seatName: "E9",
                      cost: 28.99,
                      tax: 0,
                      refundableDiscount: 0,
                      refundableStatus: {
                        isRefunded: false,
                        selfServiceRefundable: true,
                        nonSelfServiceRefundableReason: null,
                      },
                    },
                  ],
                },
              ],
            },
          ],
          error: null,
        },
      },
    },
  };
}
