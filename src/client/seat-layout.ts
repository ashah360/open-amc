export type AmcSeatType =
  | "CanReserve"
  | "Companion"
  | "Wheelchair"
  | "NotASeat"
  | "LoveSeatLeft"
  | "LoveSeatRight";

export interface AmcSeatSlot {
  available: boolean;
  column: number;
  row: number;
  name: string;
  type: AmcSeatType;
  seatTier: string;
  shouldDisplay: boolean;
}

export interface AmcSeatingLayout {
  columns: number;
  rows: number;
  seats: AmcSeatSlot[];
  prices: AmcTicketPrice[];
  providerStatus?: string;
}

export interface AmcTicketPrice {
  sku: string;
  type: string;
  price: number;
  convenienceFee: number;
  tax: number;
}

export interface PositionedAmcSeat extends AmcSeatSlot {
  x: number;
  y: number;
}

const SEAT_TYPES = new Set<AmcSeatType>([
  "CanReserve",
  "Companion",
  "Wheelchair",
  "NotASeat",
  "LoveSeatLeft",
  "LoveSeatRight",
]);

export function availableOrdinarySeats(
  layout: AmcSeatingLayout,
): PositionedAmcSeat[] {
  return layout.seats
    .filter(
      (seat) =>
        seat.available &&
        seat.shouldDisplay &&
        ["CanReserve", "LoveSeatLeft", "LoveSeatRight"].includes(seat.type),
    )
    .map((seat) => ({
      ...seat,
      x: (seat.column - 0.5) / layout.columns,
      y: (seat.row - 0.5) / layout.rows,
    }));
}

export function parseSeatPageHtml(html: string): AmcSeatingLayout {
  const payloads = nextFlightPayloads(html);
  let layout: AmcSeatingLayout | null = null;
  for (const payload of payloads) {
    const marker = '"seatingLayout":';
    const markerAt = payload.indexOf(marker);
    if (markerAt < 0) continue;
    const objectAt = payload.indexOf("{", markerAt + marker.length);
    if (objectAt < 0) continue;
    const objectEnd = balancedObjectEnd(payload, objectAt);
    const value: unknown = JSON.parse(payload.slice(objectAt, objectEnd));
    layout = validateLayout(value);
    break;
  }
  if (!layout)
    throw new Error(
      "AMC seat response is missing a structured seatingLayout payload",
    );
  return { ...layout, prices: parsePrices(payloads) };
}

function nextFlightPayloads(html: string): string[] {
  const payloads: string[] = [];
  const pattern = /self\.__next_f\.push\((\[\d+,"(?:\\.|[^"\\])*"\])\)/g;
  for (const match of html.matchAll(pattern)) {
    const parsed: unknown = JSON.parse(match[1]!);
    if (Array.isArray(parsed) && typeof parsed[1] === "string")
      payloads.push(parsed[1]);
  }
  return payloads;
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  throw new Error("AMC seatingLayout payload is truncated");
}

function validateLayout(value: unknown): AmcSeatingLayout {
  if (
    !isRecord(value) ||
    !positiveInteger(value.columns) ||
    !positiveInteger(value.rows)
  ) {
    throw new Error("AMC seatingLayout dimensions drifted");
  }
  if (!Array.isArray(value.seats))
    throw new Error("AMC seatingLayout seats drifted");
  const seats = value.seats.map((seat, index) => validateSeat(seat, index));
  if (seats.length !== value.columns * value.rows) {
    throw new Error("AMC seatingLayout grid is incomplete");
  }
  const coordinates = new Set<string>();
  for (const [index, seat] of seats.entries()) {
    if (seat.column > value.columns || seat.row > value.rows) {
      throw new Error(`AMC seatingLayout seat ${index} coordinate drifted`);
    }
    const coordinate = `${seat.row}:${seat.column}`;
    if (coordinates.has(coordinate)) {
      throw new Error(`AMC seatingLayout seat ${index} coordinate drifted`);
    }
    coordinates.add(coordinate);
  }
  return { columns: value.columns, rows: value.rows, seats, prices: [] };
}

function parsePrices(payloads: string[]): AmcTicketPrice[] {
  for (const payload of payloads) {
    const marker = '"prices":';
    const markerAt = payload.indexOf(marker);
    if (markerAt < 0) continue;
    const arrayAt = payload.indexOf("[", markerAt + marker.length);
    if (arrayAt < 0) continue;
    let arrayEnd: number;
    try {
      arrayEnd = balancedArrayEnd(payload, arrayAt);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "AMC ticket prices payload is truncated"
      ) {
        continue;
      }
      throw error;
    }
    const value: unknown = JSON.parse(payload.slice(arrayAt, arrayEnd));
    if (!Array.isArray(value) || value.length === 0)
      throw new Error("AMC ticket prices drifted");
    return value.map((entry, index) => validatePrice(entry, index));
  }
  return [];
}

function validatePrice(value: unknown, index: number): AmcTicketPrice {
  if (
    !isRecord(value) ||
    typeof value.sku !== "string" ||
    !value.sku ||
    typeof value.type !== "string" ||
    !value.type ||
    !nonNegativeNumber(value.price) ||
    !nonNegativeNumber(value.convenienceFee) ||
    !nonNegativeNumber(value.tax)
  ) {
    throw new Error(`AMC ticket price ${index} drifted`);
  }
  return {
    sku: value.sku,
    type: value.type,
    price: value.price,
    convenienceFee: value.convenienceFee,
    tax: value.tax,
  };
}

function balancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return index + 1;
  }
  throw new Error("AMC ticket prices payload is truncated");
}

function validateSeat(value: unknown, index: number): AmcSeatSlot {
  if (
    !isRecord(value) ||
    typeof value.available !== "boolean" ||
    !positiveInteger(value.column) ||
    !positiveInteger(value.row) ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    !SEAT_TYPES.has(value.type as AmcSeatType) ||
    typeof value.seatTier !== "string" ||
    typeof value.shouldDisplay !== "boolean"
  ) {
    throw new Error(`AMC seatingLayout seat ${index} drifted`);
  }
  return {
    available: value.available,
    column: value.column,
    row: value.row,
    name: value.name,
    type: value.type as AmcSeatType,
    seatTier: value.seatTier,
    shouldDisplay: value.shouldDisplay,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
