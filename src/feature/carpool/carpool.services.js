const CarpoolRouteModel = require("./model/carpool-route.model");
const CarpoolBookingModel = require("./model/carpool-booking.model");
const RideOfferModel = require("../ride/model/ride-offer.model");
const RideModel = require("../ride/model/ride.model");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  getDistanceInMeters,
  generateNumericOTP,
  aggregatePaginate,
  encodeSharedLink,
  t,
} = require("../../core/common/helpers");
const {
  CARPOOL_STATUS_ENUM,
  CARPOOL_BOOKING_STATUS_ENUM,
  CARPOOL_SOCKET_EVENTS,
} = require("../../core/common/constants/carpool-constants");
const {
  getRideDistanceConfigurationForRuntime,
} = require("../config/ride-configuration.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const { chargeCarpoolPassenger } = require("./carpool.payment.service");
const { getUniqueVisiblePassengers } = require("./carpool-passenger.helper");
const { handleDriverSuspension } = require("../ride/ride.service");
const UserModel = require("../user/models/user.model");
const CardModel = require("../card/models/card.model");
const {
  NotFoundError,
  ForbiddenError,
} = require("../../core/common/exceptions");
const { default: mongoose } = require("mongoose");
const ReviewModel = require("../reviews/models/review.model");
const DriverModel = require("../driver/models/driver.model");
const {
  CHAT_CONSTANTS,
} = require("../../core/common/constants/chat-constants");
const TransactionModel = require("../transactions/model/transaction.model");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { applyCode } = require("../promo-code/promo-code-campaign.service");
const { removePassengerPresence } = require("../ride/high-demand.service");
const {
  getCarpoolDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const {
  clearJourneyLocationSample,
  recordJourneyEvent,
} = require("../journey-log/journey-log.service");
const {
  enqueueJourneyEventWithDriverLocation: recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.producer");
const {
  canDriverAcceptAssignment,
  handleAssignmentEnded,
} = require("../driver/driver-shift.service");
const {
  acquireAssignmentLock,
  releaseAssignmentLock,
} = require("../ride/assignment-lock.helper");
const {
  cancelPendingOffersForDriver,
} = require("../ride/ride-offer-state.helper");
const { RIDE_STATUS } = require("../../core/common/constants/ride-constants");

const redis = getRedisConnection();

const carpoolDriverFareExpression = {
  $cond: [
    { $gt: [{ $ifNull: ["$originalFare", 0] }, 0] },
    "$originalFare",
    {
      $add: [
        { $ifNull: ["$fareCharged", 0] },
        {
          $cond: [
            { $gt: [{ $ifNull: ["$discountAmount", 0] }, 0] },
            "$discountAmount",
            0,
          ],
        },
      ],
    },
  ],
};

/* ─────────────────────────────────────────────────────────────
   HELPER – acquire a short-lived Redis lock to prevent race
   conditions on seat decrement / status transitions.
   Returns true if lock acquired, false if already locked.
───────────────────────────────────────────────────────────── */
async function acquireLock(lockKey, ttlSeconds = 5) {
  const result = await redis.set(lockKey, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

async function releaseLock(lockKey) {
  await redis.del(lockKey);
}

/* ─────────────────────────────────────────────────────────────
   HELPER – Compute a 0-100 relevance score for a match.

   Weights:
     40%  pickup proximity   (closer = better)
     25%  driver rating      (higher = better, out of 5)
     20%  grace time urgency (departing sooner = better, within a 2-hr window)
     15%  available seats    (more = better, relative to maxPassengers)

   All factors are normalised to [0, 1] before weighting so no
   single unit dominates the result.
───────────────────────────────────────────────────────────── */
function computeMatchScore(match, carpoolMatchRadiusMeters, now = Date.now()) {
  /* ── 1. Pickup proximity (0 → configured radius) ─────────── */
  const proximityScore =
    1 -
    Math.min(match.pickupDistanceMeters, carpoolMatchRadiusMeters) /
      carpoolMatchRadiusMeters;

  /* ── 2. Driver rating (0 → 5) ────────────────────────────── */
  const ratingScore = (match.driver?.rating ?? 0) / 5;

  /* ── 3. Grace-time urgency (sooner departure scores higher) ─
        Normalised over a 2-hour lookahead window.
        A carpool leaving in 0 min → 1.0; leaving in ≥120 min → 0.0
  ────────────────────────────────────────────────────────── */
  const URGENCY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
  const msUntilDeparture = Math.max(
    new Date(match.graceTime).getTime() - now,
    0,
  );
  const urgencyScore =
    1 - Math.min(msUntilDeparture, URGENCY_WINDOW_MS) / URGENCY_WINDOW_MS;

  /* ── 4. Seat availability (relative to route's max capacity) */
  const seatScore =
    match.availableSeats /
    Math.max(match.maxPassengers ?? match.availableSeats, 1);

  const score =
    proximityScore * 0.4 +
    ratingScore * 0.25 +
    urgencyScore * 0.2 +
    seatScore * 0.15;

  return Math.round(score * 100); // 0–100 integer, easy to expose to client
}

/* ─────────────────────────────────────────────────────────────
   RESUME HELPERS
   Fast Redis-first lookups. Falls back to DB if Redis has
   expired (e.g. server restart) and re-hydrates the cache.
───────────────────────────────────────────────────────────── */

/**
 * Driver resume — returns the active CarpoolRoute document if one exists.
 * Active = open | full | in_progress
 */
async function getActiveCarpoolForDriver(driverId) {
  /* ── 1. Redis fast path ───────────────────────────────── */
  const cachedId = await redis.get(
    REDIS_CONSTANTS.keys.driverCarpoolActive(driverId),
  );

  if (cachedId) {
    const route = await CarpoolRouteModel.findById(cachedId)
      .populate(
        "driver",
        "firstName lastName profilePicture rating vehicleDetails vehicleInfo",
      )
      .populate("passengers.user", "firstName lastName profilePicture rating");

    if (
      route &&
      [
        CARPOOL_STATUS_ENUM.OPEN,
        CARPOOL_STATUS_ENUM.FULL,
        CARPOOL_STATUS_ENUM.IN_PROGRESS,
      ].includes(route.status)
    ) {
      return route;
    }

    await redis.del(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId));
  }

  /* ── 2. DB fallback ───────────────────────────────────── */
  const route = await CarpoolRouteModel.findOne({
    driver: driverId,
    status: {
      $in: [
        CARPOOL_STATUS_ENUM.OPEN,
        CARPOOL_STATUS_ENUM.FULL,
        CARPOOL_STATUS_ENUM.IN_PROGRESS,
      ],
    },
  })
    .populate(
      "driver",
      "firstName lastName profilePicture rating vehicleDetails vehicleInfo",
    )
    .populate("passengers.user", "firstName lastName profilePicture rating");

  if (!route) return null;

  await redis.set(
    REDIS_CONSTANTS.keys.driverCarpoolActive(driverId),
    route._id.toString(),
    REDIS_CONSTANTS.EX,
    REDIS_CONSTANTS.CARPOOL_ROUTE_TTL,
  );

  return route;
}
/**
 * Passenger resume — returns the active CarpoolBooking document if one exists.
 * Active = pending | accepted  (in_progress is also accepted + otpVerified)
 */
async function getActiveCarpoolForPassenger(passengerId) {
  /* ── 1. Redis fast path ───────────────────────────────── */
  const cachedBookingId = await redis.get(
    REDIS_CONSTANTS.keys.passengerActiveCarpool(passengerId),
  );

  if (cachedBookingId) {
    const booking = await CarpoolBookingModel.findById(cachedBookingId)
      .populate("carpool")
      .populate(
        "driver",
        "firstName lastName profilePicture rating vehicleDetails vehicleInfo",
      );

    /* Guard: booking resolved since cache was written */
    if (
      booking &&
      [
        CARPOOL_BOOKING_STATUS_ENUM.PENDING,
        CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
      ].includes(booking.status)
    ) {
      return booking;
    }

    await redis.del(REDIS_CONSTANTS.keys.passengerActiveCarpool(passengerId));
  }

  /* ── 2. DB fallback ───────────────────────────────────── */
  const booking = await CarpoolBookingModel.findOne({
    passenger: passengerId,
    status: {
      $in: [
        CARPOOL_BOOKING_STATUS_ENUM.PENDING,
        CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
      ],
    },
  })
    .populate("carpool")
    .populate(
      "driver",
      "firstName lastName profilePicture rating vehicleDetails vehicleInfo",
    );

  if (!booking) return null;

  /* Re-hydrate Redis */
  await redis.set(
    REDIS_CONSTANTS.keys.passengerActiveCarpool(passengerId),
    booking._id.toString(),
    REDIS_CONSTANTS.EX,
    REDIS_CONSTANTS.BOOKING_TTL,
  );

  return booking;
}

/* ─────────────────────────────────────────────────────────────
   1. CREATE CARPOOL ROUTE  (driver)
───────────────────────────────────────────────────────────── */
async function createCarpoolRouteService(driverId, data) {
  // Shift enforcement: block if exceeded and break < 6h
  const { canDriverCreateCarpool } = require("../driver/driver-shift.service");
  const guard = await canDriverCreateCarpool(driverId);
  if (!guard.allowed) {
    throw new Error("SHIFT_EXCEEDED_CARPOOL");
  }
  const graceTime = new Date(data.graceTime);

  /* Edge: graceTime must be in the future (double-check even though validator catches it) */
  if (graceTime.getTime() <= Date.now()) {
    throw new Error("GRACE_TIME_MUST_BE_IN_FUTURE");
  }

  const assignmentLock = await acquireAssignmentLock(redis, driverId);
  if (!assignmentLock) throw new Error("ASSIGNMENT_IN_PROGRESS");

  try {
    // Acceptance uses this same lock. Re-check after acquiring it so a ride
    // accepted at the same instant prevents creation of a conflicting carpool.
    const [existingCarpoolId, activeRideId, activeRideInDatabase] =
      await Promise.all([
        redis.get(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId)),
        redis.get(REDIS_CONSTANTS.keys.driverActive(driverId)),
        RideModel.exists({
          driver: new mongoose.Types.ObjectId(driverId),
          rideStatus: {
            $in: [
              RIDE_STATUS.ACCEPTED,
              RIDE_STATUS.ARRIVED,
              RIDE_STATUS.COMING,
              RIDE_STATUS.IN_PROGRESS,
            ],
          },
        }),
      ]);

    if (existingCarpoolId) {
      throw new Error("DRIVER_ALREADY_HAS_ACTIVE_CARPOOL");
    }
    if (activeRideId || activeRideInDatabase) {
      throw new Error("DRIVER_ALREADY_ON_RIDE");
    }

    // Cancel first while holding the shared decision lock. Acceptance can only
    // proceed by atomically changing a still-pending offer to accepted.
    await cancelPendingOffersForDriver(
      RideOfferModel,
      new mongoose.Types.ObjectId(driverId),
    );

    const acceptedOfferInProgress = await RideOfferModel.exists({
      driver: new mongoose.Types.ObjectId(driverId),
      status: "accepted",
    });
    if (acceptedOfferInProgress) {
      throw new Error("DRIVER_ALREADY_ON_RIDE");
    }

    const carpoolRoute = await CarpoolRouteModel.create({
      driver: driverId,
      startingPoint: data.startingPoint,
      destination: data.destination,
      routes: data.routes,
      maxPassengers: data.maxPassengers,
      availableSeats: data.maxPassengers,
      graceTime,
      avgTime: data.avgTime ?? 0,
      distance: data.distance ?? 0,
      status: CARPOOL_STATUS_ENUM.OPEN,
      passengers: [],
    });

    await recordJourneyEvent({
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      eventType: "carpool.route_created",
      phase: "pre_assignment",
      actor: { type: "driver", id: driverId },
      source: "socket",
      transition: { from: null, to: CARPOOL_STATUS_ENUM.OPEN },
      location: carpoolRoute.startingPoint?.location,
      locationSource: "planned_stop",
      dedupeKey: `carpool:${carpoolRoute._id}:route_created`,
      metadata: {
        plannedStartName: carpoolRoute.startingPoint?.placeName,
        plannedDestinationName: carpoolRoute.destination?.placeName,
        maxPassengers: carpoolRoute.maxPassengers,
      },
    });

    const carpoolId = carpoolRoute._id.toString();

    /* Redis: mark driver as having an active carpool */
    await redis.set(
      REDIS_CONSTANTS.keys.driverCarpoolActive(driverId),
      carpoolId,
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.CARPOOL_ROUTE_TTL,
    );

    /* Redis: snapshot of the route for fast passenger lookups */
    await redis.set(
      REDIS_CONSTANTS.keys.carpoolRoute(carpoolId),
      JSON.stringify({
        _id: carpoolId,
        driver: driverId,
        routes: carpoolRoute.routes,
        status: CARPOOL_STATUS_ENUM.OPEN,
        availableSeats: carpoolRoute.availableSeats,
        maxPassengers: carpoolRoute.maxPassengers,
        graceTime: graceTime.getTime(),
        avgTime: carpoolRoute.avgTime ?? 0,
        distance: carpoolRoute.distance ?? 0,
      }),
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.CARPOOL_ROUTE_TTL,
    );

    /* Redis: atomic seat counter */
    await redis.set(
      REDIS_CONSTANTS.keys.carpoolSeats(carpoolId),
      String(data.maxPassengers), // "3" not 3
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.CARPOOL_ROUTE_TTL,
    );

    return carpoolRoute;
  } finally {
    await releaseAssignmentLock(redis, assignmentLock);
  }
}

/* ─────────────────────────────────────────────────────────────
   2. FIND MATCHING CARPOOL ROUTES  (passenger search)
───────────────────────────────────────────────────────────── */
async function findMatchingCarpoolRoutes(
  passengerId,
  data,
  passengersRequired = false,
) {
  const {
    pickupPoint,
    dropOffPoint,
    requiredSeats = 1,
    fare,
    paymentMethod,
    avgTime = 0,
    distance = 0,
  } = data;

  /* ── Validate payment method upfront ─────────────────── */
  if (paymentMethod === "wallet") {
    const passenger = await UserModel.findById(passengerId).select(
      "balance rewardedBalance",
    );
    if (!passenger) throw new Error("PASSENGER_NOT_FOUND");
    if ((passenger.balance || 0) + (passenger.rewardedBalance || 0) < fare)
      throw new Error("INSUFFICIENT_WALLET_BALANCE");
  }

  if (paymentMethod === "attached_card") {
    const card = await CardModel.findOne({
      user: passengerId,
      status: "active",
      default: true,
    });
    if (!card) throw new Error("NO_ACTIVE_CARD_FOUND");
  }

  const [pickupLng, pickupLat] = pickupPoint.location.coordinates;
  const [dropLng, dropLat] = dropOffPoint.location.coordinates;
  const now = new Date();
  const { carpoolMatchRadiusMeters } =
    await getRideDistanceConfigurationForRuntime();

  const pickupMatches = await CarpoolRouteModel.find({
    status: CARPOOL_STATUS_ENUM.OPEN,
    availableSeats: { $gte: requiredSeats },
    graceTime: { $gt: now },
    "routes.location": {
      $near: {
        $geometry: { type: "Point", coordinates: [pickupLng, pickupLat] },
        $maxDistance: carpoolMatchRadiusMeters,
      },
    },
  }).populate({
    path: "driver",
    select:
      "firstName lastName profilePicture rating vehicleDetails vehicleInfo",
    populate: {
      path: "vehicleDetails",
      select:
        "make model yearOfManufacture color licensePlateNumber vehicleType",
    },
  });
  if (!pickupMatches.length) return [];

  const finalMatches = [];

  for (const route of pickupMatches) {
    const routeDriverId = route.driver?._id || route.driver;
    if (!routeDriverId) continue;
    const shiftGuard = await canDriverAcceptAssignment(routeDriverId);
    if (!shiftGuard.allowed) continue;

    /* ── Resolve closest pickup stop ──────────────────── */
    let pickupStop = null;
    let pickupMinDistance = Infinity;

    for (const stop of route.routes) {
      const [lng, lat] = stop.location.coordinates;
      const dist = getDistanceInMeters(pickupLat, pickupLng, lat, lng);
      if (dist <= carpoolMatchRadiusMeters && dist < pickupMinDistance) {
        pickupMinDistance = dist;
        pickupStop = stop;
      }
    }
    if (!pickupStop) continue;

    /* ── Resolve closest drop-off stop (must follow pickup) */
    let dropOffStop = null;
    let dropMinDistance = Infinity;

    for (const stop of route.routes) {
      if (stop.order <= pickupStop.order) continue;
      const [lng, lat] = stop.location.coordinates;
      const dist = getDistanceInMeters(dropLat, dropLng, lat, lng);
      if (dist <= carpoolMatchRadiusMeters && dist < dropMinDistance) {
        dropMinDistance = dist;
        dropOffStop = stop;
      }
    }
    if (!dropOffStop) continue;

    finalMatches.push({
      _id: route._id,
      driver: route.driver,
      availableSeats: route.availableSeats,
      maxPassengers: route.maxPassengers, // needed by seat score
      graceTime: route.graceTime,
      routes: route.routes,
      resolvedPickupStop: pickupStop,
      resolvedDropOffStop: dropOffStop,
      pickupPoint,
      dropOffPoint,
      pickupDistanceMeters: Math.round(pickupMinDistance),
      dropOffDistanceMeters: Math.round(dropMinDistance),
      ...(passengersRequired && {
        passengers: route.passengers,
      }),
      fare,
      paymentMethod,
      requiredSeats,
      avgTime,
      distance,
    });
  }

  if (!finalMatches.length) return [];

  /* ── Score and sort — best match first ───────────────── */
  const nowMs = Date.now();

  return finalMatches
    .map((match) => ({
      ...match,
      relevanceScore: computeMatchScore(match, carpoolMatchRadiusMeters, nowMs),
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/* ─────────────────────────────────────────────────────────────
   3. PASSENGER JOINS A SPECIFIC CARPOOL
───────────────────────────────────────────────────────────── */
async function joinCarpoolService(passengerId, data, io, socket) {
  const {
    carpoolId,
    pickupPoint,
    dropOffPoint,
    requiredSeats = 1,
    fare,
    paymentMethod,
    avgTime = 0,
    distance = 0,
    originalFare,
    codeId,
    campaignId,
    discountAmount,
  } = data;

  /* Edge: passenger already has an active carpool booking */
  const existingBooking = await redis.get(
    REDIS_CONSTANTS.keys.passengerActiveCarpool(passengerId),
  );
  if (existingBooking) {
    throw new Error("PASSENGER_ALREADY_HAS_ACTIVE_BOOKING");
  }

  const { carpoolMatchRadiusMeters } =
    await getRideDistanceConfigurationForRuntime();

  /* Acquire lock to prevent simultaneous seat grabs */
  const lockKey = REDIS_CONSTANTS.keys.carpoolLock(carpoolId);
  const locked = await acquireLock(lockKey);
  if (!locked) {
    throw new Error("CARPOOL_TEMPORARILY_LOCKED_RETRY");
  }

  try {
    /* Fetch latest route state from DB (lock means we can trust this read) */
    const carpoolRoute = await CarpoolRouteModel.findById(carpoolId);

    /* Edge: carpool not found */
    if (!carpoolRoute) {
      throw new Error("CARPOOL_ROUTE_NOT_FOUND");
    }

    const shiftGuard = await canDriverAcceptAssignment(carpoolRoute.driver);
    if (!shiftGuard.allowed) throw new Error("DRIVER_SHIFT_LIMIT_REACHED");

    /* Edge: carpool is no longer open */
    if (carpoolRoute.status !== CARPOOL_STATUS_ENUM.OPEN) {
      throw new Error("CARPOOL_NOT_OPEN");
    }

    /*Edge: carpool is cancelled*/
    if (carpoolRoute.status === CARPOOL_STATUS_ENUM.CANCELLED) {
      throw new Error("CARPOOL_CANCELLED");
    }

    /* Edge: grace time has passed */
    if (carpoolRoute.graceTime.getTime() <= Date.now()) {
      throw new Error("CARPOOL_GRACE_TIME_EXPIRED");
    }

    /* Edge: not enough seats */
    if (carpoolRoute.availableSeats < requiredSeats) {
      throw new Error("INSUFFICIENT_SEATS");
    }

    const [pickupLng, pickupLat] = pickupPoint.location.coordinates;
    const [dropLng, dropLat] = dropOffPoint.location.coordinates;

    /* Resolve pickup stop from route */
    let resolvedPickup = null;
    let pickupMinDist = Infinity;

    for (const stop of carpoolRoute.routes) {
      const [lng, lat] = stop.location.coordinates;
      const dist = getDistanceInMeters(pickupLat, pickupLng, lat, lng);
      if (dist <= carpoolMatchRadiusMeters && dist < pickupMinDist) {
        pickupMinDist = dist;
        resolvedPickup = stop;
      }
    }

    /* Edge: pickup no longer matches (user sent stale data) */
    if (!resolvedPickup) {
      throw new Error("PICKUP_NOT_WITHIN_ROUTE_RADIUS");
    }

    /* Resolve drop-off stop — must come after pickup */
    let resolvedDropOff = null;
    let dropMinDist = Infinity;

    for (const stop of carpoolRoute.routes) {
      if (stop.order <= resolvedPickup.order) continue;

      const [lng, lat] = stop.location.coordinates;
      const dist = getDistanceInMeters(dropLat, dropLng, lat, lng);
      if (dist <= carpoolMatchRadiusMeters && dist < dropMinDist) {
        dropMinDist = dist;
        resolvedDropOff = stop;
      }
    }

    /* Edge: drop-off not within route */
    if (!resolvedDropOff) {
      throw new Error("DROPOFF_NOT_WITHIN_ROUTE_RADIUS");
    }

    /* Edge: duplicate booking (passenger already requested this carpool) */
    const duplicateBooking = carpoolRoute.passengers.find(
      (p) =>
        p.user.toString() === passengerId &&
        ["pending", "accepted"].includes(p.status),
    );
    if (duplicateBooking) {
      throw new Error("DUPLICATE_BOOKING_REQUEST");
    }

    /* Create the booking record */
    const requestedAt = new Date();
    const booking = await CarpoolBookingModel.create({
      carpool: carpoolId,
      passenger: passengerId,
      driver: carpoolRoute.driver,
      pickupStop: resolvedPickup,
      dropOffStop: resolvedDropOff,
      requiredSeats,
      avgTime,
      distance,
      fareCharged: fare,
      status: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
      requestedAt,
      paymentMethod,
      ...(codeId && {
        codeId,
        campaignId,
        originalFare,
        discountAmount,
      }),
    });
    const driverFare = getCarpoolDriverFare(booking);

    /* Replace any legacy inactive entry before adding the new booking. */
    carpoolRoute.passengers = carpoolRoute.passengers.filter(
      (passenger) => passenger.user.toString() !== passengerId,
    );

    /* Push passenger reference into the route */
    carpoolRoute.passengers.push({
      user: passengerId,
      bookingId: booking._id,
      pickupStop: resolvedPickup,
      dropOffStop: resolvedDropOff,
      status: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
    });
    await carpoolRoute.save();

    await recordJourneyEvent({
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      bookingId: booking._id,
      eventType: "carpool.booking_requested",
      phase: "pre_assignment",
      actor: { type: "user", id: passengerId },
      source: "socket",
      occurredAt: requestedAt,
      location: resolvedPickup.location,
      locationSource: "planned_stop",
      dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:requested`,
      metadata: {
        pickupStopId: resolvedPickup._id,
        dropOffStopId: resolvedDropOff._id,
        requiredSeats,
      },
    });

    /* Cache booking in Redis for fast driver lookups */
    await redis.set(
      REDIS_CONSTANTS.keys.carpoolBooking(booking._id.toString()),
      JSON.stringify({
        _id: booking._id.toString(),
        carpoolId,
        passengerId,
        driverId: carpoolRoute.driver.toString(),
        pickupStop: resolvedPickup,
        dropOffStop: resolvedDropOff,
        requiredSeats,
        fareCharged: booking.fareCharged,
        driverFare,
        avgTime,
        distance,
        status: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
      }),
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.BOOKING_TTL,
    );

    /* Mark passenger as having a pending booking */
    await redis.set(
      REDIS_CONSTANTS.keys.passengerActiveCarpool(passengerId),
      booking._id.toString(),
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.BOOKING_TTL,
    );

    /*
     * Join passenger to a booking-specific room.
     * They will receive accept/reject updates here.
     * On ride start they are migrated to the shared carpool room.
     */
    socket.join(`booking:${booking._id.toString()}`);

    const user = await UserModel.findById(passengerId).select(
      "firstName lastName profilePicture rating",
    );
    /* Notify driver of new join request */
    io.to(`carpool:${carpoolId}`).emit(CARPOOL_SOCKET_EVENTS.INCOMING_REQUEST, {
      bookingId: booking._id,
      passenger: {
        passengerId,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePicture: user.profilePicture,
        rating: user.rating,
      },
      pickupStop: resolvedPickup,
      dropOffStop: resolvedDropOff,
      requiredSeats,
      avgTime,
      distance,
      fareCharged: booking.fareCharged,
      driverFare,
    });

    const driver = await UserModel.findById(carpoolRoute.driver).select(
      "locale",
    );

    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_NEW_BOOKING_REQUEST_TITLE",
        driver?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_NEW_BOOKING_REQUEST_DESC",
        driver?.locale || "en",
      ),
      userIds: [carpoolRoute.driver],
      role: "user",
      metadata: {
        type: "CARPOOL",
        driverFare: getCarpoolDriverFare(booking),
      },
    });

    return booking;
  } finally {
    await releaseLock(lockKey);
  }
}

/* ─────────────────────────────────────────────────────────────
   4. DRIVER RESPONDS TO PASSENGER REQUEST (accept / reject)
───────────────────────────────────────────────────────────── */
async function respondToPassengerService(driverId, data, io, socket) {
  const { bookingId, action } = data;

  console.log(
    `[respondToPassengerService] Starting for bookingId: ${bookingId}, driverId: ${driverId}, action: ${action}`,
  );

  const booking =
    await CarpoolBookingModel.findById(bookingId).populate("carpool");

  /* Edge: booking not found */
  if (!booking) {
    console.error(
      `[respondToPassengerService] Booking not found: ${bookingId}`,
    );
    throw new Error("BOOKING_NOT_FOUND");
  }

  console.log(
    `[respondToPassengerService] Booking found. Driver: ${booking.driver}, Carpool: ${booking.carpool._id}`,
  );

  /* Edge: this driver doesn't own this carpool */
  if (booking.driver.toString() !== driverId) {
    console.error(
      `[respondToPassengerService] Unauthorized driver. Expected: ${booking.driver}, Got: ${driverId}`,
    );
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  const carpoolRoute = booking.carpool;

  const lockKey = REDIS_CONSTANTS.keys.carpoolLock(carpoolRoute._id.toString());
  console.log(
    `[respondToPassengerService] Attempting to acquire lock: ${lockKey}`,
  );
  const locked = await acquireLock(lockKey);
  if (!locked) {
    console.warn(
      `[respondToPassengerService] Lock acquisition failed for: ${lockKey}`,
    );
    throw new Error("CARPOOL_TEMPORARILY_LOCKED_RETRY");
  }

  console.log(`[respondToPassengerService] Lock acquired: ${lockKey}`);

  try {
    if (action === "reject") {
      console.log(
        `[respondToPassengerService] Processing REJECT for bookingId: ${bookingId}`,
      );
      const oldBookingStatus = booking.status;
      console.log(
        `[respondToPassengerService] Old booking status: ${oldBookingStatus}`,
      );
      booking.status = CARPOOL_BOOKING_STATUS_ENUM.REJECTED;
      await booking.save();

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "carpool",
          journeyId: carpoolRoute._id,
          carpoolId: carpoolRoute._id,
          bookingId: booking._id,
          eventType: "carpool.booking_rejected",
          phase: "pre_assignment",
          actor: { type: "driver", id: driverId },
          source: "socket",
          transition: {
            from: oldBookingStatus,
            to: CARPOOL_BOOKING_STATUS_ENUM.REJECTED,
          },
          dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:rejected`,
        },
        driverId,
      );
      console.log(
        `[respondToPassengerService] Booking status updated to REJECTED`,
      );

      /* Update passenger entry in the route */
      const passengerIndex = carpoolRoute.passengers.findIndex(
        (p) => p.bookingId.toString() === bookingId,
      );
      console.log(
        `[respondToPassengerService] Passenger index in route: ${passengerIndex}`,
      );
      if (passengerIndex !== -1) {
        carpoolRoute.passengers.splice(passengerIndex, 1);
        await carpoolRoute.save();
        console.log(
          `[respondToPassengerService] Passenger removed from route. Remaining: ${carpoolRoute.passengers.length}`,
        );
      }

      /* Clear passenger's active booking ref */
      const passengerCacheKey = REDIS_CONSTANTS.keys.passengerActiveCarpool(
        booking.passenger.toString(),
      );
      await redis.del(passengerCacheKey);
      console.log(
        `[respondToPassengerService] Cleared Redis cache: ${passengerCacheKey}`,
      );

      /*
       * Notify passenger via their booking room, then evict them.
       * After rejection there are no further updates to receive.
       */
      const bookingRoom = `booking:${bookingId}`;
      console.log(
        `[respondToPassengerService] Emitting BOOKING_STATUS rejection to room: ${bookingRoom}`,
      );
      io.to(bookingRoom).emit(CARPOOL_SOCKET_EVENTS.BOOKING_STATUS, {
        bookingId,
        status: "rejected",
        driverFare: getCarpoolDriverFare(booking),
      });

      const passenger = await UserModel.findById(booking.passenger).select(
        "locale",
      );

      console.log(
        `[respondToPassengerService] Sending rejection notification to passenger: ${booking.passenger}`,
      );
      sendNotificationToSpecificUser({
        title: t(
          "NOTIFICATION_CARPOOL_REJECTED_TITLE",
          passenger?.locale || "en",
        ),
        description: t(
          "NOTIFICATION_CARPOOL_REJECTED_DESC",
          passenger?.locale || "en",
        ),
        userIds: [booking.passenger],
        role: "user",
        metadata: {
          type: "CARPOOL",
        },
      });

      // io.in(bookingRoom).socketsLeave(bookingRoom);
      console.log(
        `[respondToPassengerService] Passengers evicted from room: ${bookingRoom}`,
      );

      if (oldBookingStatus === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED) {
        console.log(
          `[respondToPassengerService] Booking was ACCEPTED. Restoring seats...`,
        );
        /* If previously accepted, increment seat counter back */
        const newSeats = await redis.incr(
          REDIS_CONSTANTS.keys.carpoolSeats(carpoolRoute._id.toString()),
        );
        console.log(
          `[respondToPassengerService] Seats incremented in Redis. New count: ${newSeats}`,
        );

        /* If route was full, mark it open again */
        if (carpoolRoute.status === CARPOOL_STATUS_ENUM.FULL) {
          console.log(
            `[respondToPassengerService] Route was FULL. Changing status to OPEN`,
          );
          carpoolRoute.status = CARPOOL_STATUS_ENUM.OPEN;
        }

        carpoolRoute.availableSeats += booking.requiredSeats;
        console.log(
          `[respondToPassengerService] Available seats in DB updated to: ${carpoolRoute.availableSeats}`,
        );
        await carpoolRoute.save();

        io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
          CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE,
          {
            carpoolId: carpoolRoute._id,
            availableSeats: carpoolRoute.availableSeats,
            status: carpoolRoute.status,
          },
        );
        console.log(
          `[respondToPassengerService] Broadcast ROUTE_UPDATE to carpool room`,
        );
      }
      console.log(
        `[respondToPassengerService] REJECT completed for ${bookingId}`,
      );
      return {
        action: "rejected",
        bookingId,
        driverFare: getCarpoolDriverFare(booking),
      };
    }

    /* ── ACCEPT ────────────────────────────────────────────── */
    console.log(
      `[respondToPassengerService] Processing ACCEPT for bookingId: ${bookingId}`,
    );

    const shiftGuard = await canDriverAcceptAssignment(driverId);
    if (!shiftGuard.allowed) throw new Error("SHIFT_EXCEEDED_ONLINE");

    /* Re-check seats under lock */
    if (carpoolRoute.availableSeats < booking.requiredSeats) {
      console.error(
        `[respondToPassengerService] Insufficient seats. Available: ${carpoolRoute.availableSeats}`,
      );
      throw new Error("INSUFFICIENT_SEATS");
    }

    console.log(
      `[respondToPassengerService] Seat check passed. Available: ${carpoolRoute.availableSeats}`,
    );

    /* Decrement seat counter atomically */
    const newSeats = await redis.decr(
      REDIS_CONSTANTS.keys.carpoolSeats(carpoolRoute._id.toString()),
    );
    console.log(
      `[respondToPassengerService] Seats decremented in Redis. New count: ${newSeats}`,
    );

    /* Rare race: another accept slipped in, roll back and error */
    if (newSeats < 0) {
      console.warn(
        `[respondToPassengerService] Race condition detected. Rolling back. newSeats: ${newSeats}`,
      );
      await redis.incr(
        REDIS_CONSTANTS.keys.carpoolSeats(carpoolRoute._id.toString()),
      );
      throw new Error("INSUFFICIENT_SEATS");
    }

    const acceptedAt = new Date();
    booking.status = CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED;
    booking.acceptedAt = acceptedAt;

    /* Generate 4-digit OTP for passenger pickup */
    const otp = generateNumericOTP();
    booking.otp = otp;
    console.log(
      `[respondToPassengerService] Generated OTP: ${otp} for booking: ${bookingId}`,
    );
    await booking.save();
    console.log(
      `[respondToPassengerService] Booking status updated to ACCEPTED`,
    );

    // Remove passenger presence tracking now that their carpool seat is confirmed
    try {
      await removePassengerPresence(booking.passenger.toString());
    } catch (presenceErr) {
      console.error(
        "[HIGH-DEMAND] removePassengerPresence error:",
        presenceErr?.message,
      );
    }

    /* Decrement availableSeats in DB */
    carpoolRoute.availableSeats -= booking.requiredSeats;
    console.log(
      `[respondToPassengerService] Available seats in DB: ${carpoolRoute.availableSeats}`,
    );

    /* Update passenger status in route */
    const passengerEntry = carpoolRoute.passengers.find(
      (p) => p.bookingId.toString() === bookingId,
    );
    if (passengerEntry) {
      passengerEntry.status = CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED;
      console.log(
        `[respondToPassengerService] Updated passenger status in route to ACCEPTED`,
      );
    }

    /* If no seats left, mark route as full */
    if (carpoolRoute.availableSeats === 0) {
      console.log(
        `[respondToPassengerService] No seats remaining. Marking route as FULL`,
      );
      carpoolRoute.status = CARPOOL_STATUS_ENUM.FULL;

      /* Update Redis snapshot */
      const cached = await redis.get(
        REDIS_CONSTANTS.keys.carpoolRoute(carpoolRoute._id.toString()),
      );
      if (cached) {
        const snapshot = JSON.parse(cached);
        snapshot.status = CARPOOL_STATUS_ENUM.FULL;
        snapshot.availableSeats = 0;
        await redis.set(
          REDIS_CONSTANTS.keys.carpoolRoute(carpoolRoute._id.toString()),
          JSON.stringify(snapshot),
          REDIS_CONSTANTS.EX,
          REDIS_CONSTANTS.CARPOOL_ROUTE_TTL,
        );
        console.log(
          `[respondToPassengerService] Updated Redis snapshot to FULL`,
        );
      }
    }

    await carpoolRoute.save();
    console.log(`[respondToPassengerService] Carpool route saved`);

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolRoute._id,
        carpoolId: carpoolRoute._id,
        bookingId: booking._id,
        eventType: "carpool.booking_accepted",
        phase: "to_pickup",
        actor: { type: "driver", id: driverId },
        source: "socket",
        transition: {
          from: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
          to: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
        },
        occurredAt: acceptedAt,
        dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:accepted`,
      },
      driverId,
    );

    /* Cache OTP separately with short TTL */
    const otpCacheKey = REDIS_CONSTANTS.keys.carpoolOtp(bookingId);
    await redis.set(
      otpCacheKey,
      otp,
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.OTP_TTL,
    );
    console.log(
      `[respondToPassengerService] OTP cached in Redis: ${otpCacheKey}`,
    );

    /* Join carpool booking room for chat */
    const chatRoom = CHAT_CONSTANTS.keys.carpoolChatRoom(bookingId);
    socket.join(chatRoom); // driver joins
    console.log(
      `[respondToPassengerService] Driver joined chat room: ${chatRoom}`,
    );

    /* Join passenger socket(s) to the same chat room */
    const passengerSockets = await io.in(`booking:${bookingId}`).fetchSockets();
    console.log(
      `[respondToPassengerService] Found ${passengerSockets.length} passenger sockets`,
    );
    for (const s of passengerSockets) {
      s.join(chatRoom);
    }
    console.log(
      `[respondToPassengerService] All passengers joined chat room: ${chatRoom}`,
    );

    /*
     * Notify passenger via their booking room.
     * They stay here until startCarpoolService migrates them
     * into the shared carpool room.
     */
    console.log(
      `[respondToPassengerService] Emitting BOOKING_STATUS acceptance to room: booking:${bookingId}`,
    );
    io.to(`booking:${bookingId}`).emit(CARPOOL_SOCKET_EVENTS.BOOKING_STATUS, {
      bookingId,
      status: "accepted",
      otp,
      pickupStop: booking.pickupStop,
      dropOffStop: booking.dropOffStop,
      fareCharged: booking.fareCharged,
      driverFare: getCarpoolDriverFare(booking),
      requiredSeats: booking.requiredSeats ?? 1,
      avgTime: booking.avgTime ?? 0,
      distance: booking.distance ?? 0,
    });

    const passenger = await UserModel.findById(booking.passenger).select(
      "locale",
    );
    console.log(
      "✅ [CARPOOL ACCEPTANCE] Sending carpool acceptance notification to passenger:",
      {
        bookingId: booking._id,
        passengerId: booking.passenger,
        carpoolRouteId: booking.carpool._id,
        locale: passenger?.locale || "en",
      },
    );
    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_CARPOOL_ACCEPTED_TITLE",
        passenger?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_CARPOOL_ACCEPTED_DESC",
        passenger?.locale || "en",
      ),
      userIds: [booking.passenger],
      role: "user",
      metadata: {
        type: "CARPOOL",
      },
    });

    /* Notify driver room of updated seat count */
    console.log(
      `[respondToPassengerService] Broadcasting ROUTE_UPDATE to carpool room`,
    );
    io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
      CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE,
      {
        carpoolId: carpoolRoute._id,
        availableSeats: carpoolRoute.availableSeats,
        status: carpoolRoute.status,
      },
    );

    console.log(
      `[respondToPassengerService] ACCEPT completed successfully for ${bookingId}`,
    );
    return {
      action: "accepted",
      bookingId,
      driverFare: getCarpoolDriverFare(booking),
    };
  } finally {
    await releaseLock(lockKey);
    console.log(`[respondToPassengerService] Lock released: ${lockKey}`);
  }
}

/* ─────────────────────────────────────────────────────────────
   5. START CARPOOL  (driver)
   Driver sends carpoolId → status transitions to in_progress.
   All accepted passengers are migrated from their individual
   booking rooms into the shared carpool room so they receive
   live ride-wide events going forward.
───────────────────────────────────────────────────────────── */
async function startCarpoolService(driverId, data, io) {
  const { carpoolId } = data;

  const carpoolRoute = await CarpoolRouteModel.findById(carpoolId);

  /* Edge: route not found */
  if (!carpoolRoute) throw new Error("CARPOOL_ROUTE_NOT_FOUND");

  /* Edge: wrong driver */
  if (carpoolRoute.driver.toString() !== driverId) {
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  /* Edge: carpool must be open or full to be startable */
  if (
    ![CARPOOL_STATUS_ENUM.OPEN, CARPOOL_STATUS_ENUM.FULL].includes(
      carpoolRoute.status,
    )
  ) {
    throw new Error("CARPOOL_INVALID_STATE_FOR_START");
  }

  /* Edge: at least one accepted passenger must exist */
  const acceptedPassengers = carpoolRoute.passengers.filter(
    (p) => p.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
  );
  if (acceptedPassengers.length === 0) {
    throw new Error("NO_ACCEPTED_PASSENGERS");
  }

  const routeStartedAt = new Date();
  const previousRouteStatus = carpoolRoute.status;
  carpoolRoute.status = CARPOOL_STATUS_ENUM.IN_PROGRESS;
  carpoolRoute.routeStartedAt = routeStartedAt;
  await carpoolRoute.save();

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      eventType: "carpool.route_started",
      phase: "to_pickup",
      actor: { type: "driver", id: driverId },
      source: "socket",
      transition: {
        from: previousRouteStatus,
        to: CARPOOL_STATUS_ENUM.IN_PROGRESS,
      },
      occurredAt: routeStartedAt,
      dedupeKey: `carpool:${carpoolRoute._id}:route_started`,
      metadata: { acceptedPassengerCount: acceptedPassengers.length },
    },
    driverId,
  );

  /* Update Redis snapshot */
  const cached = await redis.get(REDIS_CONSTANTS.keys.carpoolRoute(carpoolId));
  if (cached) {
    const snapshot = JSON.parse(cached);
    snapshot.status = CARPOOL_STATUS_ENUM.IN_PROGRESS;
    await redis.set(
      REDIS_CONSTANTS.keys.carpoolRoute(carpoolId),
      JSON.stringify(snapshot),
      REDIS_CONSTANTS.EX,
      REDIS_CONSTANTS.CARPOOL_ROUTE_TTL,
    );
  }

  // The route may have been open longer than the sampling interval. Reset the
  // server-side gate so the next existing client location update becomes the
  // first persisted breadcrumb of the actual route.
  await clearJourneyLocationSample("carpool", carpoolId);

  /*
   * Auto-cancel any PENDING bookings for this carpool.
   * These passengers were never accepted by the driver, and now that
   * the carpool is in progress they can never be. Cancelling them here
   * frees them from the waiting screen immediately.
   */
  const pendingBookings = await CarpoolBookingModel.find({
    carpool: carpoolId,
    status: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
  });

  for (const pendingBooking of pendingBookings) {
    pendingBooking.status = CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;
    pendingBooking.cancelledAt = routeStartedAt;
    await pendingBooking.save();

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolRoute._id,
        carpoolId: carpoolRoute._id,
        bookingId: pendingBooking._id,
        eventType: "carpool.booking_cancelled",
        phase: "ended",
        actor: { type: "system", id: null },
        source: "service",
        transition: {
          from: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
          to: CARPOOL_BOOKING_STATUS_ENUM.CANCELLED,
        },
        occurredAt: routeStartedAt,
        reasonCode: "CARPOOL_STARTED_BEFORE_BOOKING_ACCEPTED",
        dedupeKey: `carpool:${carpoolRoute._id}:booking:${pendingBooking._id}:cancelled`,
      },
      driverId,
    );

    console.log(
      `[startCarpoolService] Auto-cancelled pending booking ${pendingBooking._id} for passenger ${pendingBooking.passenger}`,
    );

    /* Notify the stuck passenger via their booking room */
    io.to(`booking:${pendingBooking._id.toString()}`).emit(
      CARPOOL_SOCKET_EVENTS.BOOKING_STATUS,
      {
        bookingId: pendingBooking._id,
        status: CARPOOL_BOOKING_STATUS_ENUM.CANCELLED,
        reason: "Carpool started without your booking being accepted.",
        driverFare: getCarpoolDriverFare(pendingBooking),
      },
    );

    /* Clear Redis active-carpool key for this passenger */
    try {
      await redis.del(
        REDIS_CONSTANTS.keys.passengerActiveCarpool(
          pendingBooking.passenger.toString(),
        ),
      );
    } catch (redisErr) {
      console.error(
        `[startCarpoolService] Failed to clear Redis key for passenger ${pendingBooking.passenger}:`,
        redisErr,
      );
    }

    /* Send push notification so the passenger knows */
    const passengerLocale = await UserModel.findById(
      pendingBooking.passenger,
    ).select("locale");
    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_BOOKING_AUTO_CANCELLED_TITLE",
        passengerLocale?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_BOOKING_AUTO_CANCELLED_DESC",
        passengerLocale?.locale || "en",
      ),
      userIds: [pendingBooking.passenger],
      skipSave: false,
      metadata: {
        type: "CARPOOL_CANCELLED",
        bookingId: pendingBooking._id,
      },
    });
  }

  const carpoolRoom = `carpool:${carpoolId}`;

  /*
   * For each accepted passenger:
   *   1. Notify them via their booking room that the ride has started.
   *   2. Migrate their socket(s) into the shared carpool room.
   *   3. Evict them from the now-redundant booking room.
   */

  for (const passenger of acceptedPassengers) {
    const bookingRoom = `booking:${passenger.bookingId.toString()}`;
    const booking = await CarpoolBookingModel.findById(passenger.bookingId);

    io.to(bookingRoom).emit(CARPOOL_SOCKET_EVENTS.RIDE_STARTED, {
      carpoolId,
      status: CARPOOL_STATUS_ENUM.IN_PROGRESS,
      message: "Your carpool ride has started!",
      driverFare: getCarpoolDriverFare(booking),
    });

    io.in(bookingRoom).socketsJoin(carpoolRoom);
    io.in(bookingRoom).socketsLeave(bookingRoom);

    const passengerLocale = await UserModel.findById(passenger.user).select(
      "locale",
    );
    console.log(
      "🚀 [CARPOOL RIDE START] Sending carpool ride started notification to passenger:",
      {
        passengerId: passenger.user,
        carpoolRouteId: carpoolId,
        locale: passengerLocale?.locale || "en",
      },
    );
    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_RIDE_STARTED_TITLE",
        passengerLocale?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_RIDE_STARTED_DESC",
        passengerLocale?.locale || "en",
      ),
      userIds: [passenger.user],
      skipSave: false,
      metadata: {
        type: "CARPOOL",
      },
    });
  }

  /* Broadcast to the full carpool room (includes driver) */
  io.to(carpoolRoom).emit(CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE, {
    carpoolId,
    status: CARPOOL_STATUS_ENUM.IN_PROGRESS,
  });

  return { carpoolId, status: CARPOOL_STATUS_ENUM.IN_PROGRESS };
}

/* ─────────────────────────────────────────────────────────────
   6. PICK PASSENGER  (driver verifies passenger OTP at pickup)
   Formerly: startCarpoolRideService
───────────────────────────────────────────────────────────── */
async function pickPassengerService(driverId, data, io) {
  const { bookingId, otp } = data;

  console.log(
    `[pickPassengerService] Starting for bookingId: ${bookingId}, driverId: ${driverId}`,
  );

  const booking = await CarpoolBookingModel.findById(bookingId)
    .populate("carpool passenger")
    .select("+otp");

  if (!booking) throw new Error("BOOKING_NOT_FOUND");
  if (booking.driver.toString() !== driverId)
    throw new Error("UNAUTHORIZED_DRIVER");
  if (booking.status !== CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED)
    throw new Error("BOOKING_NOT_ACCEPTED");

  if (booking.otpVerified) {
    if (booking.paymentStatus !== "completed") {
      throw new Error("OTP_ALREADY_VERIFIED");
    }

    const completedResult = {
      bookingId,
      rideStartedAt: booking.rideStartedAt,
      driverFare: getCarpoolDriverFare(booking),
    };
    io.to(`carpool:${booking.carpool._id.toString()}`).emit(
      CARPOOL_SOCKET_EVENTS.PASSENGER_PICKED_UP,
      {
        bookingId,
        carpoolId: booking.carpool._id,
        passengerId: booking.passenger._id.toString(),
        pickedUpAt: booking.rideStartedAt,
        otpVerified: true,
        driverFare: completedResult.driverFare,
      },
    );
    return completedResult;
  }

  const carpoolRoute = booking.carpool;
  if (carpoolRoute.status !== CARPOOL_STATUS_ENUM.IN_PROGRESS) {
    throw new Error("CARPOOL_INVALID_STATE_FOR_PICKUP");
  }

  /* ── Verify OTP ───────────────────────────────────────── */
  const cachedOtp = await redis.get(REDIS_CONSTANTS.keys.carpoolOtp(bookingId));
  const expectedOtp = cachedOtp || booking.otp;
  if (!expectedOtp || otp !== expectedOtp) {
    try {
      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "carpool",
          journeyId: carpoolRoute._id,
          carpoolId: carpoolRoute._id,
          bookingId: booking._id,
          eventType: "carpool.otp_failed",
          phase: "waiting_pickup",
          actor: { type: "driver", id: driverId },
          source: "socket",
          reasonCode: "CARPOOL_INVALID_OTP",
        },
        driverId,
      );
    } catch (logError) {
      console.error("Failed to record carpool OTP failure:", logError.message);
    }
    throw new Error("CARPOOL_INVALID_OTP");
  }

  const otpVerifiedAt = new Date();
  booking.otpVerifiedAt = otpVerifiedAt;
  await booking.save();

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      bookingId: booking._id,
      eventType: "carpool.otp_verified",
      phase: "waiting_pickup",
      actor: { type: "driver", id: driverId },
      source: "socket",
      occurredAt: otpVerifiedAt,
      dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:otp_verified`,
    },
    driverId,
  );

  /* Remove OTP — single use */
  await redis.del(REDIS_CONSTANTS.keys.carpoolOtp(bookingId));

  /* ── Charge passenger upfront ─────────────────────────── */
  const chargeResult = await chargeCarpoolPassenger(booking);

  /* ── Payment failed (wallet insufficient OR card declined) */
  if (chargeResult.cancelled) {
    const reason = chargeResult.reason ?? "payment_failed";
    const errorKey =
      reason === "insufficient_wallet_balance"
        ? "INSUFFICIENT_WALLET_BALANCE"
        : reason;

    booking.status = CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;
    booking.paymentStatus = "failed";
    booking.cancelledAt = new Date();
    await booking.save();

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolRoute._id,
        carpoolId: carpoolRoute._id,
        bookingId: booking._id,
        eventType: "carpool.payment_failed",
        phase: "waiting_pickup",
        actor: { type: "system", id: null },
        source: "service",
        amount: { value: booking.fareCharged, currency: "USD" },
        reasonCode: errorKey,
        dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:payment_failed`,
        metadata: { paymentMethod: booking.paymentMethod },
      },
      driverId,
    );

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolRoute._id,
        carpoolId: carpoolRoute._id,
        bookingId: booking._id,
        eventType: "carpool.booking_cancelled",
        phase: "ended",
        actor: { type: "system", id: null },
        source: "service",
        transition: {
          from: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
          to: CARPOOL_BOOKING_STATUS_ENUM.CANCELLED,
        },
        reasonCode: errorKey,
        dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:cancelled`,
      },
      driverId,
    );

    const passengerIndex = carpoolRoute.passengers.findIndex(
      (p) => p.bookingId?.toString() === bookingId.toString(),
    );
    if (passengerIndex !== -1) {
      carpoolRoute.passengers[passengerIndex].status =
        CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;
    }

    const remainingActivePassengers = carpoolRoute.passengers.filter(
      (p) => p.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
    ).length;
    const shouldEndCarpool =
      carpoolRoute.status === CARPOOL_STATUS_ENUM.IN_PROGRESS &&
      remainingActivePassengers === 0;

    if (shouldEndCarpool) {
      carpoolRoute.status = CARPOOL_STATUS_ENUM.CANCELLED;
      carpoolRoute.cancelledBy = "payment_failure";
      carpoolRoute.cancellationReason = errorKey;
      carpoolRoute.cancelledAt = new Date();
    }

    await carpoolRoute.save();

    if (shouldEndCarpool) {
      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "carpool",
          journeyId: carpoolRoute._id,
          carpoolId: carpoolRoute._id,
          eventType: "carpool.route_cancelled",
          phase: "ended",
          actor: { type: "system", id: null },
          source: "service",
          transition: {
            from: CARPOOL_STATUS_ENUM.IN_PROGRESS,
            to: CARPOOL_STATUS_ENUM.CANCELLED,
          },
          occurredAt: carpoolRoute.cancelledAt,
          reasonCode: errorKey,
          dedupeKey: `carpool:${carpoolRoute._id}:route_cancelled`,
        },
        driverId,
      );
    }

    await redis.del(
      REDIS_CONSTANTS.keys.passengerActiveCarpool(
        booking.passenger._id.toString(),
      ),
    );

    io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
      CARPOOL_SOCKET_EVENTS.BOOKING_STATUS,
      {
        bookingId,
        status: "cancelled",
        reason,
        driverFare: getCarpoolDriverFare(booking),
      },
    );

    if (shouldEndCarpool) {
      await Promise.all([
        redis.del(
          REDIS_CONSTANTS.keys.driverCarpoolActive(carpoolRoute.driver),
        ),
        redis.del(
          REDIS_CONSTANTS.keys.carpoolRoute(carpoolRoute._id.toString()),
        ),
        redis.del(
          REDIS_CONSTANTS.keys.carpoolSeats(carpoolRoute._id.toString()),
        ),
      ]);

      await handleAssignmentEnded(carpoolRoute.driver, io);

      io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
        CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE,
        {
          carpoolId: carpoolRoute._id,
          status: CARPOOL_STATUS_ENUM.CANCELLED,
          reason,
          reasonCode: errorKey,
          cancelledBy: "payment_failure",
        },
      );

      const driver = await DriverModel.findById(booking.driver).select(
        "locale",
      );
      await sendNotificationToSpecificUser({
        title: t("CARPOOL_ENDED_PAYMENT_FAILED_TITLE", driver?.locale || "en"),
        description: t(
          "CARPOOL_ENDED_PAYMENT_FAILED_DESC",
          driver?.locale || "en",
        ),
        userIds: [booking.driver],
        role: "driver",
        metadata: {
          type: "CARPOOL_ENDED",
        },
      });
    }

    const passengerLocale = booking.passenger?.locale || "en";
    await sendNotificationToSpecificUser({
      title: t("CARPOOL_PAYMENT_FAILED_TITLE", passengerLocale),
      description: t("CARPOOL_PAYMENT_FAILED_DESC", passengerLocale).replace(
        "${reason}",
        t(errorKey, passengerLocale),
      ),
      userIds: [booking.passenger._id],
      role: "user",
      metadata: {
        type: "CARPOOL_PAYMENT_FAILED",
        reasonCode: errorKey,
      },
    });

    throw new Error(errorKey);
  }

  /* ── Card payment — defer to webhook ─────────────────── */
  if (booking.paymentMethod === "attached_card") {
    if (chargeResult.requiresAction) {
      /*
       * 3DS required — send client secret to passenger.
       * Booking stays ACCEPTED. Webhook handles the rest.
       */
      io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
        CARPOOL_SOCKET_EVENTS.PAYMENT_VERIFICATION,
        {
          bookingId,
          requiresAction: true,
          clientSecret: chargeResult.clientSecret,
          paymentIntentId: chargeResult.paymentIntentId,
          driverFare: getCarpoolDriverFare(booking),
        },
      );
    } else {
      /*
       * Card charged immediately (no 3DS) — still defer to webhook.
       * Do NOT mark otpVerified here. Webhook payment:success will
       * Credit driver and emit PASSENGER_PICKED_UP.
       */
      io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
        CARPOOL_SOCKET_EVENTS.PAYMENT_VERIFICATION,
        {
          bookingId,
          requiresAction: false,
          paymentIntentId: chargeResult.paymentIntentId,
          driverFare: getCarpoolDriverFare(booking),
        },
      );
    }

    const driver = await DriverModel.findById(booking.driver).select("locale");
    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_VERIFICATION_SUCCESS_TITLE",
        driver?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_VERIFICATION_SUCCESS_DESC",
        driver?.locale || "en",
      ).replace("{{amount}}", getCarpoolDriverFare(booking).toString()),
      userIds: [booking.driver],
      role: "user",
      metadata: {
        type: "CARPOOL",
        driverFare: getCarpoolDriverFare(booking),
      },
    });

    return {
      bookingId,
      requiresAction: chargeResult.requiresAction ?? false,
      driverFare: getCarpoolDriverFare(booking),
    };
  }

  /* ── Wallet payment succeeded — mark picked up immediately */
  booking.otpVerified = true;
  booking.otp = undefined;
  booking.paymentStatus = "completed";
  booking.paymentCompletedAt = booking.paymentCompletedAt || new Date();
  booking.rideStartedAt = booking.rideStartedAt || booking.paymentCompletedAt;
  await booking.save();

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      bookingId: booking._id,
      eventType: "carpool.passenger_picked_up",
      phase: "on_trip",
      actor: { type: "driver", id: driverId },
      source: "socket",
      occurredAt: booking.rideStartedAt,
      references: { routeStopId: booking.pickupStop?._id },
      dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:picked_up`,
    },
    driverId,
  );

  io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
    CARPOOL_SOCKET_EVENTS.PASSENGER_PICKED_UP,
    {
      bookingId,
      carpoolId: carpoolRoute._id,
      passengerId: booking.passenger._id.toString(),
      pickedUpAt: booking.rideStartedAt,
      otpVerified: booking.otpVerified,
      driverFare: getCarpoolDriverFare(booking),
    },
  );

  if (booking.codeId && booking.campaignId && booking.discountAmount > 0) {
    const applied = await applyCode({
      promoCode: booking.codeId,
      campaign: booking.campaignId,
      user: booking.passenger._id,
      appliedTo: booking._id,
      appliedToType: "CarpoolBooking",
      discountApplied: booking.discountAmount,
    });
    if (!applied) {
      console.error("[carpool:payment] Redemption record failed", {
        bookingId: booking._id,
      });
    }
  }

  const driver = await DriverModel.findById(booking.driver).select("locale");
  console.log(
    "✓ [CARPOOL OTP VERIFICATION] Sending OTP verification success notification to driver:",
    {
      bookingId: booking._id,
      driverId: booking.driver,
      passengerId: booking.passenger,
      locale: driver?.locale || "en",
    },
  );
  sendNotificationToSpecificUser({
    title: t("NOTIFICATION_VERIFICATION_SUCCESS_TITLE", driver?.locale || "en"),
    description: t(
      "NOTIFICATION_VERIFICATION_SUCCESS_DESC",
      driver?.locale || "en",
    ).replace("{{amount}}", getCarpoolDriverFare(booking).toString()),
    userIds: [booking.driver],
    role: "user",
    metadata: {
      type: "CARPOOL",
      driverFare: getCarpoolDriverFare(booking),
    },
  });

  console.log(`[pickPassengerService] Completed for booking: ${bookingId}`);
  return {
    bookingId,
    rideStartedAt: booking.rideStartedAt,
    driverFare: getCarpoolDriverFare(booking),
  };
}

/* ─────────────────────────────────────────────────────────────
   7. COMPLETE RIDE  (driver marks passenger ride as done)
───────────────────────────────────────────────────────────── */
async function completeCarpoolRideService(driverId, data, io, role) {
  const { bookingId } = data;

  const booking =
    await CarpoolBookingModel.findById(bookingId).populate("carpool");

  /* Edge: booking not found */
  if (!booking) throw new Error("BOOKING_NOT_FOUND");

  if (role !== "driver" || booking.driver.toString() !== driverId.toString()) {
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  /* Edge: ride must have been started (OTP verified) */
  if (!booking.otpVerified) {
    throw new Error("RIDE_NOT_STARTED");
  }

  /* Edge: already completed */
  if (booking.status === CARPOOL_BOOKING_STATUS_ENUM.COMPLETED) {
    throw new Error("BOOKING_ALREADY_COMPLETED");
  }

  booking.status = CARPOOL_BOOKING_STATUS_ENUM.COMPLETED;
  booking.rideCompletedAt = new Date();
  await booking.save();

  /* Update passenger entry on the route */
  const carpoolRoute = booking.carpool;

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      bookingId: booking._id,
      eventType: "carpool.passenger_dropped_off",
      phase: "ended",
      actor: { type: "driver", id: driverId },
      source: "socket",
      transition: {
        from: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
        to: CARPOOL_BOOKING_STATUS_ENUM.COMPLETED,
      },
      occurredAt: booking.rideCompletedAt,
      references: { routeStopId: booking.dropOffStop?._id },
      dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:dropped_off`,
    },
    carpoolRoute.driver,
  );
  const passengerEntry = carpoolRoute.passengers.find(
    (p) => p.bookingId.toString() === bookingId,
  );
  if (passengerEntry) {
    passengerEntry.status = CARPOOL_BOOKING_STATUS_ENUM.COMPLETED;
  }

  /*
   * Check if ALL accepted passengers are now completed.
   * If yes, mark the entire carpool as completed and clean up Redis.
   */
  const acceptedPassengers = carpoolRoute.passengers.filter(
    (p) =>
      p.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED ||
      p.status === CARPOOL_BOOKING_STATUS_ENUM.COMPLETED,
  );
  const completedPassengers = carpoolRoute.passengers.filter(
    (p) => p.status === CARPOOL_BOOKING_STATUS_ENUM.COMPLETED,
  );
  const allPassengersDone =
    acceptedPassengers.length > 0 &&
    acceptedPassengers.length === completedPassengers.length;

  console.log(
    `[completeCarpoolRideService] Booking completed: ${bookingId}, carpoolId: ${carpoolRoute._id}`,
  );
  console.log(
    `[completeCarpoolRideService] Accepted passengers: ${acceptedPassengers.length}, Completed: ${completedPassengers.length}`,
  );

  if (allPassengersDone) {
    console.log(
      `[completeCarpoolRideService] All passengers completed for carpool: ${carpoolRoute._id}. Marking as COMPLETED.`,
    );
    carpoolRoute.status = CARPOOL_STATUS_ENUM.COMPLETED;
    carpoolRoute.routeCompletedAt = booking.rideCompletedAt;
  }

  // Persist the route roster/status before publishing completion events.
  await carpoolRoute.save();

  if (allPassengersDone) {
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolRoute._id,
        carpoolId: carpoolRoute._id,
        eventType: "carpool.route_completed",
        phase: "ended",
        actor: { type: "driver", id: driverId },
        source: "socket",
        transition: {
          from: CARPOOL_STATUS_ENUM.IN_PROGRESS,
          to: CARPOOL_STATUS_ENUM.COMPLETED,
        },
        occurredAt: booking.rideCompletedAt,
        dedupeKey: `carpool:${carpoolRoute._id}:route_completed`,
      },
      carpoolRoute.driver,
    );

    /* Clean up Redis */
    console.log(
      `[completeCarpoolRideService] Cleaning up Redis for carpool: ${carpoolRoute._id} and driver: ${driverId}`,
    );
    const id =
      role === "driver" ? driverId : booking.carpool?.driver?.toString();
    await Promise.all([
      redis.del(REDIS_CONSTANTS.keys.driverCarpoolActive(id)),
      redis.del(REDIS_CONSTANTS.keys.carpoolRoute(carpoolRoute._id.toString())),
      redis.del(REDIS_CONSTANTS.keys.carpoolSeats(carpoolRoute._id.toString())),
    ]);
    await handleAssignmentEnded(id, io);
    console.log(
      `[completeCarpoolRideService] Redis cleanup completed for carpool: ${carpoolRoute._id}`,
    );
  } else {
    console.log(
      `[completeCarpoolRideService] Carpool still has pending passengers: ${carpoolRoute._id}. Status remains: ${carpoolRoute.status}`,
    );
  }

  /* Remove passenger's active booking ref */
  await redis.del(
    REDIS_CONSTANTS.keys.passengerActiveCarpool(booking.passenger.toString()),
  );

  /*
   * Passenger is already in the carpool room (joined during startCarpoolService).
   * Emit directly there — no per-passenger targeting needed.
   */
  io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
    CARPOOL_SOCKET_EVENTS.RIDE_COMPLETED,
    {
      bookingId,
      carpoolId: carpoolRoute._id,
      fareCharged: booking.fareCharged,
      driverFare: getCarpoolDriverFare(booking),
      rideCompletedAt: booking.rideCompletedAt,
    },
  );

  const passenger = await UserModel.findById(booking.passenger).select(
    "locale",
  );

  sendNotificationToSpecificUser({
    title: t("NOTIFICATION_CARPOOL_COMPLETED_TITLE", passenger?.locale || "en"),
    description: t(
      "NOTIFICATION_CARPOOL_COMPLETED_DESC",
      passenger?.locale || "en",
    ),
    userIds: [booking.passenger],
    role: "user",
    saveToDb: true,
    metadata: {
      type: "CARPOOL_ENDED",
    },
  });

  sendNotificationToSpecificUser({
    title: t("NOTIFICATION_PENDING_REVIEW_TITLE", passenger?.locale || "en"),
    description: t(
      "NOTIFICATION_PENDING_REVIEW_DESC",
      passenger?.locale || "en",
    ),
    userIds: [booking.passenger],
    role: "user",
    metadata: {
      type: "PENDING_REVIEW",
    },
  });

  if (allPassengersDone) {
    io.to(`carpool:${carpoolRoute._id.toString()}`).emit(
      CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE,
      {
        carpoolId: carpoolRoute._id,
        status: carpoolRoute.status,
      },
    );
  }

  return {
    bookingId,
    carpoolCompleted: allPassengersDone,
    rideCompletedAt: booking.rideCompletedAt,
    driverFare: getCarpoolDriverFare(booking),
  };
}

/* ─────────────────────────────────────────────────────────────
   8. CANCEL CARPOOL ROUTE  (driver)
───────────────────────────────────────────────────────────── */
async function cancelCarpoolRouteService(driverId, data, io) {
  const { carpoolId } = data;

  console.log(
    `[Carpool Cancel] Driver ${driverId} requested cancellation for carpool ${carpoolId}`,
  );

  const carpoolRoute = await CarpoolRouteModel.findById(carpoolId);

  /* Edge: route not found */
  if (!carpoolRoute) {
    console.log(`[Carpool Cancel] Carpool ${carpoolId} not found`);
    throw new Error("CARPOOL_ROUTE_NOT_FOUND");
  }

  console.log(`[Carpool Cancel] Current route status: ${carpoolRoute.status}`);

  /* Edge: wrong driver */
  if (carpoolRoute.driver.toString() !== driverId) {
    console.log(
      `[Carpool Cancel] Unauthorized driver. Route belongs to ${carpoolRoute.driver}`,
    );
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  /* Edge: cannot cancel a ride that is already completed */
  if ([CARPOOL_STATUS_ENUM.COMPLETED].includes(carpoolRoute.status)) {
    console.log(
      `[Carpool Cancel] Cannot cancel completed carpool ${carpoolId}`,
    );
    throw new Error("CANNOT_CANCEL_ACTIVE_OR_COMPLETED_CARPOOL");
  }

  /* Edge: already cancelled */
  if (carpoolRoute.status === CARPOOL_STATUS_ENUM.CANCELLED) {
    console.log(`[Carpool Cancel] Carpool ${carpoolId} already cancelled`);
    throw new Error("CARPOOL_ALREADY_CANCELLED");
  }

  /*
   * If driver cancels BEFORE ride start and there is more than one accepted booking,
   * apply suspension.
   */
  const acceptedCount = await CarpoolBookingModel.countDocuments({
    carpool: carpoolId,
    status: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
  });

  console.log(`[Carpool Cancel] Accepted booking count: ${acceptedCount}`);

  if (acceptedCount >= 1) {
    console.log(`[Carpool Cancel] Applying suspension to driver ${driverId}`);
    await handleDriverSuspension(driverId);
    console.log(`[Carpool Cancel] Driver suspension completed`);
  }

  console.log(`[Carpool Cancel] Updating route status to CANCELLED`);

  const previousRouteStatus = carpoolRoute.status;
  carpoolRoute.status = CARPOOL_STATUS_ENUM.CANCELLED;
  carpoolRoute.cancelledBy = "driver";
  carpoolRoute.cancellationReason = "driver_cancelled";
  carpoolRoute.cancelledAt = new Date();
  await carpoolRoute.save();

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      eventType: "carpool.route_cancelled",
      phase: "ended",
      actor: { type: "driver", id: driverId },
      source: "socket",
      transition: {
        from: previousRouteStatus,
        to: CARPOOL_STATUS_ENUM.CANCELLED,
      },
      occurredAt: carpoolRoute.cancelledAt,
      reasonCode: "driver_cancelled",
      dedupeKey: `carpool:${carpoolRoute._id}:route_cancelled`,
    },
    driverId,
  );

  console.log(`[Carpool Cancel] Route ${carpoolId} saved as CANCELLED`);

  /*
   * Cancel all pending and accepted bookings.
   */
  const activeBookings = await CarpoolBookingModel.find({
    carpool: carpoolId,
    status: {
      $in: [
        CARPOOL_BOOKING_STATUS_ENUM.PENDING,
        CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
      ],
    },
  });

  console.log(
    `[Carpool Cancel] Found ${activeBookings.length} active bookings to cancel`,
  );

  for (const booking of activeBookings) {
    console.log(
      `[Carpool Cancel] Processing booking ${booking._id} | Passenger ${booking.passenger} | Previous Status ${booking.status}`,
    );

    const previousBookingStatus = booking.status;
    booking.status = CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;
    booking.cancelledAt = carpoolRoute.cancelledAt;
    await booking.save();

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolRoute._id,
        carpoolId: carpoolRoute._id,
        bookingId: booking._id,
        eventType: "carpool.booking_cancelled",
        phase: "ended",
        actor: { type: "driver", id: driverId },
        source: "socket",
        transition: {
          from: previousBookingStatus,
          to: CARPOOL_BOOKING_STATUS_ENUM.CANCELLED,
        },
        occurredAt: carpoolRoute.cancelledAt,
        reasonCode: "driver_cancelled",
        dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:cancelled`,
      },
      driverId,
    );

    console.log(`[Carpool Cancel] Booking ${booking._id} marked CANCELLED`);

    await redis.del(
      REDIS_CONSTANTS.keys.passengerActiveCarpool(booking.passenger.toString()),
    );

    console.log(
      `[Carpool Cancel] Cleared passenger active carpool cache for ${booking.passenger}`,
    );

    const passenger = await UserModel.findById(booking.passenger).select(
      "locale",
    );

    console.log(
      `[Carpool Cancel] Passenger locale: ${passenger?.locale || "en"}`,
    );

    const bookingRoom = `booking:${booking?._id?.toString()}`;

    console.log(
      `[Carpool Cancel] Emitting BOOKING_STATUS to room ${bookingRoom}`,
    );

    io.to(bookingRoom).emit(CARPOOL_SOCKET_EVENTS.BOOKING_STATUS, {
      bookingId: booking._id,
      status: "cancelled",
      reason: t("CARPOOL_CANCELLED_BY_DRIVER", passenger?.locale || "en"),
      driverFare: getCarpoolDriverFare(booking),
    });

    console.log(
      `[Carpool Cancel] Sending push notification to passenger ${booking.passenger}`,
    );

    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_CARPOOL_CANCELLED_BY_DRIVER_TITLE",
        passenger?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_CARPOOL_CANCELLED_BY_DRIVER_DESC",
        passenger?.locale || "en",
      ),
      userIds: [booking.passenger],
      role: "user",
      metadata: {
        type: "CARPOOL_CANCELLED",
      },
    });

    console.log(`[Carpool Cancel] Removing sockets from room ${bookingRoom}`);

    io.in(bookingRoom).socketsLeave(bookingRoom);

    console.log(`[Carpool Cancel] Finished processing booking ${booking._id}`);
  }

  console.log(`[Carpool Cancel] Cleaning Redis keys for carpool ${carpoolId}`);

  await Promise.all([
    redis.del(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId)),
    redis.del(REDIS_CONSTANTS.keys.carpoolRoute(carpoolId)),
    redis.del(REDIS_CONSTANTS.keys.carpoolSeats(carpoolId)),
  ]);
  await handleAssignmentEnded(driverId, io);

  console.log(`[Carpool Cancel] Redis cleanup completed`);

  console.log(
    `[Carpool Cancel] Emitting ROUTE_UPDATE for carpool ${carpoolId}`,
  );

  io.to(`carpool:${carpoolId}`).emit(CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE, {
    carpoolId,
    status: CARPOOL_STATUS_ENUM.CANCELLED,
  });

  console.log(
    `[Carpool Cancel] Cancellation flow completed successfully for carpool ${carpoolId}`,
  );

  return {
    carpoolId,
    status: CARPOOL_STATUS_ENUM.CANCELLED,
  };
}

/* ─────────────────────────────────────────────────────────────
   9. ARRIVE AT STOP  (driver marks a route stop as arrived)
   - Marks the given stop as "arrived"
   - Marks the immediately next stop (by order) as "coming"
   - Broadcasts STOP_ARRIVED to the shared carpool room
───────────────────────────────────────────────────────────── */
async function arriveAtStopService(driverId, data, io) {
  const { carpoolId, routeStopId } = data;

  console.log(
    `[arriveAtStopService] Starting for carpoolId: ${carpoolId}, routeStopId: ${routeStopId}, driverId: ${driverId}`,
  );

  const carpoolRoute = await CarpoolRouteModel.findById(carpoolId);

  if (!carpoolRoute) {
    console.error(`[arriveAtStopService] Carpool not found: ${carpoolId}`);
    throw new Error("CARPOOL_ROUTE_NOT_FOUND");
  }

  if (carpoolRoute.driver.toString() !== driverId) {
    console.error(
      `[arriveAtStopService] Unauthorized driver. Expected: ${carpoolRoute.driver}, Got: ${driverId}`,
    );
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  if (carpoolRoute.status !== CARPOOL_STATUS_ENUM.IN_PROGRESS) {
    console.error(
      `[arriveAtStopService] Invalid carpool state: ${carpoolRoute.status}`,
    );
    throw new Error("CARPOOL_INVALID_STATE_FOR_ARRIVE");
  }

  /* Find the target stop */
  const arrivedStop = carpoolRoute.routes.find(
    (s) => s._id.toString() === routeStopId,
  );

  if (!arrivedStop) {
    console.error(`[arriveAtStopService] Route stop not found: ${routeStopId}`);
    throw new Error("ROUTE_STOP_NOT_FOUND");
  }

  if (arrivedStop.status === "arrived") {
    console.warn(`[arriveAtStopService] Stop already arrived: ${routeStopId}`);
    throw new Error("STOP_ALREADY_ARRIVED");
  }

  console.log(
    `[arriveAtStopService] Marking stop as arrived: ${arrivedStop.placeName} (order: ${arrivedStop.order})`,
  );
  arrivedStop.status = "arrived";

  /*
   * Find the next stop by order (strictly greater, closest order wins).
   * Mark it as "coming" so passengers know it's the next pickup point.
   */
  const nextStop = carpoolRoute.routes
    .filter((s) => s.order > arrivedStop.order && s.status !== "arrived")
    .sort((a, b) => a.order - b.order)[0];

  if (nextStop) {
    console.log(
      `[arriveAtStopService] Marking next stop as coming: ${nextStop.placeName} (order: ${nextStop.order})`,
    );
    nextStop.status = "coming";
  } else {
    console.log(
      `[arriveAtStopService] No next stop found for carpool: ${carpoolId}`,
    );
  }

  await carpoolRoute.save();
  console.log(`[arriveAtStopService] Carpool route saved for: ${carpoolId}`);

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      eventType: "carpool.stop_arrived",
      phase: "waiting_pickup",
      actor: { type: "driver", id: driverId },
      source: "socket",
      references: { routeStopId: arrivedStop._id },
      dedupeKey: `carpool:${carpoolRoute._id}:stop:${arrivedStop._id}:arrived`,
      metadata: {
        stopName: arrivedStop.placeName,
        stopOrder: arrivedStop.order,
        plannedLocation: arrivedStop.location,
      },
    },
    driverId,
  );

  if (nextStop) {
    await recordJourneyEvent({
      journeyType: "carpool",
      journeyId: carpoolRoute._id,
      carpoolId: carpoolRoute._id,
      eventType: "carpool.stop_coming",
      phase: "to_pickup",
      actor: { type: "driver", id: driverId },
      source: "service",
      location: nextStop.location,
      locationSource: "planned_stop",
      references: { routeStopId: nextStop._id },
      dedupeKey: `carpool:${carpoolRoute._id}:stop:${nextStop._id}:coming`,
      metadata: {
        stopName: nextStop.placeName,
        stopOrder: nextStop.order,
      },
    });
  }

  /* Broadcast to everyone in the carpool room (driver + all passengers) */
  console.log(
    `[arriveAtStopService] Broadcasting to room carpool:${carpoolId}`,
  );
  io.to(`carpool:${carpoolId}`).emit(CARPOOL_SOCKET_EVENTS.STOP_ARRIVED, {
    carpoolId,
    arrivedStop: {
      _id: arrivedStop._id,
      placeName: arrivedStop.placeName,
      order: arrivedStop.order,
      status: arrivedStop.status,
    },
    nextStop: nextStop
      ? {
          _id: nextStop._id,
          placeName: nextStop.placeName,
          order: nextStop.order,
          status: nextStop.status,
        }
      : null,
  });

  const waitingBookings = await CarpoolBookingModel.find({
    carpool: carpoolId,
    "pickupStop._id": arrivedStop._id,
    status: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
  }).select("passenger");

  if (waitingBookings.length > 0) {
    const passengerIds = waitingBookings.map((b) => b.passenger);
    const passengers = await UserModel.find({
      _id: { $in: passengerIds },
    }).select("_id locale");
    const passengerIdsByLocale = passengers.reduce((groups, passenger) => {
      const locale = passenger.locale || "en";
      if (!groups[locale]) groups[locale] = [];
      groups[locale].push(passenger._id);
      return groups;
    }, {});

    console.log(
      "🚗 [DRIVER ARRIVAL AT STOP] Sending driver arrival notification to waiting passengers:",
      {
        carpoolId,
        stopId: arrivedStop._id,
        stopName: arrivedStop.placeName,
        passengerIds,
        locales: Object.keys(passengerIdsByLocale),
      },
    );
    await Promise.all(
      Object.entries(passengerIdsByLocale).map(([locale, localizedIds]) =>
        sendNotificationToSpecificUser({
          title: t("NOTIFICATION_DRIVER_ARRIVED_AT_STOP_TITLE", locale),
          description: t("NOTIFICATION_DRIVER_ARRIVED_AT_STOP_DESC", locale),
          userIds: localizedIds,
          role: "user",
          metadata: {
            type: "CARPOOL",
          },
        }),
      ),
    );
  }

  console.log(`[arriveAtStopService] Completed for carpoolId: ${carpoolId}`);
  return {
    arrivedStop,
    nextStop: nextStop ?? null,
  };
}

async function incomingCarpoolMatches(passengerId, data) {
  const finalMatches = await findMatchingCarpoolRoutes(passengerId, data, true);

  finalMatches.forEach((match) => {
    match.isRequestSent = match?.passengers?.some(
      (passenger) => passenger.user == passengerId,
    );
  });

  return {
    data: { routes: finalMatches },
  };
}

async function carpoolPassengers(carpoolId) {
  const carpool = await CarpoolRouteModel.findOne({ _id: carpoolId })
    .populate("passengers.bookingId")
    .populate("passengers.user", "firstName lastName profilePicture rating")
    .lean();

  if (!carpool) {
    throw new NotFoundError(`Carpool with ID ${carpoolId} not found`);
  }

  return {
    data: {
      carpoolId: carpool._id,
      passengers: getUniqueVisiblePassengers(carpool.passengers).map(
        (passenger) => ({
          passengerId: passenger.user._id,
          firstName: passenger.user.firstName,
          lastName: passenger.user.lastName,
          profilePicture: passenger.user.profilePicture,
          rating: passenger.user.rating,
          pickup: passenger.pickupStop.placeName,
          status: passenger.status,
          dropOff: passenger.dropOffStop.placeName,
          bookingId: passenger.bookingId._id,
          otpVerified: passenger.bookingId.otpVerified,
          fareCharged: passenger.bookingId.fareCharged,
          driverFare: getCarpoolDriverFare(passenger.bookingId),
          avgTime: passenger.bookingId.avgTime,
          distance: passenger.bookingId.distance,
          requiredSeats: passenger.bookingId?.requiredSeats,
        }),
      ),
    },
  };
}

async function carpoolHistory(
  id,
  role,
  page = 1,
  limit = 10,
  status,
  options = {},
) {
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const dataOnly = options.dataOnly === true;

  const matchStage = {
    ...(role === "driver"
      ? { driver: new mongoose.Types.ObjectId(id) }
      : { "passengers.user": new mongoose.Types.ObjectId(id) }),
    status: status
      ? status
      : { $in: [CARPOOL_STATUS_ENUM.COMPLETED, CARPOOL_STATUS_ENUM.CANCELLED] },
    ...(options.additionalMatch || {}),
  };

  const driverDetailsPipeline = [
    // Lookup driver with nested vehicle details
    {
      $lookup: {
        from: "drivers",
        localField: "driver",
        foreignField: "_id",
        as: "driver",
        pipeline: [
          {
            $lookup: {
              from: "vehicles",
              localField: "vehicleDetails",
              foreignField: "_id",
              as: "vehicleDetails",
              pipeline: [
                {
                  $project: {
                    make: 1,
                    model: 1,
                    yearOfManufacture: 1,
                    color: 1,
                    licensePlateNumber: 1,
                    vehicleType: 1,
                  },
                },
              ],
            },
          },
          {
            $unwind: {
              path: "$vehicleDetails",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              firstName: 1,
              lastName: 1,
              email: 1,
              profilePicture: 1,
              rating: 1,
              vehicleDetails: 1,
            },
          },
        ],
      },
    },
    {
      $unwind: {
        path: "$driver",
        preserveNullAndEmptyArrays: true,
      },
    },
  ];

  const aggregatePipeline = [
    { $match: matchStage },
    ...(dataOnly && role === "driver"
      ? [
          { $sort: { createdAt: -1 } },
          { $skip: (parsedPage - 1) * parsedLimit },
          { $limit: parsedLimit },
        ]
      : []),
    ...(!dataOnly ? driverDetailsPipeline : []),

    // DRIVER FLOW
    ...(role === "driver"
      ? [
          {
            $lookup: {
              from: "carpoolbookings",
              let: { carpoolId: "$_id" },
              pipeline: [
                {
                  $match: {
                    ...(options.bookingMatch || {}),
                    $expr: {
                      $and: [
                        { $eq: ["$carpool", "$$carpoolId"] },
                        {
                          $eq: [
                            "$status",
                            CARPOOL_BOOKING_STATUS_ENUM.COMPLETED,
                          ],
                        },
                      ],
                    },
                  },
                },
                {
                  $group: {
                    _id: null,
                    totalFareCharged: { $sum: "$fareCharged" },
                    totalDriverFare: { $sum: carpoolDriverFareExpression },
                    totalDistance: { $sum: "$distance" },
                    totalPassengers: { $sum: 1 },
                    totalRequiredSeats: { $sum: "$requiredSeats" }, // ✅ added
                  },
                },
              ],
              as: "bookingsSummary",
            },
          },
          {
            $unwind: {
              path: "$bookingsSummary",
              preserveNullAndEmptyArrays: true,
            },
          },
        ]
      : []),

    // PASSENGER FLOW
    ...(role !== "driver"
      ? [
          ...(dataOnly
            ? [
                {
                  $lookup: {
                    from: "carpoolbookings",
                    localField: "_id",
                    foreignField: "carpool",
                    pipeline: [{ $match: options.bookingMatch || {} }],
                    as: "myBooking",
                  },
                },
                {
                  $set: {
                    myBooking: {
                      $map: {
                        input: {
                          $filter: {
                            input: "$myBooking",
                            as: "booking",
                            cond: {
                              $and: [
                                { $eq: ["$$booking.carpool", "$_id"] },
                                {
                                  $eq: [
                                    "$$booking.passenger",
                                    new mongoose.Types.ObjectId(id),
                                  ],
                                },
                              ],
                            },
                          },
                        },
                        as: "booking",
                        in: {
                          $mergeObjects: [
                            "$$booking",
                            {
                              driverFare: {
                                $let: {
                                  vars: { CURRENT: "$$booking" },
                                  in: carpoolDriverFareExpression,
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              ]
            : [
                {
                  $lookup: {
                    from: "carpoolbookings",
                    let: { carpoolId: "$_id" },
                    pipeline: [
                      {
                        $match: {
                          ...(options.bookingMatch || {}),
                          $expr: {
                            $and: [
                              { $eq: ["$carpool", "$$carpoolId"] },
                              {
                                $eq: [
                                  "$passenger",
                                  new mongoose.Types.ObjectId(id),
                                ],
                              },
                            ],
                          },
                        },
                      },
                      {
                        $project: {
                          avgTime: 1,
                          distance: 1,
                          fareCharged: 1,
                          driverFare: carpoolDriverFareExpression,
                          paymentMethod: 1,
                          paymentStatus: 1,
                          pickupStop: 1,
                          dropOffStop: 1,
                          requiredSeats: 1, // ✅ added
                          status: 1,
                        },
                      },
                    ],
                    as: "myBooking",
                  },
                },
              ]),
          {
            $unwind: {
              path: "$myBooking",
              preserveNullAndEmptyArrays: true,
            },
          },
        ]
      : []),

    {
      $project: {
        driver: 1,
        startingPoint: 1,
        destination: 1,
        routes: 1,
        status: 1,
        cancelledBy: 1,
        cancellationReason: 1,
        maxPassengers: 1,
        availableSeats: 1,
        graceTime: 1,
        createdAt: 1,

        avgTime: role === "driver" ? "$avgTime" : "$myBooking.avgTime",

        distance:
          role === "driver"
            ? "$bookingsSummary.totalDistance"
            : "$myBooking.distance",

        fareCharged:
          role === "driver"
            ? "$bookingsSummary.totalFareCharged"
            : "$myBooking.fareCharged",

        driverFare:
          role === "driver"
            ? "$bookingsSummary.totalDriverFare"
            : "$myBooking.driverFare",

        // ✅ requiredSeats added here
        requiredSeats:
          role === "driver"
            ? "$bookingsSummary.totalRequiredSeats"
            : "$myBooking.requiredSeats",

        ...(role === "driver" && {
          bookingsSummary: {
            totalFareCharged: "$bookingsSummary.totalFareCharged",
            totalDriverFare: "$bookingsSummary.totalDriverFare",
            totalDistance: "$bookingsSummary.totalDistance",
            totalPassengers: "$bookingsSummary.totalPassengers",
            totalRequiredSeats: "$bookingsSummary.totalRequiredSeats", // ✅ added
          },
        }),

        ...(role !== "driver" && {
          booking: {
            paymentMethod: "$myBooking.paymentMethod",
            paymentStatus: "$myBooking.paymentStatus",
            pickupStop: "$myBooking.pickupStop",
            dropOffStop: "$myBooking.dropOffStop",
            status: "$myBooking.status",
            requiredSeats: "$myBooking.requiredSeats", // ✅ added
            driverFare: "$myBooking.driverFare",
          },
        }),
      },
    },
  ];

  let pagination;
  let skip = (parsedPage - 1) * parsedLimit;
  if (!dataOnly) {
    const paginated = await aggregatePaginate(
      CarpoolRouteModel,
      aggregatePipeline,
      parsedPage,
      parsedLimit,
    );
    pagination = paginated.pagination;
    skip = paginated.skip;
  }
  // Passenger bookings can produce multiple rows for one route. Keep their
  // pagination after the booking unwind, including on the admin profile.
  if (!dataOnly || role !== "driver") {
    aggregatePipeline.push(
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: parsedLimit },
    );
  }
  if (dataOnly) aggregatePipeline.push(...driverDetailsPipeline);

  const carpools = await CarpoolRouteModel.aggregate(aggregatePipeline);

  return {
    data: carpools,
    ...(!dataOnly && { pagination }),
  };
}

async function getCarpoolById(id) {
  const aggregatePipeline = [
    { $match: { _id: new mongoose.Types.ObjectId(id) } },

    {
      $lookup: {
        from: "drivers",
        localField: "driver",
        foreignField: "_id",
        as: "driver",
        pipeline: [
          {
            $lookup: {
              from: "vehicles",
              localField: "vehicleDetails",
              foreignField: "_id",
              as: "vehicleDetails",
              pipeline: [
                {
                  $project: {
                    make: 1,
                    model: 1,
                    yearOfManufacture: 1,
                    color: 1,
                    licensePlateNumber: 1,
                    vehicleType: 1,
                  },
                },
              ],
            },
          },
          {
            $unwind: {
              path: "$vehicleDetails",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              firstName: 1,
              lastName: 1,
              email: 1,
              profilePicture: 1,
              rating: 1,
              vehicleDetails: 1,
            },
          },
        ],
      },
    },
    { $unwind: { path: "$driver", preserveNullAndEmptyArrays: true } },

    // Lookup passenger user details
    {
      $lookup: {
        from: "users",
        localField: "passengers.user",
        foreignField: "_id",
        as: "passengerUsers",
        pipeline: [
          {
            $project: {
              firstName: 1,
              lastName: 1,
              email: 1,
              profilePicture: 1,
              rating: 1,
            },
          },
        ],
      },
    },

    {
      $lookup: {
        from: "carpoolbookings",
        let: { carpoolId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ["$carpool", "$$carpoolId"] },
              status: { $nin: ["cancelled", "rejected", "completed"] },
            },
          },
          { $addFields: { driverFare: carpoolDriverFareExpression } },
        ],
        as: "bookings",
      },
    },

    {
      $addFields: {
        passengers: {
          $map: {
            input: "$passengers",
            as: "p",
            in: {
              $mergeObjects: [
                "$$p",
                {
                  user: {
                    $arrayElemAt: [
                      {
                        $filter: {
                          input: "$passengerUsers",
                          as: "u",
                          cond: { $eq: ["$$u._id", "$$p.user"] },
                        },
                      },
                      0,
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    },

    { $unset: "passengerUsers" },

    // Final projection
    {
      $project: {
        driver: 1,
        startingPoint: 1,
        destination: 1,
        routes: 1,
        status: 1,
        maxPassengers: 1,
        availableSeats: 1,
        graceTime: 1,
        avgTime: 1,
        distance: 1,
        passengers: 1,
        bookings: 1,
        createdAt: 1,
      },
    },
  ];

  const [carpool] = await CarpoolRouteModel.aggregate(aggregatePipeline);

  if (carpool) {
    carpool.passengers = getUniqueVisiblePassengers(carpool.passengers);
  }

  return { data: { carpool: carpool ?? null } };
}

async function generateSharedCarpoolLink(carpoolId, locale, passengerId) {
  const carpool = await CarpoolRouteModel.findById(carpoolId);

  if (!carpool) throw new NotFoundError("CARPOOL_NOT_FOUND_OR_DELETED");

  const encodedURL = encodeSharedLink(
    carpool._id.toString(),
    locale,
    "carpool",
  );

  const fullLink = `${encodedURL}&passengerId=${passengerId}`;

  return {
    data: {
      url: fullLink,
    },
  };
}

async function carpoolDetails(id, userId, role) {
  if (role === "user") {
    const [booking, review] = await Promise.all([
      CarpoolBookingModel.findOne({ carpool: id, passenger: userId })
        .populate({
          path: "driver",
          select:
            "firstName lastName profilePicture rating vehicleDetails vehicleType",
        })
        .populate({ path: "carpool", select: "routes" })
        .lean(),

      ReviewModel.findOne({
        reviewer: userId,
        reviewerType: "User",
        carpool: id,
        isDeleted: false,
      })
        .select("stars description isAnonymous")
        .lean(),
    ]);

    if (!booking) throw new Error("Booking not found");

    const transaction = await TransactionModel.findOne({
      "metadata.bookingId": booking?._id?.toString(),
    })
      .populate("card", "brand last4")
      .select("amount type user userType status")
      .lean();

    const relevantStops = booking.carpool.routes.map((stop, index, arr) => ({
      label:
        index === arr.length - 1 ? "Your Drop Location" : `Stop ${index + 1}`,
      placeName: stop.placeName,
      location: stop.location,
      status: stop.status,
    }));

    return {
      data: {
        driver: booking.driver,
        stops: relevantStops,
        totalSeatsBooked: booking.requiredSeats ?? 1,
        requiredSeats: booking.requiredSeats ?? 1,
        avgTime: booking.avgTime ?? 0,
        distance: booking.distance ?? 0,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        fareCharged: booking.fareCharged,
        driverFare: getCarpoolDriverFare(booking),
        status: booking.status,
        review: review ?? null,
        transaction: transaction ?? null,
      },
    };
  }

  if (role === "driver") {
    const route = await CarpoolRouteModel.findById(id)
      .populate({
        path: "passengers.user",
        select: "firstName lastName profilePicture",
      })
      .lean();

    if (!route) throw new Error("Carpool not found");
    if (route.driver.toString() !== userId.toString())
      throw new Error("Forbidden");

    const passengers = getUniqueVisiblePassengers(route.passengers);

    const [totalRevenue, transactions] = await Promise.all([
      CarpoolBookingModel.aggregate([
        { $match: { carpool: route._id, status: "completed" } },
        {
          $group: {
            _id: null,
            totalFareCharged: { $sum: "$fareCharged" },
            totalDriverFare: { $sum: carpoolDriverFareExpression },
          },
        },
      ]),
      TransactionModel.find({
        "metadata.bookingId": {
          $in: passengers.map((p) => p.bookingId).filter(Boolean),
        },
      })
        .populate("card", "brand last4")
        .select("amount type user userType status metadata")
        .lean(),
    ]);

    return {
      data: {
        startingPoint: route.startingPoint,
        destination: route.destination,
        routes: route.routes,
        status: route.status,
        graceTime: route.graceTime,
        avgTime: route.avgTime ?? 0,
        distance: route.distance ?? 0,
        maxPassengers: route.maxPassengers,
        availableSeats: route.availableSeats,
        passengers,
        totalRevenue: totalRevenue[0]?.totalDriverFare ?? 0,
        fareCharged: totalRevenue[0]?.totalFareCharged ?? 0,
        driverFare: totalRevenue[0]?.totalDriverFare ?? 0,
        transactions,
      },
    };
  }

  throw new Error(`Invalid role "${role}"`);
}

async function viewCarpoolPassengers(carpoolId, driverId) {
  const route = await CarpoolRouteModel.findById(carpoolId)
    .select("driver passengers")
    .populate({
      path: "passengers.user",
      select: "firstName lastName profilePicture rating",
    })
    .lean();

  if (!route) throw new NotFoundError("Carpool not found");
  if (route.driver.toString() !== driverId.toString())
    throw new ForbiddenError("You cannot see someone else's carpool");

  const routePassengers = getUniqueVisiblePassengers(route.passengers);
  const passengerUserIds = routePassengers.map((p) => p.user._id);
  const bookingIds = routePassengers.map((p) => p.bookingId).filter(Boolean);

  const [bookings, reviews] = await Promise.all([
    CarpoolBookingModel.find({
      carpool: carpoolId,
      _id: { $in: bookingIds },
    })
      .select(
        "passenger pickupStop dropOffStop fareCharged originalFare discountAmount status requiredSeats avgTime distance",
      )
      .lean(),

    // Reviews the driver has given to passengers in this carpool
    ReviewModel.find({
      carpool: carpoolId,
      reviewerType: "Driver",
      reviewer: driverId,
      receiverType: "User",
      receiver: { $in: passengerUserIds },
    })
      .select("receiver stars description isAnonymous")
      .lean(),
  ]);

  const bookingMap = Object.fromEntries(
    bookings.map((b) => [b._id.toString(), b]),
  );

  // Keyed by receiver (the passenger) instead of reviewer
  const reviewMap = Object.fromEntries(
    reviews.map((r) => [r.receiver.toString(), r]),
  );

  const passengers = routePassengers.map((p, index) => {
    const uid = p.user._id.toString();
    const booking = bookingMap[p.bookingId?.toString()];
    const review = reviewMap[uid];

    return {
      label: `Passenger ${index + 1} Details`,
      user: p.user,
      pickupStop: booking?.pickupStop ?? p.pickupStop,
      dropOffStop: booking?.dropOffStop ?? p.dropOffStop,
      totalSeatsBooked: booking?.requiredSeats ?? 1,
      requiredSeats: booking?.requiredSeats ?? 1,
      avgTime: booking?.avgTime ?? 0,
      distance: booking?.distance ?? 0,
      fareCharged: booking?.fareCharged ?? 0,
      driverFare: getCarpoolDriverFare(booking),
      status: booking?.status ?? p.status,
      review: review
        ? {
            stars: review.stars,
            description: review.description,
            isAnonymous: review.isAnonymous,
          }
        : null,
    };
  });

  return { data: { passengers } };
}

module.exports = {
  createCarpoolRouteService,
  findMatchingCarpoolRoutes,
  joinCarpoolService,
  respondToPassengerService,
  startCarpoolService,
  pickPassengerService,
  completeCarpoolRideService,
  cancelCarpoolRouteService,
  arriveAtStopService,
  getActiveCarpoolForDriver,
  getActiveCarpoolForPassenger,
  incomingCarpoolMatches,
  carpoolPassengers,
  carpoolHistory,
  getCarpoolById,
  generateSharedCarpoolLink,
  carpoolDetails,
  viewCarpoolPassengers,
};
