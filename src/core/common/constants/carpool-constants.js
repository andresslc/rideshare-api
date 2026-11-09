const CARPOOL = "carpool";
const DEFAULT_CARPOOL_MATCH_RADIUS_MILES = 500 / 1609.344;

const CARPOOL_STATUS_ENUM = {
  OPEN: "open",
  FULL: "full",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const CARPOOL_BOOKING_STATUS_ENUM = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const CARPOOL_SOCKET_EVENTS = {
  /* driver emits */
  CREATE_ROUTE: "carpool:create:route",
  CANCEL_ROUTE: "carpool:cancel:route",
  RESPOND: "carpool:respond", // driver accept / reject a passenger
  START: "carpool:start", // driver starts the carpool (status → in_progress)
  PICK_PASSENGER: "carpool:pick_passenger", // ← NEW: driver verifies passenger OTP at pickup
  COMPLETE: "carpool:complete", // driver marks ride complete for passenger

  /* passenger emits */
  JOIN: "carpool:join", // passenger joins a specific carpool
  CANCEL_REQUEST: "carpool:cancel_request",

  /* server → passenger */
  INCOMING_MATCHES: "carpool:incoming_matches",
  BOOKING_STATUS: "carpool:booking_status", // accepted / rejected / cancelled by driver
  RIDE_STARTED: "carpool:ride_started", // carpool started, passenger moved to carpool room
  RIDE_COMPLETED: "carpool:ride_completed",

  /* server → driver */
  INCOMING_REQUEST: "carpool:incoming_request", // new join request from passenger
  ROUTE_UPDATE: "carpool:route_update", // seats / status changed

  /* server → carpool room (driver + all passengers) */
  PASSENGER_PICKED_UP: "carpool:passenger_picked_up", // ← NEW: OTP verified, passenger on board

  PAYMENT_VERIFICATION: "carpool:payment:verification",

  /* guest (shared link) */
  INITIAL_DATA: "carpool:initial_data",
  ERROR: "carpool:error",

  ARRIVE: "carpool:arrive", // ← NEW: driver marks a route stop as arrived
  STOP_ARRIVED: "carpool:stop_arrived", // ← NEW: broadcast when a stop is marked arrived

  RESUME: "carpool:resume",
};

/*
 * Known carpool error keys — resolved via locale files (en.json / es.json).
 * Any error key not listed here falls through to a generic message.
 */
const CARPOOL_ERROR_KEYS = [
  "DRIVER_ALREADY_HAS_ACTIVE_CARPOOL",
  "DRIVER_ALREADY_ON_RIDE",
  "ASSIGNMENT_IN_PROGRESS",
  "GRACE_TIME_MUST_BE_IN_FUTURE",
  "PASSENGER_ALREADY_HAS_ACTIVE_BOOKING",
  "CARPOOL_ROUTE_NOT_FOUND",
  "CARPOOL_NOT_OPEN",
  "CARPOOL_GRACE_TIME_EXPIRED",
  "INSUFFICIENT_SEATS",
  "PICKUP_NOT_WITHIN_ROUTE_RADIUS",
  "DROPOFF_NOT_WITHIN_ROUTE_RADIUS",
  "DUPLICATE_BOOKING_REQUEST",
  "CARPOOL_TEMPORARILY_LOCKED_RETRY",
  "BOOKING_NOT_FOUND",
  "UNAUTHORIZED_DRIVER",
  "BOOKING_ALREADY_RESOLVED",
  "BOOKING_NOT_ACCEPTED",
  "OTP_ALREADY_VERIFIED",
  "CARPOOL_INVALID_STATE_FOR_START",
  "CARPOOL_INVALID_STATE_FOR_PICKUP",
  "CARPOOL_CANCELLED",
  "NO_ACCEPTED_PASSENGERS",
  "CARPOOL_INVALID_OTP",
  "RIDE_NOT_STARTED",
  "BOOKING_ALREADY_COMPLETED",
  "CANNOT_CANCEL_ACTIVE_OR_COMPLETED_CARPOOL",
  "CARPOOL_ALREADY_CANCELLED",
  "PASSENGER_NOT_FOUND",
  "INSUFFICIENT_WALLET_BALANCE",
  "NO_ACTIVE_CARD_FOUND",
  "CARD_DECLINED",
  "CARD_INSUFFICIENT_FUNDS",
  "CARD_EXPIRED",
  "CARD_INCORRECT_CVC",
  "CARD_INCORRECT_NUMBER",
  "CARD_INVALID_EXPIRY",
  "CARD_LOST",
  "CARD_STOLEN",
  "CARD_DECLINED_FRAUD",
  "CARD_LIMIT_EXCEEDED",
  "CARD_PROCESSING_ERROR",
  "CARD_AUTHENTICATION_REQUIRED",
  "CARPOOL_CARD_NOT_FOUND",
  "PAYMENT_RATE_LIMIT",
  "PAYMENT_FAILED",
  "UNSUPPORTED_PAYMENT_METHOD",
  "CARPOOL_INVALID_STATE_FOR_ARRIVE",
  "ROUTE_STOP_NOT_FOUND",
  "STOP_ALREADY_ARRIVED",
  "SHIFT_EXCEEDED_CARPOOL",
  "SHIFT_EXCEEDED_ONLINE",
  "DRIVER_SHIFT_LIMIT_REACHED",
];

const CARPOOL_PAYMENT_ERROR_KEYS = [
  "INSUFFICIENT_WALLET_BALANCE",
  "NO_ACTIVE_CARD_FOUND",
  "CARPOOL_CARD_NOT_FOUND",
  "CARD_DECLINED",
  "CARD_INSUFFICIENT_FUNDS",
  "CARD_EXPIRED",
  "CARD_INCORRECT_CVC",
  "CARD_INCORRECT_NUMBER",
  "CARD_INVALID_EXPIRY",
  "CARD_LOST",
  "CARD_STOLEN",
  "CARD_DECLINED_FRAUD",
  "CARD_LIMIT_EXCEEDED",
  "CARD_PROCESSING_ERROR",
  "CARD_AUTHENTICATION_REQUIRED",
  "PAYMENT_RATE_LIMIT",
  "PAYMENT_FAILED",
];

module.exports = {
  CARPOOL,
  CARPOOL_STATUS_ENUM,
  CARPOOL_BOOKING_STATUS_ENUM,
  CARPOOL_SOCKET_EVENTS,
  DEFAULT_CARPOOL_MATCH_RADIUS_MILES,
  CARPOOL_ERROR_KEYS,
  CARPOOL_PAYMENT_ERROR_KEYS,
};
