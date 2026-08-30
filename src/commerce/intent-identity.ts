import { createHash } from "node:crypto";
import { CartCreateIntent } from "./executor";

/**
 * Canonical, stable JSON serialization of a cart intent used to derive the
 * `intentHash` identity. Seats are normalized and order-independent so the same
 * logical intent always hashes identically across processes.
 */
export function canonicalIntent(intent: CartCreateIntent): string {
  return JSON.stringify({
    showtimeId: intent.showtimeId,
    seats: intent.seats
      .map((seat) => ({
        name: seat.name,
        sku: seat.sku,
        quantity: seat.quantity,
        row: seat.row,
        column: seat.column,
      }))
      .sort((left, right) =>
        `${left.row}:${left.column}:${left.name}`.localeCompare(
          `${right.row}:${right.column}:${right.name}`,
        ),
      ),
    waiveSubscriptionDiscounts: intent.waiveSubscriptionDiscounts,
    expectedTotal: intent.expectedTotal,
    holdAcknowledgement: intent.holdAcknowledgement,
  });
}

/** Stable content hash identifying a cart intent. */
export function intentHash(intent: CartCreateIntent): string {
  return sha256(canonicalIntent(intent));
}

/**
 * Canonical selection key (showtime + case-insensitive, order-independent seat
 * names). Two carts for the same physical seats collide here on purpose so a
 * tokenless in-flight hold blocks a duplicate for the same selection.
 */
export function selectionHash(showtimeId: string, seatNames: string[]): string {
  return sha256(
    JSON.stringify({
      showtimeId,
      seatNames: seatNames.map((name) => name.toUpperCase()).sort(),
    }),
  );
}

/** Canonical refund key (order token + case-insensitive sorted line numbers). */
export function refundHash(orderToken: string, lineNumbers: string[]): string {
  return sha256(
    JSON.stringify({
      orderToken,
      lineNumbers: [...lineNumbers].sort(),
    }),
  );
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
