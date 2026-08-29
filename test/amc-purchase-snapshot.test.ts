import { describe, expect, it } from "vitest";
import {
  AmcPurchaseSnapshotError,
  createPurchaseSnapshot,
} from "../src/commerce/purchase-snapshot";
import { AmcSeatingLayout } from "../src/client/seat-layout";

const layout: AmcSeatingLayout = {
  columns: 3,
  rows: 1,
  seats: [
    {
      name: "A3",
      available: false,
      column: 1,
      row: 1,
      type: "CanReserve",
      seatTier: "Regular",
      shouldDisplay: true,
    },
    {
      name: "A2",
      available: true,
      column: 2,
      row: 1,
      type: "LoveSeatLeft",
      seatTier: "Regular",
      shouldDisplay: true,
    },
    {
      name: "A1",
      available: true,
      column: 3,
      row: 1,
      type: "LoveSeatRight",
      seatTier: "Regular",
      shouldDisplay: true,
    },
  ],
  prices: [
    {
      sku: "TICKET-RS-123-ADULT",
      type: "Adult",
      price: 20.99,
      convenienceFee: 2.69,
      tax: 0,
    },
  ],
};

describe("AMC purchase snapshot handoff", () => {
  it("binds exact live seat coordinates, SKU, and integer-cent total into cart intent", () => {
    const snapshot = createPurchaseSnapshot({
      showtimeId: "123",
      seatNames: ["A2"],
      adultCount: 1,
      layout,
      observedAt: "2030-01-15T22:00:00.000Z",
    });

    expect(snapshot).toMatchObject({
      schema: "amc.purchase-snapshot/v1",
      showtimeId: "123",
      observedAt: "2030-01-15T22:00:00.000Z",
      seats: [
        {
          name: "A2",
          row: 1,
          column: 2,
          sku: "TICKET-RS-123-ADULT",
          quantity: 1,
        },
      ],
      expectedTotal: "23.68",
    });
    expect(snapshot.cartIntent).toMatchObject({
      showtimeId: "123",
      seats: [{ name: "A2", row: 1, column: 2, sku: "TICKET-RS-123-ADULT" }],
      expectedTotal: "23.68",
    });
  });

  it("rejects invalid observation timestamps", () => {
    expect(() =>
      createPurchaseSnapshot({
        showtimeId: "123",
        seatNames: ["A2"],
        adultCount: 1,
        layout,
        observedAt: "invalid",
      }),
    ).toThrow(AmcPurchaseSnapshotError);
  });
});
