/* ─────────────────────────────────────────────────────────────
   redisConstants.js  —  ALL Redis key helpers (existing + carpool)
   ───────────────────────────────────────────────────────────── */

const REDIS_CONSTANTS = {
  /* ── Geo keys ─────────────────────────────────────── */
  DRIVER_GEO_KEY: "drivers:geo",
  USER_GEO_KEY: "users:geo",

  /* ── User/Driver state keys ───────────────────────── */
  SUSPENDED: "suspended",
  MAX_CANCELLATIONS: 3,

  /* ── Geo-search options ───────────────────────────── */
  FROMLONLAT: "FROMLONLAT",
  BYRADIUS: "BYRADIUS",
  KM: "KM",

  /* ── TTL helpers ──────────────────────────────────── */
  EX: "EX",
  NX: "NX",
  BOOKING_TTL: 60 * 60 * 2, // 2 hours  ← ADD THIS
  OTP_TTL: 60 * 5,

  /* ── TTLs (seconds) ───────────────────────────────── */
  RIDE_SESSION_TTL: 600, // 10 minutes — economy/luxury request window
  PRIVATE_RIDE_SESSION_TTL: 3600, // 1 hour — private ride request window
  CARPOOL_ROUTE_TTL: 86400, // 24 hours  — driver's open carpool route
  CANCELLATION_WINDOW_TTL: 86400, // 24 hours in seconds

  /* ─────────────────────────────────────────────────────
     Key builder helpers
     Usage:  REDIS_CONSTANTS.keys.driverHash(driverId)
     ───────────────────────────────────────────────────── */
  keys: {
    /* Economy / luxury (existing) */
    userPending: (uid) => `user:${uid}:ride:pending`,
    userSocket: (uid) => `user:${uid}:socket`,
    driverActive: (did) => `driver:${did}:ride:active`,
    driverHash: (did) => `driver:${did}`,
    driverSocket: (did) => `driver:${did}:socket`,
    rideSession: (rid) => `ride:session:${rid}`,
    rideLock: (rid) => `ride:lock:${rid}`,
    driverAssignmentLock: (did) => `driver:${did}:assignment:lock`,

    /* Escalating dispatch */
    // Set of drivers already offered this ride, so a driver caught by two rings
    // is only notified once, and so losers can be told when someone else wins.
    rideNotifiedDrivers: (rid) => `ride:${rid}:notified`,

    // The upgrade offer a rider is currently being asked to answer. Mirrors the
    // ride document so a reconnecting app gets the offer back instead of a
    // spinner, and expires on its own if the process that made it dies. Mongo
    // stays authoritative for every decision; this is a read cache for resume.
    rideUpgradeOffer: (rid) => `ride:${rid}:upgrade`,

    /* Carpool */

    // driver active carpool
    driverCarpoolActive: (driverId) => `driver:${driverId}:carpool:active`,

    // carpool route snapshot
    carpoolRoute: (carpoolId) => `carpool:route:${carpoolId}`,

    // atomic seat counter
    carpoolSeats: (carpoolId) => `carpool:seats:${carpoolId}`,

    // carpool status lock (prevents race on status transitions)
    carpoolLock: (carpoolId) => `carpool:lock:${carpoolId}`,

    // booking record
    carpoolBooking: (bookingId) => `carpool:booking:${bookingId}`,

    // list of pending booking ids for a carpool
    carpoolPendingBookings: (carpoolId) => `carpool:pending:${carpoolId}`,

    // OTP for a booking
    carpoolOtp: (bookingId) => `carpool:otp:${bookingId}`,

    // passenger active carpool booking
    passengerActiveCarpool: (userId) => `passenger:${userId}:carpool:active`,

    // user active ride (generic, shared with regular ride)
    userActive: (userId) => `user:${userId}:active`,

    // ── Driver shift (fast checks)
    driverShiftMinutes: (driverId) => `driver:${driverId}:shift:minutes`,
    driverShiftStatus: (driverId) => `driver:${driverId}:shift:status`,

    // ── High-demand hotspot presence / cooldown
    passengerPresence: (userId) => `presence:passenger:${userId}`,
    highDemandCooldown: (driverId) => `high-demand:cooldown:driver:${driverId}`,

    // ── Admin-initiated driver suspension metadata (hash)
    adminSuspension: (driverId) => `driver:${driverId}:admin:suspension`,
  },
};

module.exports = {
  REDIS_CONSTANTS,
};
