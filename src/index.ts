// Public API surface. The front door is `createAmcClient`. Advanced building
// blocks (transports, browser/payment capabilities, durable recovery) are
// available under dedicated subpath exports; this module deliberately does not
// blanket-export internals.

export { createAmcClient } from "./client";
export type { AmcClient, AmcClientConfig } from "./client";

// Reads.
export type {
  AmcShowtime,
  AmcShowtimeQuery,
  AmcVenue,
  AmcVenueDefinition,
  AmcVenueRegistry,
} from "./client/showtimes";
export { resolveVenue } from "./client/showtimes";
export {
  AmcTheaterUrlError,
  resolveOfficialAmcTheaterUrl,
} from "./client/theater-url";
export type { ResolvedAmcTheater } from "./client/theater-url";
export {
  AMC_CHECKOUT_URL_BASE,
  InvalidOrderTokenError,
  amcCheckoutUrl,
} from "./commerce/handoff";
export { availableOrdinarySeats } from "./client/seat-layout";
export type {
  AmcSeatingLayout,
  AmcSeatSlot,
  AmcSeatType,
  AmcTicketPrice,
  PositionedAmcSeat,
} from "./client/seat-layout";
export type {
  AmcSeatLayoutBatch,
  AmcSeatLayoutBatchResult,
} from "./client/graphql-reads";
export { AmcGraphReadContractError } from "./client/graphql-reads";

// Session / auth.
export type { AmcAuthStatus, AmcSessionContext } from "./client/runtime";
export {
  AmcBootstrapRequiredError,
  AmcSessionRepairRequiredError,
} from "./client/runtime";
export type { AmcSession } from "./client/session";
export {
  AmcAuthRejectedError,
  AmcChallengeError,
  AmcHttpError,
} from "./client/client";
export { DirectAdmissionRequiresBrowserError } from "./client/direct-session-refresh";

// Commerce domain types and errors.
export type {
  CartCreateIntent,
  CartSeatIntent,
  CartSnapshot,
  Money,
  PurchaseResult,
  RefundLineSnapshot,
  RefundOrderSnapshot,
} from "./commerce/executor";
export {
  AmbiguousWriteError,
  AmcCapabilityUnavailableError,
  PurchaseNotCompletedError,
  WriteChallengedError,
  WriteRateLimitedError,
} from "./commerce/executor";
export type {
  AmcCommerceService,
  CheckoutPreview,
  CheckoutChallengePreview,
  RefundPreview,
  UnknownOutcomeReconciliation,
} from "./commerce/service";
export {
  CartCreationOutcomeUnknownError,
  CartHoldWithoutSnapshotError,
  ChallengePaymentSetupError,
  CheckoutOutcomeUnknownError,
  CheckoutSessionOwnershipError,
  ConfirmationMismatchError,
  ConsequenceMismatchError,
  PostconditionVerificationError,
  RefundOutcomeUnknownError,
  ReleaseOutcomeUnknownError,
  SingleFlightError,
  UnknownWriteOutcomeError,
} from "./commerce/service";

// Checkout composition and the pure purchase-snapshot helper.
export { buildAmcCheckoutService } from "./commerce/wiring";
export type {
  AmcCheckoutCapabilities,
  AmcCheckoutReconciler,
  BuildAmcCheckoutServiceOptions,
  BuiltAmcCheckout,
} from "./commerce/wiring";
export {
  createPurchaseSnapshot,
  AmcPurchaseSnapshotError,
} from "./commerce/purchase-snapshot";
export type {
  AmcPurchaseSnapshot,
  AmcPurchaseSnapshotReason,
} from "./commerce/purchase-snapshot";

// Common transport handles (full set under the "./transport" subpath).
export type { Transport } from "./transport";
export { HelloTransport, NativeTransport } from "./transport";
