const CARPOOL = "ride";
const CARPOOL_MATCH_RADIUS = 500;
const CARPOOL_STATUS_ENUM = [
  "open",
  "full",
  "in_progress",
  "completed",
  "cancelled",
];

const CARPOOL_BOOKING_STATUS_ENUM = [
  "pending",
  "accepted",
  "rejected",
  "completed",
  "cancelled",
];

const CARPOOL_SOCKET_EVENTS = {
  /* driver emits */
  CREATE_ROUTE: "carpool:create:route",
  CANCEL_ROUTE: "carpool:cancel:route",
  RESPOND: "carpool:respond", // accept / reject passenger
  START: "carpool:start", // start ride for a passenger (OTP)
  COMPLETE: "carpool:complete",

  /* user emits */
  REQUEST: "carpool:request:create", // user → join specific carpool
  CANCEL_REQUEST: "carpool:cancel_request",

  /* server broadcasts */
  INCOMING_MATCHES: "carpool:incoming_matches", // → user: here are matching carpools
  INCOMING_REQUEST: "carpool:incoming_request", // → driver: new join request
  STATUS_UPDATE: "carpool:status_update", // → ride room
  ROUTE_UPDATE: "carpool:route_update", // → driver: seats/status changed
};

module.exports = {
  CARPOOL,
  CARPOOL_STATUS_ENUM,
  CARPOOL_BOOKING_STATUS_ENUM,
  CARPOOL_SOCKET_EVENTS,
  CARPOOL_MATCH_RADIUS,
};
