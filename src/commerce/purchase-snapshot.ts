import { AmcSeatingLayout, AmcSeatType } from "../client/seat-layout";
import { CartCreateIntent, Money } from "./executor";

export type AmcPurchaseSnapshotReason =
  "input" | "seat-unavailable" | "price" | "timestamp";

export class AmcPurchaseSnapshotError extends Error {
  readonly code = "AMC_PURCHASE_SNAPSHOT_ERROR";
  constructor(readonly reason: AmcPurchaseSnapshotReason) {
    super(`AMC purchase snapshot failed (${reason})`);
  }
}

export interface AmcPurchaseSnapshot {
  schema: "amc.purchase-snapshot/v1";
  showtimeId: string;
  observedAt: string;
  seats: Array<{
    name: string;
    row: number;
    column: number;
    type: AmcSeatType;
    seatTier: string;
    sku: string;
    quantity: 1;
  }>;
  ticketPrice: Money;
  convenienceFee: Money;
  tax: Money;
  expectedTotal: Money;
  cartIntent: CartCreateIntent;
}

export function createPurchaseSnapshot(input: {
  showtimeId: string;
  seatNames: string[];
  adultCount: number;
  layout: AmcSeatingLayout;
  observedAt: string;
}): AmcPurchaseSnapshot {
  if (
    !/^\d+$/.test(input.showtimeId) ||
    !Array.isArray(input.seatNames) ||
    input.seatNames.length === 0 ||
    new Set(input.seatNames).size !== input.seatNames.length ||
    !Number.isInteger(input.adultCount) ||
    input.adultCount !== input.seatNames.length
  ) {
    throw new AmcPurchaseSnapshotError("input");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new AmcPurchaseSnapshotError("timestamp");
  }
  const selected = input.seatNames.map((name) => {
    const seat = input.layout.seats.find(
      (candidate) => candidate.name.toUpperCase() === name.trim().toUpperCase(),
    );
    if (
      !seat ||
      !seat.available ||
      !seat.shouldDisplay ||
      !["CanReserve", "LoveSeatLeft", "LoveSeatRight"].includes(seat.type)
    ) {
      throw new AmcPurchaseSnapshotError("seat-unavailable");
    }
    return seat;
  });
  const adult = input.layout.prices.find(
    (price) => price.type.toLowerCase() === "adult",
  );
  if (!adult || !adult.sku) throw new AmcPurchaseSnapshotError("price");
  const baseCents = decimalCents(adult.price);
  const feeCents = decimalCents(adult.convenienceFee);
  const taxCents = decimalCents(adult.tax);
  const quantity = input.adultCount;
  const expectedTotal = centsMoney(
    (baseCents + feeCents + taxCents) * quantity,
  );
  const seats = selected.map((seat) => ({
    name: seat.name,
    row: seat.row,
    column: seat.column,
    type: seat.type,
    seatTier: seat.seatTier,
    sku: adult.sku,
    quantity: 1 as const,
  }));
  const cartIntent: CartCreateIntent = {
    showtimeId: input.showtimeId,
    seats: seats.map(({ name, sku, quantity: seatQuantity, row, column }) => ({
      name,
      sku,
      quantity: seatQuantity,
      row,
      column,
    })),
    waiveSubscriptionDiscounts: false,
    expectedTotal,
    holdAcknowledgement: "CREATE_HOLD",
  };
  return {
    schema: "amc.purchase-snapshot/v1",
    showtimeId: input.showtimeId,
    observedAt: input.observedAt,
    seats,
    ticketPrice: centsMoney(baseCents * quantity),
    convenienceFee: centsMoney(feeCents * quantity),
    tax: centsMoney(taxCents * quantity),
    expectedTotal,
    cartIntent,
  };
}

function decimalCents(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new AmcPurchaseSnapshotError("price");
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-7)
    throw new AmcPurchaseSnapshotError("price");
  return cents;
}
function centsMoney(cents: number): Money {
  return (cents / 100).toFixed(2) as Money;
}
