const USER = "user";
const DRIVER = "driver";
const SOCKET = "socket";
const STATUS = "status";
const RIDE = "ride";
const ACTIVE = "active";
const DESTINATION = "destination";
const PICKUP = "pickup";
const PENDING = "pending";
const SESSION = "session";
const DEFAULT_NEARBY_RADIUS_MILES = 5;
const CANCELLATION_FEE = 0.05;
const CANCELLATIONS = "cancellations";
const DESTINATION_PROXIMITY_THRESHOLD = 0.1; // 100 meters
const OFFER_VALIDITY_SECONDS = 60;

// Escalating dispatch. Rings are searched smallest-first so the driver who wins
// is the closest one that answers, instead of anyone inside a wide fixed radius.
// Values are miles and must stay ascending; the last one is the reach cap.
const DEFAULT_DISPATCH_RADIUS_LADDER_MILES = [1, 2, 3, 5];
const DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS = 10;

// Hard ceiling. 5 miles is ~12 minutes of pickup ETA at urban speeds, which is
// the edge of what a waiting rider tolerates. Raising it is a product decision,
// not a config one, so it is enforced in code and not left to the admin panel.
const MAX_DISPATCH_RADIUS_MILES = 5;
const MAX_DISPATCH_RINGS = 6;

// The upgrade offered when a search exhausts: which category becomes which, and
// how long the rider has to answer before the request dies. Defaults only — the
// live values come from the ride-configuration singleton.
//
// There is deliberately no on/off switch. An exhausted search that simply dies
// is the outcome this feature exists to remove, so it is always offered where a
// mapping exists. Narrowing `categoryUpgradeMap` is what limits it; emptying
// that map is the only way to stop it without a release.
const DEFAULT_CATEGORY_UPGRADE_MAP = { economy: "luxury" };
const DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS = 30;
const MIN_CATEGORY_UPGRADE_DECISION_SECONDS = 5;
const MAX_CATEGORY_UPGRADE_DECISION_SECONDS = 120;

// Driver referral codes for riders. A rider who has never finished a trip saves
// one driver's code, gets `riderDiscountAmount` off their first ride, and the
// driver who owns the code earns `driverBonusAmount` once that ride completes.
// Defaults only — the live values come from the ride-configuration singleton.
// Both are pricing decisions: changing them needs sign-off, not just a deploy.
const DEFAULT_DRIVER_REFERRAL_ENABLED = true;
const DEFAULT_DRIVER_REFERRAL_RIDER_DISCOUNT = 5;
const DEFAULT_DRIVER_REFERRAL_DRIVER_BONUS = 5;
const MAX_DRIVER_REFERRAL_AMOUNT = 100;

const RIDE_STATUS_ENUM = [
  "requested",
  "accepted",
  "arrived",
  "in-progress",
  "completed",
  "cancelled",
  "expired",
  "coming",
];

const RIDE_STATUS = {
  REQUESTED: "requested",
  ACCEPTED: "accepted",
  ARRIVED: "arrived",
  IN_PROGRESS: "in-progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  COMING: "coming",
  EXPIRED: "expired",
};

// The states a ride may be started from. "accepted" is in the list on purpose:
// a driver whose arrival never registered — a GPS reading that missed the 100 m
// fence, an app that skipped the step — must still be able to start a ride the
// passenger is already sitting in. The arrival is recorded on the way through
// rather than the ride refused, which is why "accepted" -> "in-progress" stays
// out of the transition table below.
const RIDE_STARTABLE_STATUSES = ["accepted", "arrived", "coming"];

// Locales the apps can be served in. Adding one here without adding its column
// to the message catalogue leaves that locale falling back to English, which is
// the intended behaviour rather than a blank screen.
const SUPPORTED_LOCALES = ["en", "es"];

// How a distance is spelled for the rider. The dispatcher works in miles and
// converts for Redis; this only decides what the apps print, so switching it
// changes no behaviour at all.
const DISTANCE_UNITS = ["mi", "km"];
const DEFAULT_DISTANCE_UNIT = "mi";

// The copy the apps show during a dispatch, and the only keys an admin may
// override. A fixed list on purpose: the apps render these by key, so a free-
// form catalogue would let the panel write text nothing ever displays.
// Placeholders are filled in by the backend before the text goes out.
const CONFIGURABLE_APP_MESSAGES = {
  RIDE_REQUESTED_FINDING_DRIVERS: [],
  RIDE_SEARCH_IN_PROGRESS: ["ring", "totalRings", "radius", "unit", "seconds"],
  RIDE_SEARCH_EXHAUSTED: ["radius", "unit"],
  USE_CARPOOL_MATCHING: [],
  RIDE_OFFERS_DISABLED: [],
  // The exhausted search that is offered a way out instead of dying. The two
  // categories arrive already translated, so the sentence reads as one language.
  RIDE_UPGRADE_OFFERED: ["fromCategory", "toCategory", "fare", "seconds"],
  RIDE_UPGRADE_SEARCHING: ["toCategory"],
  RIDE_UPGRADE_UNAVAILABLE: [],
};

const CONFIGURABLE_APP_MESSAGE_KEYS = Object.keys(CONFIGURABLE_APP_MESSAGES);

const allowedTransitions = {
  // "expired" closes a request the dispatch ladder exhausted without a taker.
  requested: ["accepted", "cancelled", "expired"],
  accepted: ["arrived", "cancelled"],
  arrived: ["coming", "in-progress", "cancelled"],
  coming: ["in-progress", "cancelled"],
  "in-progress": ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  expired: [],
};

const RIDE_PAYMENT_METHODS = ["attached_card", "wallet"];

// Every value a Ride document may carry, including historical "private" rides.
// Do not shrink this: the model, ride history and promo campaigns all read it.
const RIDE_TYPE = ["economy", "luxury", "carpool", "private"];

// What a rider may ask for on a NEW request. "private" is retired — the rider no
// longer picks from a list of driver offers — so it is absent here on purpose.
const REQUEST_CATEGORIES = ["economy", "luxury", "carpool"];

// Categories that go through the escalating dispatch. Carpool is matched against
// driver-published routes instead, so it never reaches the ring search.
const DISPATCHABLE_CATEGORIES = ["economy", "luxury"];

// Socket Names
const COMMON_SOCKET_EVENTS = {
  CONNECT: "connection",
  DISCONNECT: "disconnect",
};

const RIDE_SOCKET_EVENTS = {
  STATUS_UPDATE: "ride:status:update",
  RESUME: "ride:resume",
  REQUEST: "ride:request:create",
  ACCEPT: "ride:request:accept",
  ACCEPTED: "ride:request:accepted",
  ARRIVE: "ride:driver:arrive",
  ARRIVED: "ride:driver:arrived",
  START: "ride:start",
  STARTED: "ride:started",
  COMPLETE: "ride:complete",
  COMPLETED: "ride:completed",
  CANCEL: "ride:cancel",
  CANCELLED: "ride:cancelled",
  INCOMING: "ride:incoming",
  PAYMENT_VERIFICATION: "ride:payment:verification",

  // Dispatch progress, emitted to the ride room while the rider waits.
  SEARCH_STATUS: "ride:search:status",
  SEARCH_EXHAUSTED: "ride:search:exhausted",
  // Sent to every driver who was offered a ride that somebody else won.
  REQUEST_TAKEN: "ride:request:taken",

  // The rider is asked whether to retry the trip in a pricier category rather
  // than lose the request. The offer goes to the ride room; the decision comes
  // back on its own event so a reconnected app can answer one it was re-sent.
  UPGRADE_OFFER: "ride:upgrade:offer",
  UPGRADE_DECIDE: "ride:upgrade:decide",
  UPGRADE_RESULT: "ride:upgrade:result",

  SEND_OFFER: "send:offer",
  ACCEPT_OFFER: "accept:offer",
  REJECT_OFFER: "reject:offer",
  INCOMING_OFFER: "incoming:offer",
  OFFER_EXPIRED: "offer:expired",
  OFFER_REJECTED: "offer:rejected",

  SESSION: "ride:session",
  LOCK: "ride:lock",

  PENDING: "ride:pending",
  ACTIVE: "ride:active",

  INITIAL_DATA: "ride:initial_data",

  UPDATE_USER_LOC: "user:location:update",

  ERROR: "ride:error",
};

const DRIVER_SOCKET_EVENTS = {
  SET_ONLINE: "driver:online",
  UPDATE_DRIVER_LOC: "driver:location:update",
  ONLINE_STATUS: "online",
  SET_OFFLINE: "driver:offline",
};

// Shift/socket dedicated events
const SHIFT_SOCKET_EVENTS = {
  SHIFT_EXCEEDED: "SHIFT_EXCEEDED",
  DRIVER_FORCED_OFFLINE: "DRIVER_FORCED_OFFLINE",
};

module.exports = {
  USER,
  DRIVER,
  SOCKET,
  STATUS,
  ACTIVE,
  DESTINATION,
  PICKUP,
  PENDING,
  SESSION,
  DEFAULT_NEARBY_RADIUS_MILES,
  CANCELLATION_FEE,
  CANCELLATIONS,
  RIDE,
  RIDE_STATUS_ENUM,
  RIDE_STATUS,
  RIDE_STARTABLE_STATUSES,
  SUPPORTED_LOCALES,
  DISTANCE_UNITS,
  DEFAULT_DISTANCE_UNIT,
  CONFIGURABLE_APP_MESSAGES,
  CONFIGURABLE_APP_MESSAGE_KEYS,
  RIDE_PAYMENT_METHODS,
  RIDE_TYPE,
  REQUEST_CATEGORIES,
  DISPATCHABLE_CATEGORIES,
  DEFAULT_DISPATCH_RADIUS_LADDER_MILES,
  DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS,
  MAX_DISPATCH_RADIUS_MILES,
  MAX_DISPATCH_RINGS,
  DEFAULT_CATEGORY_UPGRADE_MAP,
  DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS,
  MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
  MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
  DEFAULT_DRIVER_REFERRAL_ENABLED,
  DEFAULT_DRIVER_REFERRAL_RIDER_DISCOUNT,
  DEFAULT_DRIVER_REFERRAL_DRIVER_BONUS,
  MAX_DRIVER_REFERRAL_AMOUNT,
  RIDE_SOCKET_EVENTS,
  COMMON_SOCKET_EVENTS,
  DRIVER_SOCKET_EVENTS,
  SHIFT_SOCKET_EVENTS,
  allowedTransitions,
  DESTINATION_PROXIMITY_THRESHOLD,
  OFFER_VALIDITY_SECONDS,
};
