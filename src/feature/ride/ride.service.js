const RideModel = require("./model/ride.model");
const TransactionModel = require("../transactions/model/transaction.model");
const {
  rideStartPaymentKey,
} = require("../transactions/payment-attempt.helper");
const {
  getWalletAllocation,
  transactionRewardFields,
} = require("../wallet/wallet.service");
const ReviewModel = require("../reviews/models/review.model");
const RideRateModel = require("./model/ride-rate.model");
const CityRideRateModel = require("./model/city-ride-rate.model");
const {
  normalizeCity,
  findMileageBracket,
  calculateCityFare,
} = require("./fare-pricing.helper");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  RIDE_SOCKET_EVENTS,
  RIDE_STATUS,
  RIDE_STARTABLE_STATUSES,
  allowedTransitions,
  USER,
  DRIVER,
  RIDE,
  SESSION,
  PENDING,
  ACTIVE,
  DRIVER_SOCKET_EVENTS,
  CANCELLATION_FEE,
  CANCELLATIONS,
  DESTINATION,
  PICKUP,
  OFFER_VALIDITY_SECONDS,
  SOCKET,
} = require("../../core/common/constants/ride-constants");
const {
  getRideDistanceConfigurationForRuntime,
} = require("../config/ride-configuration.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  generateNumericOTP,
  isPeakTime,
  aggregatePaginate,
  t,
  encodeSharedLink,
  parseRide,
  secondsToWords,
} = require("../../core/common/helpers");
const RideOtpModel = require("./model/ride-otp.model");
const DriverModel = require("../driver/models/driver.model");
const StripeService = require("../../core/services/stripe/stripe.service");
const UserModel = require("../user/models/user.model");
const CardModel = require("../card/models/card.model");
const { default: mongoose } = require("mongoose");
const {
  BadRequestError,
  NotFoundError,
  AppError,
} = require("../../core/common/exceptions");
const LoggedDeviceModel = require("../auth/models/logged.device.model");
const {
  sendNotificationToSpecificUser,
  saveNotification,
} = require("../notification/notification.service");
const RideOfferModel = require("./model/ride-offer.model");
const { canAffordRideOffer } = require("./ride-offer.helper");
const { removePassengerPresence } = require("./high-demand.service");
const {
  getDriverFare,
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const { recordJourneyEvent } = require("../journey-log/journey-log.service");
const {
  claimReferralForRide,
  releaseReferralForRide,
  settleReferralForCompletedRide,
  voidReferralForRide,
} = require("../driver-referral/driver-referral.service");
const {
  resolveFullRequestFare,
  shouldReturnReferralCode,
} = require("../driver-referral/driver-referral.helper");
const {
  enqueueJourneyEventWithDriverLocation: recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.producer");
const {
  canDriverAcceptAssignment,
  handleAssignmentEnded,
} = require("../driver/driver-shift.service");
const { getRideHistoryVisibilityFilter } = require("./ride-history.helper");
const {
  startDispatch,
  withdrawRideFromOtherDrivers,
} = require("./ride-dispatch.service");
const {
  cancelPendingRings,
  cancelUpgradeDecision,
} = require("./ride-dispatch.producer");
const {
  creditDriverForRide,
  isFreeRide,
  normalizeMoney,
} = require("./ride-settlement.helper");
const {
  acquireAssignmentLock,
  releaseAssignmentLock,
} = require("./assignment-lock.helper");
const {
  acceptPendingOffer,
  cancelPendingOffersForDriver,
  rejectPendingOffer,
} = require("./ride-offer-state.helper");

const redis = getRedisConnection();

function validateTransition(current, next) {
  return allowedTransitions[current]?.includes(next);
}

function getRideStatusEventType(status) {
  return {
    accepted: "ride.driver_assigned",
    arrived: "ride.driver_arrived",
    coming: "ride.passenger_coming",
    "in-progress": "ride.started",
    completed: "ride.completed",
    cancelled: "ride.cancelled",
  }[status];
}

function getRidePhase(status) {
  return {
    requested: "pre_assignment",
    accepted: "to_pickup",
    arrived: "waiting_pickup",
    coming: "waiting_pickup",
    "in-progress": "on_trip",
    completed: "ended",
    cancelled: "ended",
  }[status];
}

// ─── createRideRequestService ─────────────────────────────────────────────────
// Change: private rides skip direct INCOMING emit — drivers get it but
// their acceptance creates an *offer* instead of locking the ride.
// Non-private rides keep exact same flow.

/**
 * `onRideCreated` runs after the ride exists but before the first ring opens.
 * The socket layer uses it to put the rider in the ride room, so the very first
 * dispatch status event has somebody listening for it.
 */
/**
 * Whether this rider can actually pay this fare, right now.
 *
 * Shared by the request handler and the upgrade path on purpose: an upgrade
 * costs more than the fare the rider was originally cleared for, and a second
 * implementation of this check is a second place for the two to drift apart.
 *
 * Returns `null` when the rider is good for it, or a reason code the caller
 * turns into a message.
 */
async function assertRiderCanPayFare(user, { rideFare, paymentMethod }) {
  // A fully discounted ride costs the rider nothing, so there is nothing to
  // check a balance or a card against. Demanding either would block a ride that
  // never touches a payment rail.
  if (Number(rideFare ?? 0) <= 0) return null;

  if (paymentMethod === "wallet") {
    const available = (user.balance || 0) + (user.rewardedBalance || 0);
    return available < rideFare ? "INSUFFICIENT_WALLET_BALANCE" : null;
  }

  if (paymentMethod === "attached_card") {
    const card = await CardModel.findOne({
      user: user._id,
      status: "active",
      default: true,
    });

    return card ? null : "NO_ACTIVE_CARD";
  }

  return null;
}

async function createRideRequestService(
  user,
  data,
  io,
  { onRideCreated } = {},
) {
  const [activeRide, pendingRide] = await Promise.all([
    redis.get(`${USER}:${user._id}:${RIDE}:${ACTIVE}`),
    redis.get(`${USER}:${user._id}:${RIDE}:${PENDING}`),
  ]);

  if (activeRide || pendingRide)
    throw new Error("USER_ALREADY_HAS_ACTIVE_RIDE");

  // The id is drawn first so a saved driver referral can be claimed for this
  // exact ride before any driver is shown its fare. The server prices the
  // referral itself; the app sends the full fare.
  const rideId = new mongoose.Types.ObjectId();
  const referralClaim = await claimReferralForRide({
    riderId: user._id,
    rideId,
    fullFare: resolveFullRequestFare(data),
  });

  // A referral and a promo code never share a ride, so a claimed referral
  // replaces whatever promo the app sent.
  const pricing = referralClaim
    ? {
        rideFare: referralClaim.pricing.rideFare,
        originalRideFare: referralClaim.pricing.originalRideFare,
        discountAmount: referralClaim.pricing.discountAmount,
        riderReferral: referralClaim.referral._id,
      }
    : {
        rideFare: Number(data.rideFare),
        ...(data.codeId && {
          codeId: data.codeId,
          campaignId: data.campaignId,
          originalRideFare: data.originalRideFare,
          // Without this the ride start never writes the redemption (it only
          // runs when `discountAmount > 0`), so per-rider and total campaign
          // limits were never counted.
          discountAmount: Math.max(
            Number(
              (Number(data.originalRideFare) - Number(data.rideFare)).toFixed(
                2,
              ),
            ) || 0,
            0,
          ),
        }),
      };

  let ride;
  try {
    ride = await RideModel.create({
      _id: rideId,
      user: user._id,
      pickupPoint: data.pickupPoint,
      pickupCity: data.pickupCity,
      dropOffPointRequested: data.dropOffPoint,
      rideType: data.rideType,
      specialRequest: data.specialRequest,
      rideDistance: Number(data.rideDistance),
      averageTime: Number(data.averageTime),
      paymentMethod: data.paymentMethod,
      rideStatus: RIDE_STATUS.REQUESTED,
      requestedAt: new Date(),
      ...pricing,
    });
  } catch (error) {
    // The ride never existed, so the rider must not lose their code to it.
    if (referralClaim) await releaseReferralForRide(rideId);
    throw error;
  }

  if (!ride) throw new Error("UNABLE_TO_REQUEST_RIDE");

  await recordJourneyEvent({
    journeyType: "ride",
    journeyId: ride._id,
    rideId: ride._id,
    eventType: "ride.requested",
    phase: "pre_assignment",
    actor: { type: "user", id: user._id },
    source: "socket",
    transition: { from: null, to: RIDE_STATUS.REQUESTED },
    location: ride.pickupPoint?.location,
    locationSource: "planned_stop",
    dedupeKey: `ride:${ride._id}:requested`,
    metadata: {
      rideType: ride.rideType,
      plannedPickupName: ride.pickupPoint?.placeName,
      plannedDropOffName: ride.dropOffPointRequested?.placeName,
    },
  });

  const rideRequestId = ride._id;

  // The request window that outlives the dispatch ladder: if every ring is
  // exhausted the dispatcher closes the ride long before this TTL, so this is
  // only the backstop for a process that died mid-ladder.
  const sessionTTL = REDIS_CONSTANTS.RIDE_SESSION_TTL;

  await redis.set(
    `${USER}:${user._id}:${RIDE}:${PENDING}`,
    rideRequestId,
    REDIS_CONSTANTS.EX,
    sessionTTL,
  );

  const sessionKey = `${RIDE}:${SESSION}:${rideRequestId}`;
  await redis.set(sessionKey, user._id, REDIS_CONSTANTS.EX, sessionTTL);

  if (onRideCreated) await onRideCreated(rideRequestId);

  // Ring 0 runs inline, so the closest drivers are pinged in the same breath as
  // the request. Every wider ring after it is scheduled by the dispatcher.
  const dispatch = await startDispatch({ rideId: rideRequestId, io });

  return {
    rideRequestId,
    dispatch,
    // What the rider will be charged, so the app can show the referral
    // discount the server applied rather than the fare it sent.
    fare: {
      rideFare: ride.rideFare,
      originalRideFare: ride.originalRideFare || null,
      discountAmount: ride.discountAmount ?? null,
      referralApplied: Boolean(ride.riderReferral),
    },
  };
}

/**
 * The list of open requests a driver can still take, from wherever they are
 * standing right now. Used to refresh a driver whose screen just went stale —
 * either because somebody else won the ride, or because they lost the race.
 */
async function refreshDriverRequestList(driverId) {
  try {
    const driver = await DriverModel.findById(driverId).select("vehicleType");
    if (!driver) return [];

    const result = await getRidesForDriverService(
      driver,
      RIDE_STATUS.REQUESTED,
      1,
      10,
    );

    return result?.data ?? result ?? [];
  } catch (error) {
    // A stale list is a far smaller problem than a failed acceptance, so this
    // never propagates.
    console.error(
      `Could not refresh the request list for driver ${driverId}:`,
      error.message,
    );
    return [];
  }
}

// ─── createRideOfferService (NEW — private rides only) ────────────────────────
// Driver "accepts" a private ride → creates a 10-sec offer, notifies user.
async function createRideOfferService(driverId, rideRequestId, io) {
  const shiftGuard = await canDriverAcceptAssignment(driverId);
  if (!shiftGuard.allowed) throw new Error("SHIFT_EXCEEDED_ONLINE");

  // Guard: driver must not already be on a ride
  const existingDriverRide = await redis.get(
    `${DRIVER}:${driverId}:${RIDE}:${ACTIVE}`,
  );
  if (existingDriverRide) throw new Error("DRIVER_ALREADY_ON_RIDE");

  const ride = await RideModel.findById(rideRequestId).select(
    "user rideType rideStatus rideDistance economyRideFare luxuryRideFare",
  );
  if (!ride || ride.rideStatus !== RIDE_STATUS.REQUESTED)
    throw new Error("RIDE_NOT_AVAILABLE");
  if (ride.rideType !== "private") throw new Error("NOT_A_PRIVATE_RIDE");

  // Guard: ensure the private ride's 1-hour acceptance window hasn't expired
  const aliveKey = `${RIDE}:${rideRequestId}:private:alive`;
  const isAlive = await redis.exists(aliveKey);
  if (!isAlive) throw new Error("RIDE_EXPIRED");

  // Check driver didn't already send an offer for this ride
  const existingOffer = await RideOfferModel.findOne({
    ride: rideRequestId,
    driver: driverId,
    status: "pending",
  });
  if (existingOffer) throw new Error("OFFER_ALREADY_SENT");

  // Has user already rejected this driver?
  const rejectedOffer = await RideOfferModel.findOne({
    ride: rideRequestId,
    driver: driverId,
    status: "rejected",
  });
  if (rejectedOffer) throw new Error("OFFER_ALREADY_REJECTED");

  const driver = await DriverModel.findById(driverId)
    .select(
      "firstName lastName profilePicture rating reviewsReceived vehicleDetails vehicleType",
    )
    .populate(
      "vehicleDetails",
      "make model yearOfManufacture color licensePlateNumber vehicleType",
    );

  const expiresAt = new Date(Date.now() + OFFER_VALIDITY_SECONDS * 1000);

  const fare =
    driver.vehicleType === "economy"
      ? ride.economyRideFare
      : ride.luxuryRideFare;

  const offer = await RideOfferModel.create({
    ride: rideRequestId,
    driver: driverId,
    rideType: driver.vehicleType, // "economy" or "luxury"
    offeredFare: fare,
    status: "pending",
    expiresAt,
  });

  // Notify the user
  const userSocket = await redis.get(`${USER}:${ride.user}:${SOCKET}`);
  if (userSocket) {
    io.to(userSocket).emit(RIDE_SOCKET_EVENTS.INCOMING_OFFER, {
      offerId: offer._id,
      rideId: rideRequestId,
      driver: {
        id: driver._id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        profilePicture: driver.profilePicture,
        rating: driver.rating,
        reviews: driver.reviewsReceived,
        vehicleDetails: driver.vehicleDetails,
        vehicleType: driver.vehicleType,
      },
      rideType: offer.rideType,
      offeredFare: offer.offeredFare,
      expiresAt,
    });
  }

  return { offerId: offer._id };
}

// ─── acceptRideOfferService (NEW — user picks a driver offer) ─────────────────
async function acceptRideOfferService(userId, offerId, io) {
  // Load the full offer for authorization, pricing, and response data. Its
  // status is re-checked atomically immediately before assignment.
  const offer = await RideOfferModel.findById(offerId)
    .populate("ride")
    .populate(
      "driver",
      "firstName lastName profilePicture rating reviewsReceived vehicleDetails vehicleType locale",
    );

  if (!offer) throw new Error("OFFER_NOT_FOUND");
  if (offer.status !== "pending") throw new Error("OFFER_NO_LONGER_VALID");

  const driverId = offer.driver._id.toString();
  const shiftGuard = await canDriverAcceptAssignment(driverId);
  if (!shiftGuard.allowed) throw new Error("DRIVER_SHIFT_LIMIT_REACHED");

  const ride = offer.ride;
  if (ride.user.toString() !== userId) throw new Error("UNAUTHORIZED");
  if (ride.rideStatus !== RIDE_STATUS.REQUESTED)
    throw new Error("RIDE_NOT_AVAILABLE");

  // If this is a private ride, ensure its 1-hour window hasn't expired
  if (ride.rideType === "private") {
    const aliveKey = `${RIDE}:${ride._id}:private:alive`;
    const isAlive = await redis.exists(aliveKey);
    if (!isAlive) throw new Error("RIDE_EXPIRED");
  }

  const passenger = await UserModel.findById(userId).select(
    "balance rewardedBalance",
  );
  if (!canAffordRideOffer(passenger, offer.offeredFare, ride.paymentMethod)) {
    throw new Error("INSUFFICIENT_WALLET_BALANCE");
  }

  const acceptedAt = new Date();
  const assignmentLock = await acquireAssignmentLock(redis, driverId);
  if (!assignmentLock) throw new Error("ASSIGNMENT_IN_PROGRESS");

  const rideLock = {
    key: REDIS_CONSTANTS.keys.rideLock(ride._id.toString()),
    owner: assignmentLock.owner,
  };
  let ownsRideLock = false;
  let claimedOffer = false;
  let updatedRide;

  try {
    // Re-check all assignment sources while holding the per-driver lock. This
    // closes the gap between accepting an offer and going offline/starting a
    // carpool, as well as two passengers accepting this driver's offers.
    const [activeRideId, activeCarpoolId, activeRideInDatabase] =
      await Promise.all([
        redis.get(REDIS_CONSTANTS.keys.driverActive(driverId)),
        redis.get(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId)),
        RideModel.exists({
          driver: offer.driver._id,
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

    if (activeRideId || activeRideInDatabase)
      throw new Error("DRIVER_ALREADY_ON_RIDE");
    if (activeCarpoolId) throw new Error("DRIVER_ALREADY_HAS_ACTIVE_CARPOOL");

    const lock = await redis.set(
      rideLock.key,
      rideLock.owner,
      REDIS_CONSTANTS.NX,
      REDIS_CONSTANTS.EX,
      30,
    );
    if (!lock) throw new Error("RIDE_ALREADY_TAKEN");
    ownsRideLock = true;

    // This conditional update is the decision point shared with cancellation.
    // A canceled, rejected, expired, or already accepted offer cannot win.
    const acceptedOffer = await acceptPendingOffer(
      RideOfferModel,
      offerId,
      acceptedAt,
    );
    if (!acceptedOffer) throw new Error("OFFER_NO_LONGER_VALID");
    claimedOffer = true;

    updatedRide = await RideModel.findOneAndUpdate(
      { _id: ride._id, rideStatus: RIDE_STATUS.REQUESTED },
      {
        driver: driverId,
        rideType: offer.rideType, // lock in economy or luxury
        rideFare: offer.offeredFare,
        discountAmount:
          offer.rideType === "economy"
            ? ride.originalEconomyRideFare - offer.offeredFare
            : ride.originalLuxuryRideFare - offer.offeredFare,
        selectedOffer: offerId,
        rideStatus: RIDE_STATUS.ACCEPTED,
        acceptedAt,
        startTime: acceptedAt,
      },
      { new: true },
    );

    if (!updatedRide) throw new Error("UNABLE_TO_ACCEPT_RIDE");
    // Publish the active assignment before releasing the driver mutex.
    // MongoDB remains the durable fallback checked by competing operations.
    try {
      await redis.set(REDIS_CONSTANTS.keys.driverActive(driverId), ride._id);
    } catch (cacheError) {
      console.error("Failed to cache accepted driver assignment", {
        rideId: ride._id,
        driverId,
        error: cacheError.message,
      });
    }

    try {
      await Promise.all([
        RideOfferModel.updateMany(
          { ride: ride._id, _id: { $ne: offerId }, status: "pending" },
          { status: "rejected" },
        ),
        cancelPendingOffersForDriver(RideOfferModel, offer.driver._id),
      ]);
    } catch (offerCleanupError) {
      console.error("Post-acceptance assignment cleanup failed", {
        rideId: ride._id,
        driverId,
        error: offerCleanupError.message,
      });
    }
  } catch (error) {
    if (claimedOffer && !updatedRide) {
      await RideOfferModel.updateOne(
        { _id: offerId, status: "accepted" },
        { $set: { status: "rejected" } },
      );
    }
    throw error;
  } finally {
    if (ownsRideLock) await releaseAssignmentLock(redis, rideLock);
    await releaseAssignmentLock(redis, assignmentLock);
  }

  await redis.del(`${RIDE}:${SESSION}:${ride._id}`);
  await redis.del(`${USER}:${userId}:${RIDE}:${PENDING}`);
  await redis.del(`${RIDE}:${ride._id}:private:alive`); // clean up expiry marker

  const otp = generateNumericOTP();
  await RideOtpModel.create({ user: userId, ride: ride._id, otp, attempts: 0 });

  await redis.set(`${USER}:${userId}:${RIDE}:${ACTIVE}`, ride._id);

  await redis.geoadd(
    `${RIDE}:${ride._id}:${DESTINATION}`,
    updatedRide.dropOffPointRequested.location.coordinates[0],
    updatedRide.dropOffPointRequested.location.coordinates[1],
    DESTINATION,
  );
  await redis.geoadd(
    `${RIDE}:${ride._id}:${PICKUP}`,
    updatedRide.pickupPoint.location.coordinates[0],
    updatedRide.pickupPoint.location.coordinates[1],
    PICKUP,
  );

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "ride",
      journeyId: ride._id,
      rideId: ride._id,
      eventType: "ride.driver_assigned",
      phase: "to_pickup",
      actor: { type: "user", id: userId },
      source: "socket",
      transition: {
        from: RIDE_STATUS.REQUESTED,
        to: RIDE_STATUS.ACCEPTED,
      },
      occurredAt: acceptedAt,
      dedupeKey: `ride:${ride._id}:driver_assigned`,
      metadata: {
        driverId,
        selectedOfferId: offerId,
      },
    },
    driverId,
  );

  // Notify rejected drivers so they stop showing the request
  const rejectedOffers = await RideOfferModel.find({
    ride: ride._id,
    status: "rejected",
    driver: { $ne: driverId },
  }).select("driver");

  for (const rejected of rejectedOffers) {
    const driverData = await redis.hgetall(`${DRIVER}:${rejected.driver}`);
    if (driverData?.socket) {
      io.to(driverData.socket).emit(RIDE_SOCKET_EVENTS.OFFER_REJECTED, {
        rideId: ride._id,
        reason: "user_selected_another_driver",
      });
    }
  }

  const fullRide = await getRideWithRelations(ride._id);

  return {
    ride: fullRide,
    rideOTP: otp,
    driverId,
  };
}

// ─── rejectRideOfferService (NEW — user dismisses one driver's offer) ─────────
async function rejectRideOfferService(userId, offerId, io) {
  const offer = await RideOfferModel.findById(offerId).populate("ride", "user");
  if (!offer) throw new Error("OFFER_NOT_FOUND");
  if (offer.ride.user.toString() !== userId) throw new Error("UNAUTHORIZED");
  if (offer.status !== "pending") throw new Error("OFFER_NO_LONGER_VALID");

  const rejectedOffer = await rejectPendingOffer(RideOfferModel, offerId);
  if (!rejectedOffer) throw new Error("OFFER_NO_LONGER_VALID");

  // Tell that driver their offer was rejected so the request disappears
  const driverData = await redis.hgetall(`${DRIVER}:${offer.driver}`);
  if (driverData?.socket) {
    io.to(driverData.socket).emit(RIDE_SOCKET_EVENTS.OFFER_REJECTED, {
      rideId: offer.ride._id,
      reason: "user_rejected",
    });
  }

  return { success: true };
}

// ─── cleanupRideOffers (call from updateRideStatusService when ride ends) ─────
async function cleanupRideOffers(rideId) {
  await RideOfferModel.deleteMany({ ride: rideId });
  await redis.del(`${RIDE}:${rideId}:fares`);
}

async function acceptRideService(driverId, rideRequestId) {
  const shiftGuard = await canDriverAcceptAssignment(driverId);
  if (!shiftGuard.allowed) throw new Error("SHIFT_EXCEEDED_ONLINE");

  const assignmentLock = await acquireAssignmentLock(redis, driverId);
  if (!assignmentLock) throw new Error("ASSIGNMENT_IN_PROGRESS");

  const rideLock = {
    key: REDIS_CONSTANTS.keys.rideLock(String(rideRequestId)),
    owner: assignmentLock.owner,
  };
  let ownsRideLock = false;
  let updatedRide;
  let userId;
  const acceptedAt = new Date();

  try {
    const [activeRideId, activeCarpoolId, activeRideInDatabase] =
      await Promise.all([
        redis.get(REDIS_CONSTANTS.keys.driverActive(driverId)),
        redis.get(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId)),
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

    if (activeRideId || activeRideInDatabase)
      throw new Error("DRIVER_ALREADY_ON_RIDE");
    if (activeCarpoolId) throw new Error("DRIVER_ALREADY_HAS_ACTIVE_CARPOOL");

    const [requestedRide, acceptingDriver] = await Promise.all([
      RideModel.findById(rideRequestId).select("user rideStatus rideType"),
      DriverModel.findById(driverId).select("vehicleType"),
    ]);
    if (!requestedRide || requestedRide.rideStatus !== RIDE_STATUS.REQUESTED) {
      throw new Error("RIDE_ALREADY_TAKEN");
    }
    // A ride may change category under a driver — an exhausted economy search
    // the rider upgraded to luxury. Assigning across categories would put an
    // economy car on a luxury fare, so the category is checked here and made
    // part of the claim below rather than trusted from the driver's screen.
    if (requestedRide.rideType !== acceptingDriver?.vehicleType) {
      throw new Error("RIDE_ALREADY_TAKEN");
    }
    userId = requestedRide.user.toString();

    const rideClaim = await redis.set(
      rideLock.key,
      rideLock.owner,
      REDIS_CONSTANTS.NX,
      REDIS_CONSTANTS.EX,
      30,
    );
    if (!rideClaim) throw new Error("RIDE_ALREADY_TAKEN");
    ownsRideLock = true;

    updatedRide = await RideModel.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(rideRequestId),
        rideStatus: RIDE_STATUS.REQUESTED,
        rideType: acceptingDriver.vehicleType,
      },
      {
        driver: driverId,
        rideStatus: RIDE_STATUS.ACCEPTED,
        acceptedAt,
        startTime: acceptedAt,
      },
      { new: true },
    );

    if (!updatedRide) throw new Error("UNABLE_TO_ACCEPT_RIDE");

    try {
      await redis.set(
        REDIS_CONSTANTS.keys.driverActive(driverId),
        updatedRide._id,
      );
    } catch (cacheError) {
      console.error("Failed to cache accepted driver assignment", {
        rideId: updatedRide._id,
        driverId,
        error: cacheError.message,
      });
    }

    try {
      await cancelPendingOffersForDriver(
        RideOfferModel,
        new mongoose.Types.ObjectId(driverId),
      );
    } catch (offerCleanupError) {
      console.error("Post-acceptance assignment cleanup failed", {
        rideId: updatedRide._id,
        driverId,
        error: offerCleanupError.message,
      });
    }
  } finally {
    if (ownsRideLock) await releaseAssignmentLock(redis, rideLock);
    await releaseAssignmentLock(redis, assignmentLock);
  }

  await redis.del(`${RIDE}:${SESSION}:${rideRequestId}`);
  await redis.del(`${USER}:${userId}:${RIDE}:${PENDING}`);

  const updatedRideId = updatedRide._id;

  const otp = generateNumericOTP();
  await RideOtpModel.create({
    user: userId,
    ride: updatedRideId,
    otp,
    attempts: 0,
  });
  await redis.set(`${USER}:${userId}:${RIDE}:${ACTIVE}`, updatedRideId);
  await redis.geoadd(
    `${RIDE}:${updatedRideId}:${DESTINATION}`,
    updatedRide.dropOffPointRequested.location.coordinates[0], // lng
    updatedRide.dropOffPointRequested.location.coordinates[1], // lat
    DESTINATION,
  );

  await redis.geoadd(
    `${RIDE}:${updatedRideId}:${PICKUP}`,
    updatedRide.pickupPoint.location.coordinates[0], // lng
    updatedRide.pickupPoint.location.coordinates[1], // lat
    PICKUP,
  );

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "ride",
      journeyId: updatedRideId,
      rideId: updatedRideId,
      eventType: "ride.driver_assigned",
      phase: "to_pickup",
      actor: { type: "driver", id: driverId },
      source: "socket",
      transition: {
        from: RIDE_STATUS.REQUESTED,
        to: RIDE_STATUS.ACCEPTED,
      },
      occurredAt: acceptedAt,
      dedupeKey: `ride:${updatedRideId}:driver_assigned`,
      metadata: { driverId },
    },
    driverId,
  );

  // The ladder is over for this ride. Dropping the queued ring is housekeeping
  // — dispatchRing re-reads the status and would stop on its own — but pulling
  // the request off every other driver screen is not: without it they only find
  // out by tapping a card that no longer exists.
  // An upgrade offer may be open on this ride: the rider was being asked
  // whether to search again in a pricier category when this driver accepted.
  // The driver wins, so the question is withdrawn — and its timeout job with
  // it, or it would fire against a ride that is no longer searching.
  // Required late: the upgrade service loads this module, so a top-level
  // require would close the cycle.
  const { supersedeCategoryUpgrade } = require("./ride-upgrade.service");
  const searchAttempt = updatedRide.searchAttempt ?? 0;

  await Promise.all([
    cancelPendingRings({
      rideId: String(updatedRideId),
      attempt: searchAttempt,
    }),
    cancelUpgradeDecision({
      rideId: String(updatedRideId),
      attempt: searchAttempt,
    }),
    supersedeCategoryUpgrade({ rideId: String(updatedRideId) }),
    withdrawRideFromOtherDrivers({
      rideId: String(updatedRideId),
      winnerDriverId: driverId,
    }),
  ]).catch((error) =>
    console.error(
      "Post-acceptance dispatch cleanup failed",
      error?.message ?? error,
    ),
  );

  const ride = await getRideWithRelations(updatedRideId);

  return {
    ride,
    rideOTP: otp,
    passenger: userId,
  };
}

async function getRideOffers(rideId) {
  const offers = await RideOfferModel.find({
    ride: rideId,
    status: "pending",
  }).populate({
    path: "driver",
    select:
      "firstName lastName profilePicture rating reviewsReceived vehicleDetails vehicleType",
    populate: {
      path: "vehicleDetails",
      select:
        "make model yearOfManufacture color licensePlateNumber vehicleType",
    },
  });

  return offers;
}

async function updateRideStatusService(
  rideId,
  nextStatus,
  paymentStatus,
  context = {},
) {
  const ride = await RideModel.findById(rideId);
  if (!ride) throw new Error("RIDE_NOT_FOUND");

  if (
    context.actorType === "driver" &&
    context.actorId &&
    ride.driver?.toString() !== context.actorId.toString()
  ) {
    throw new Error("UNAUTHORIZED_DRIVER");
  }
  if (
    context.actorType === "user" &&
    context.actorId &&
    ride.user?.toString() !== context.actorId.toString()
  ) {
    throw new Error("UNAUTHORIZED_USER");
  }

  const previousStatus = ride.rideStatus;
  const eventType = context.eventType || getRideStatusEventType(nextStatus);

  if (previousStatus === nextStatus) {
    if (eventType) {
      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "ride",
          journeyId: ride._id,
          rideId: ride._id,
          eventType,
          phase: context.phase || getRidePhase(nextStatus),
          actor: {
            type: context.actorType || "system",
            id: context.actorId || null,
          },
          source: context.source || "service",
          transition: { from: previousStatus, to: nextStatus },
          location: context.location,
          locationSource: context.location ? "payload" : null,
          reasonCode: context.reasonCode || null,
          dedupeKey: context.dedupeKey || `ride:${ride._id}:${eventType}`,
          metadata: context.metadata || {},
        },
        ride.driver,
      );
    }
    return ride;
  }

  if (!validateTransition(previousStatus, nextStatus)) {
    throw new Error("INVALID_RIDE_STATUS_TRANSITION");
  }

  const hasRideEnded = [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED].includes(
    nextStatus,
  );
  const occurredAt = new Date();

  ride.rideStatus = nextStatus;
  if (paymentStatus) {
    ride.paymentStatus = paymentStatus;
    if (paymentStatus === "completed") ride.paymentCompletedAt = occurredAt;
  }

  if (nextStatus === RIDE_STATUS.ARRIVED) ride.driverArrivedAt = occurredAt;
  if (nextStatus === RIDE_STATUS.COMING) ride.passengerComingAt = occurredAt;
  if (nextStatus === RIDE_STATUS.IN_PROGRESS) ride.startedAt = occurredAt;
  if (nextStatus === RIDE_STATUS.COMPLETED) ride.completedAt = occurredAt;
  if (nextStatus === RIDE_STATUS.CANCELLED) ride.cancelledAt = occurredAt;

  if (hasRideEnded) {
    await removeRideFromCache(ride._id, ride.user, ride.driver);
    await RideOtpModel.deleteMany({ ride: ride._id }); // In carpool we will not delete many
    await cleanupRideOffers(ride._id);
    ride.endTime = occurredAt;
  }

  // Remove passenger presence tracking when ride goes in-progress
  if (nextStatus === RIDE_STATUS.IN_PROGRESS) {
    try {
      await removePassengerPresence(ride.user.toString());
    } catch (presenceErr) {
      console.error(
        "[HIGH-DEMAND] removePassengerPresence error:",
        presenceErr?.message,
      );
    }
  }

  await ride.save();

  // A driver referral pays its owner only once the ride is done. A ride that
  // ends before the rider was charged hands the code back; one cancelled after
  // the charge uses it up with no bonus. All are no-ops on any other ride, and
  // none can fail the status change.
  if (ride.riderReferral && nextStatus === RIDE_STATUS.COMPLETED) {
    await settleReferralForCompletedRide(ride);
  }
  if (
    ride.riderReferral &&
    [RIDE_STATUS.CANCELLED, RIDE_STATUS.EXPIRED].includes(nextStatus)
  ) {
    if (
      shouldReturnReferralCode({
        previousStatus,
        paymentStatus: ride.paymentStatus,
      })
    ) {
      await releaseReferralForRide(ride._id);
    } else {
      await voidReferralForRide(ride._id);
    }
  }

  if (hasRideEnded && ride.driver) {
    await handleAssignmentEnded(ride.driver, context.io);
  }

  if (eventType) {
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType,
        phase: context.phase || getRidePhase(nextStatus),
        actor: {
          type: context.actorType || "system",
          id: context.actorId || null,
        },
        source: context.source || "service",
        transition: { from: previousStatus, to: nextStatus },
        occurredAt,
        location: context.location,
        locationSource: context.location ? "payload" : null,
        reasonCode: context.reasonCode || null,
        dedupeKey: context.dedupeKey || `ride:${ride._id}:${eventType}`,
        metadata: context.metadata || {},
      },
      ride.driver,
    );
  }

  return ride;
}

/**
 * Everything that has to be true before a single cent moves, plus the one state
 * fix-up a start may need.
 *
 * The charge used to run first and the transition after it, so a ride that could
 * not legally reach "in-progress" left the rider charged, the driver credited
 * and the ride still sitting in "accepted" — money moved, state did not, and a
 * retry could not fix it because the charge reported itself already done.
 *
 * A driver who never marked the arrival is not an error case. The OTP comes out
 * of the passenger's mouth, so by the time it checks out the driver is
 * demonstrably at the pickup. The arrival is recorded here rather than rejected,
 * which keeps `driverArrivedAt` and the journey log honest without blocking a
 * ride whose only sin is a GPS reading that never landed inside the 100 m fence.
 */
async function prepareRideForStart(
  rideId,
  { actorId, source = "socket" } = {},
) {
  const ride = await RideModel.findById(rideId).select("rideStatus driver");
  if (!ride) throw new Error("RIDE_NOT_FOUND");

  if (actorId && ride.driver?.toString() !== actorId.toString()) {
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  // A retry on a ride that is already running is not a failure: let it through
  // so the charge reports itself done and the status update is emitted again,
  // which is what pulls a rider whose app missed the first one back into sync.
  if (ride.rideStatus === RIDE_STATUS.IN_PROGRESS) {
    return { alreadyStarted: true, impliedArrival: false };
  }

  if (!RIDE_STARTABLE_STATUSES.includes(ride.rideStatus)) {
    throw new Error("RIDE_CANNOT_START");
  }

  if (ride.rideStatus === RIDE_STATUS.ACCEPTED) {
    // Recorded, not emitted: the rider is about to receive "in-progress", and a
    // single frame of "your driver arrived" in between would only flicker.
    await updateRideStatusService(rideId, RIDE_STATUS.ARRIVED, null, {
      actorType: "driver",
      actorId,
      source,
      reasonCode: "IMPLICIT_ARRIVAL_ON_START",
    });

    return { alreadyStarted: false, impliedArrival: true };
  }

  return { alreadyStarted: false, impliedArrival: false };
}

async function updateRideService(rideId, updateData) {
  const ride = await RideModel.findById(rideId);
  if (!ride) throw new Error("RIDE_NOT_FOUND");

  Object.keys(updateData).forEach((key) => {
    ride[key] = updateData[key];
  });
  await ride.save();
}

async function verifyRideOTPService(rideId, OTP, context = {}) {
  const [rideOtp, ride] = await Promise.all([
    RideOtpModel.findOne({ ride: rideId }),
    RideModel.findById(rideId).select("driver otpVerifiedAt"),
  ]);
  if (!ride) throw new Error("RIDE_NOT_FOUND");
  if (
    context.actorId &&
    ride.driver?.toString() !== context.actorId.toString()
  ) {
    throw new Error("UNAUTHORIZED_DRIVER");
  }

  // A client retry after a successful verification is safe and does not need
  // another OTP lookup or payment attempt.
  if (!rideOtp && ride.otpVerifiedAt) return true;
  if (!rideOtp) throw new Error("RIDE_NOT_FOUND");

  if (rideOtp.otp !== OTP) {
    rideOtp.attempts += 1;
    await rideOtp.save();

    try {
      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "ride",
          journeyId: rideId,
          rideId,
          eventType: "ride.otp_failed",
          phase: "waiting_pickup",
          actor: {
            type: context.actorType || "driver",
            id: context.actorId || ride.driver,
          },
          source: context.source || "socket",
          reasonCode: "INVALID_OTP",
          dedupeKey: `ride:${rideId}:otp_failed:${rideOtp.attempts}`,
          metadata: { attempt: rideOtp.attempts },
        },
        ride.driver,
      );
    } catch (logError) {
      console.error("Failed to record ride OTP failure:", logError.message);
    }
    throw new Error("INVALID_OTP");
  }

  const verifiedAt = new Date();
  ride.otpVerifiedAt = verifiedAt;
  await ride.save();

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "ride",
      journeyId: rideId,
      rideId,
      eventType: "ride.otp_verified",
      phase: "waiting_pickup",
      actor: {
        type: context.actorType || "driver",
        id: context.actorId || ride.driver,
      },
      source: context.source || "socket",
      occurredAt: verifiedAt,
      dedupeKey: `ride:${rideId}:otp_verified`,
    },
    ride.driver,
  );

  await RideOtpModel.deleteOne({ _id: rideOtp._id });

  return true;
}

async function getActiveRideForUser(userId) {
  const rideId = await redis.get(`${USER}:${userId}:${RIDE}:${ACTIVE}`);
  if (!rideId) return null;
  return await RideModel.findById(rideId);
}

async function getActiveRideForDriver(driverId) {
  const rideId = await redis.get(`${DRIVER}:${driverId}:${RIDE}:${ACTIVE}`);
  if (!rideId) return null;
  return await RideModel.findById(rideId);
}

async function chargeUserForRide(rideId) {
  const paymentRide = await RideModel.findById(rideId).populate("user");
  if (!paymentRide) throw new Error("Ride not found");

  if (paymentRide.paymentStatus === "completed") {
    return {
      success: true,
      paymentMethod: paymentRide.paymentMethod,
      alreadyProcessed: true,
    };
  }

  // A ride the rider owes nothing for. Neither payment rail can move zero: the
  // wallet allocator returns null for a non-positive amount (which the caller
  // reads as an empty balance and cancels the ride) and Stripe rejects an
  // intent below its minimum. So both are skipped entirely — but the driver is
  // still paid, off the original fare, with the platform absorbing the whole
  // amount.
  if (isFreeRide(paymentRide)) {
    const settlement = await creditDriverForRide({
      ride: paymentRide,
      paymentMethod: "free",
      amountChargedToRider: 0,
    });

    await RideModel.findByIdAndUpdate(rideId, {
      paymentStatus: "completed",
      paymentCompletedAt: new Date(),
    });

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: paymentRide._id,
        rideId: paymentRide._id,
        eventType: "ride.payment_succeeded",
        phase: "waiting_pickup",
        actor: { type: "system", id: null },
        source: "service",
        amount: { value: 0, currency: "USD" },
        dedupeKey: `ride:${paymentRide._id}:payment_succeeded:free`,
        metadata: {
          paymentMethod: "free",
          driverAmount: settlement.driverAmount,
          absorbedByPlatform: settlement.discountAbsorbed,
        },
      },
      paymentRide.driver,
    );

    return {
      success: true,
      paymentMethod: "free",
      driverAmount: settlement.driverAmount,
    };
  }

  // Never hold a MongoDB transaction open while waiting on Stripe. Stripe is
  // protected by a stable idempotency key in _handleCardPayment.
  if (paymentRide.paymentMethod === "attached_card") {
    return _handleCardPayment({ ride: paymentRide, user: paymentRide.user });
  }

  if (paymentRide.paymentMethod !== "wallet") {
    throw new Error("Unsupported payment method");
  }

  const session = await mongoose.startSession();

  try {
    console.log("Starting charge for ride:", rideId);

    const result = await session.withTransaction(async () => {
      const ride = await RideModel.findById(rideId)
        .populate("user")
        .session(session);

      if (!ride) throw new Error("Ride not found");

      console.log(
        "Ride found:",
        ride._id,
        "Payment status:",
        ride.paymentStatus,
      );

      if (ride.paymentStatus === "completed") {
        return {
          success: true,
          paymentMethod: ride.paymentMethod,
          alreadyProcessed: true,
        };
      }

      const user = ride.user;
      console.log(
        "Processing payment for user:",
        user._id,
        "Method:",
        ride.paymentMethod,
      );

      console.log("Handling wallet payment");
      return await _handleWalletPayment({ ride, user, session });
    });

    if (result?.journeyEvent) {
      await recordJourneyEventWithDriverLocation(
        result.journeyEvent.data,
        result.journeyEvent.driverId,
      );
      delete result.journeyEvent;
    }

    console.log(
      "Charge completed successfully for ride:",
      rideId,
      "Result:",
      result,
    );
    return result;
  } catch (err) {
    console.error(
      "Error charging user for ride:",
      rideId,
      "Error:",
      err.message,
    );
    throw err;
  } finally {
    session.endSession();
    console.log("Session ended for ride:", rideId);
  }
}

async function _handleCardPayment({ ride, user }) {
  const card = await CardModel.findOne({
    user: user._id,
    status: "active",
    default: true,
  });

  if (!card) throw new Error("CARD_NOT_FOUND");

  const identifierKey = rideStartPaymentKey(ride._id);
  const amountInCents = Math.round(ride.rideFare * 100);

  const transaction = await TransactionModel.findOneAndUpdate(
    { identifierKey, user: user._id, userType: "User", type: "Debit" },
    {
      $setOnInsert: {
        amount: ride.rideFare,
        type: "Debit",
        user: user._id,
        userType: "User",
        card: card._id,
        status: "initiated",
        identifierKey,
        metadata: {
          rideId: ride._id,
          paymentMethod: "attached_card",
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "ride",
      journeyId: ride._id,
      rideId: ride._id,
      eventType: "ride.payment_initiated",
      phase: "waiting_pickup",
      actor: { type: "user", id: user._id },
      source: "service",
      references: { transactionId: transaction._id },
      amount: { value: ride.rideFare, currency: "USD" },
      dedupeKey: `ride:${ride._id}:payment_initiated:${transaction._id}`,
      metadata: { paymentMethod: "attached_card" },
    },
    ride.driver,
  );

  let paymentIntent;
  try {
    paymentIntent = await StripeService.createPaymentIntent({
      amount: amountInCents,
      currency: "usd",
      customerId: user.stripeCustomerId,
      paymentMethodId: card.paymentMethodId,
      metadata: {
        identifierKey,
        pmId: card.paymentMethodId,
        rideId: ride._id.toString(),
      },
      idempotencyKey: identifierKey,
    });
  } catch (stripeError) {
    await TransactionModel.findByIdAndUpdate(transaction._id, {
      status: "failed",
      errorMessage: stripeError.message,
    });
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType: "ride.payment_failed",
        phase: "waiting_pickup",
        actor: { type: "stripe", id: null },
        source: "service",
        references: { transactionId: transaction._id },
        amount: { value: ride.rideFare, currency: "USD" },
        reasonCode: stripeError.code || "PAYMENT_FAILED",
        dedupeKey: `ride:${ride._id}:payment_failed:${transaction._id}`,
      },
      ride.driver,
    );
    throw stripeError;
  }

  const requiresAction = paymentIntent.status === "requires_action";

  if (requiresAction) {
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType: "ride.payment_action_required",
        phase: "waiting_pickup",
        actor: { type: "stripe", id: null },
        source: "service",
        references: {
          transactionId: transaction._id,
          paymentIntentId: paymentIntent.id,
        },
        amount: { value: ride.rideFare, currency: "USD" },
        dedupeKey: `ride:${ride._id}:payment_action_required:${paymentIntent.id}`,
      },
      ride.driver,
    );

    return {
      paymentMethod: "attached_card",
      settled: false,
      requiresAction: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    };
  }

  // Anything that is neither "succeeded" nor "requires_action" — a card still
  // processing, for instance — has no outcome yet. The webhook owns it.
  if (paymentIntent.status !== "succeeded") {
    return {
      paymentMethod: "attached_card",
      settled: false,
      requiresAction: false,
      paymentIntentId: paymentIntent.id,
    };
  }

  // Stripe took the money in this same call, which is the usual outcome for a
  // saved card without 3-D Secure. Leaving the ride for the webhook to start
  // strands it in "arrived": the rider is never told the ride began, and
  // "arrived" -> "completed" is not a legal transition, so the driver cannot
  // close it either. Settle here and let the webhook find its work done.
  const settlement = await settleCardPaymentForRide({
    ride,
    transaction,
    paymentIntentId: paymentIntent.id,
  });

  return {
    paymentMethod: "attached_card",
    settled: true,
    requiresAction: false,
    paymentIntentId: paymentIntent.id,
    driverAmount: settlement.driverAmount,
  };
}

/**
 * Close out a card payment Stripe already confirmed: pay the driver, mark the
 * ride paid and log it.
 *
 * Whoever writes `stripeIds.paymentIntent` on the rider's transaction first owns
 * the payout. The Stripe webhook skips any transaction that already carries one,
 * so the driver is credited exactly once whichever path wins the race.
 */
async function settleCardPaymentForRide({
  ride,
  transaction,
  paymentIntentId,
}) {
  const claimed = await TransactionModel.findOneAndUpdate(
    {
      _id: transaction._id,
      $or: [
        { "stripeIds.paymentIntent": { $exists: false } },
        { "stripeIds.paymentIntent": null },
        { "stripeIds.paymentIntent": "" },
      ],
    },
    {
      $set: {
        status: "success",
        "stripeIds.paymentIntent": paymentIntentId,
      },
    },
    { new: true },
  );

  if (!claimed) {
    // The webhook got here first. It already paid the driver.
    return { driverAmount: getRideDriverFare(ride), alreadySettled: true };
  }

  await RideModel.findByIdAndUpdate(ride._id, {
    paymentStatus: "completed",
    paymentCompletedAt: new Date(),
  });

  const settlement = await creditDriverForRide({
    ride,
    paymentMethod: "attached_card",
    amountChargedToRider: claimed.amount,
    identifierKey: claimed.identifierKey,
    stripeIds: { paymentIntent: paymentIntentId },
  });

  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "ride",
      journeyId: ride._id,
      rideId: ride._id,
      eventType: "ride.payment_succeeded",
      phase: "waiting_pickup",
      actor: { type: "stripe", id: null },
      source: "service",
      amount: { value: claimed.amount, currency: "USD" },
      references: { transactionId: claimed._id, paymentIntentId },
      // Same key the webhook listener uses, so the log holds one event no
      // matter which path settled the ride.
      dedupeKey: `ride:${ride._id}:payment_succeeded:card`,
      metadata: {
        paymentMethod: "attached_card",
        driverAmount: settlement.driverAmount,
      },
    },
    ride.driver,
  );

  return settlement;
}

async function _handleWalletPayment({ ride, user, session }) {
  const walletAllocation = getWalletAllocation(user, ride.rideFare);

  if (!walletAllocation) {
    console.log(
      "Insufficient wallet balance. User balance:",
      user.balance,
      "Required:",
      ride.rideFare,
    );
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType: "ride.payment_failed",
        phase: "waiting_pickup",
        actor: { type: "user", id: user._id },
        source: "service",
        amount: { value: ride.rideFare, currency: "USD" },
        reasonCode: "INSUFFICIENT_WALLET_BALANCE",
        dedupeKey: `ride:${ride._id}:payment_failed:wallet`,
        metadata: { paymentMethod: "wallet" },
      },
      ride.driver,
    );
    await updateRideStatusService(ride._id, RIDE_STATUS.CANCELLED, null, {
      actorType: "system",
      source: "service",
      reasonCode: "INSUFFICIENT_WALLET_BALANCE",
    });
    console.log("Ride cancelled due to insufficient balance");
    return { cancelled: true, reason: "insufficient_wallet_balance" };
  }

  await UserModel.findByIdAndUpdate(
    user._id,
    {
      $inc: {
        balance: -walletAllocation.regularAmount,
        rewardedBalance: -walletAllocation.rewardedAmount,
      },
    },
    { session, runValidators: true },
  );

  await RideModel.findByIdAndUpdate(
    ride._id,
    { paymentStatus: "completed" },
    { session },
  );

  const createdTransactions = await TransactionModel.create(
    [
      {
        user: user._id,
        userType: "User",
        amount: ride.rideFare,
        type: "Debit",
        status: "success",
        ...transactionRewardFields(walletAllocation),
        metadata: { rideId: ride._id, paymentMethod: "wallet" },
      },
    ],
    { session, ordered: true },
  );

  // Paying the driver and recording who absorbed the discount is shared with
  // the card and free paths, so it lives in one place.
  await creditDriverForRide({
    ride,
    paymentMethod: "wallet",
    amountChargedToRider: ride.rideFare,
    session,
  });

  return {
    success: true,
    paymentMethod: "wallet",
    journeyEvent: {
      data: {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType: "ride.payment_succeeded",
        phase: "waiting_pickup",
        actor: { type: "user", id: user._id },
        source: "service",
        references: { transactionId: createdTransactions[0]._id },
        amount: { value: ride.rideFare, currency: "USD" },
        dedupeKey: `ride:${ride._id}:payment_succeeded:wallet`,
        metadata: { paymentMethod: "wallet" },
      },
      driverId: ride.driver,
    },
  };
}

async function getRideWithRelations(rideId, locale, origin = "socket") {
  const ride = await RideModel.findById(rideId)
    .populate({
      path: "user",
      select: "firstName lastName profilePicture rating reviewsReceived",
    })
    .populate({
      path: "driver",
      select:
        "firstName lastName profilePicture rating reviewsReceived vehicleDetails phone",
      populate: {
        path: "vehicleDetails",
        select:
          "make model yearOfManufacture color licensePlateNumber vehicleType",
      },
    })
    .lean();

  if (!ride) throw new NotFoundError(t("RIDE_NOT_FOUND_OR_DELETED", locale));

  if (origin === "api") {
    const [transaction, review, rideOtp] = await Promise.all([
      TransactionModel.findOne({
        "metadata.rideId": new mongoose.Types.ObjectId(rideId),
      })
        .populate("card", "brand last4")
        .select("amount type user userType status")
        .lean(),
      ReviewModel.find({
        ride: new mongoose.Types.ObjectId(rideId),
      }).lean(),
      RideOtpModel.findOne({
        ride: new mongoose.Types.ObjectId(rideId),
      })
        .select("otp")
        .lean(),
    ]);

    return {
      data: {
        ride: {
          ...parseRide(ride),
          transaction,
          review,
          rideOtp: rideOtp?.otp,
        },
      },
    };
  }

  return ride;
}

async function rideFareCalculator(
  rideType,
  miles,
  pickupCity,
  rideDate = new Date(),
) {
  // Keep compatibility with callers that previously supplied rideDate third.
  if (pickupCity instanceof Date) {
    rideDate = pickupCity;
    pickupCity = undefined;
  }

  if (rideType === "private") {
    const [economyFare, luxuryFare] = await Promise.all([
      rideFareCalculator("economy", miles, pickupCity, rideDate),
      rideFareCalculator("luxury", miles, pickupCity, rideDate),
    ]);

    return {
      data: {
        economy: economyFare.data,
        luxury: luxuryFare.data,
      },
    };
  }

  miles = Math.round(miles);

  const cityKey = normalizeCity(pickupCity);
  if (cityKey) {
    const cityRateDoc = await CityRideRateModel.findOne({
      cityKey,
      rideType,
      isActive: true,
    }).lean();

    if (cityRateDoc) {
      const bracket = findMileageBracket(cityRateDoc.brackets, miles);

      if (!bracket) {
        throw new Error("City rate bracket not found");
      }

      const peak = await isPeakTime(rideDate);
      const { surcharge, surchargeAmount, ratePerMile, totalFare } =
        calculateCityFare({
          price: bracket.price,
          miles,
          isPeak: peak,
          peakSurchargePerMile: cityRateDoc.peakSurchargePerMile || 0,
        });

      return {
        data: {
          baseRate: bracket.price,
          surcharge,
          surchargeAmount,
          ratePerMile,
          discountPercentage: 0,
          discount: 0,
          totalFare,
          isPeak: peak,
          pricingSource: "city",
          city: cityRateDoc.city,
          mileageBracket: {
            minMiles: bracket.minMiles,
            maxMiles: bracket.maxMiles ?? null,
          },
        },
      };
    }
  }

  const rateDoc = await RideRateModel.findOne({
    rideType,
    isActive: true,
  });

  if (!rateDoc) {
    throw new Error("Rate config not found");
  }

  const bracket = findMileageBracket(rateDoc.brackets, miles);

  const baseRate = bracket?.ratePerMile || rateDoc.brackets[0].ratePerMile;

  const peak = await isPeakTime(rideDate);
  const surcharge = peak ? rateDoc.peakSurchargePerMile : 0;

  const ratePerMile = baseRate + surcharge;

  const baseFare = ratePerMile * miles;

  let totalFare = baseFare;
  let discount = 0;

  if (rateDoc.discountPercentage) {
    discount = (baseFare * rateDoc.discountPercentage) / 100;
    totalFare = baseFare - discount;
  }

  totalFare = parseFloat(totalFare.toFixed(2));

  return {
    data: {
      baseRate,
      surcharge,
      ratePerMile,
      discountPercentage: rateDoc.discountPercentage || 0,
      discount: parseFloat(discount.toFixed(2)),
      totalFare,
      isPeak: peak,
    },
  };
}

async function rideHistory(
  id,
  role,
  page = 1,
  limit = 10,
  status,
  cancelledBy,
  options = {},
) {
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const dataOnly = options.dataOnly === true;

  const matchStage = {
    [role === "user" ? "user" : "driver"]: new mongoose.Types.ObjectId(id),
    rideStatus: status
      ? status
      : { $in: [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED] },
    ...(cancelledBy ? { cancelledBy } : {}),
    ...getRideHistoryVisibilityFilter(role),
    ...(options.additionalMatch || {}),
  };

  const aggregatePipeline = [
    { $match: matchStage },
    ...(dataOnly
      ? [
          { $sort: { createdAt: -1 } },
          { $skip: (parsedPage - 1) * parsedLimit },
          { $limit: parsedLimit },
        ]
      : []),

    {
      $addFields: {
        driverFare: {
          $cond: [
            { $gt: [{ $ifNull: ["$originalRideFare", 0] }, 0] },
            "$originalRideFare",
            {
              $add: [
                { $ifNull: ["$rideFare", 0] },
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
        },
      },
    },

    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "user",
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
      $unwind: {
        path: "$user",
        preserveNullAndEmptyArrays: true,
      },
    },

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
  let pagination;
  if (!dataOnly) {
    const paginated = await aggregatePaginate(
      RideModel,
      aggregatePipeline,
      parsedPage,
      parsedLimit,
    );
    pagination = paginated.pagination;
    aggregatePipeline.push(
      { $sort: { createdAt: -1 } },
      { $skip: paginated.skip },
      { $limit: parsedLimit },
    );
  }

  const rides = await RideModel.aggregate(aggregatePipeline);

  return {
    data: rides,
    ...(!dataOnly && { pagination }),
  };
}

async function getRidesForDriverService(
  driver,
  status = RIDE_STATUS.REQUESTED,
  page = 1,
  limit = 10,
) {
  const position = await redis.geopos(
    REDIS_CONSTANTS.DRIVER_GEO_KEY,
    driver._id,
  );

  if (!position || !position[0]) {
    throw new BadRequestError("DRIVER_IS_OFFLINE");
  }

  const [lng, lat] = position[0].map(Number);

  const currentPage = parseInt(page, 10);
  const itemsPerPage = parseInt(limit, 10);
  const skip = (currentPage - 1) * itemsPerPage;
  const { maxRideDistanceMeters } =
    await getRideDistanceConfigurationForRuntime();

  const pipeline = [
    {
      $geoNear: {
        near: {
          type: "Point",
          coordinates: [lng, lat],
        },
        distanceField: "distance",
        maxDistance: maxRideDistanceMeters,
        spherical: true,
        query: {
          rideStatus: status,
          // Private rides are retired, so they are no longer offered here.
          // Historical ones stay readable through ride history.
          rideType: driver.vehicleType,
        },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "user",
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
      $unwind: "$user",
    },
    {
      $lookup: {
        from: "rideoffers",
        let: { rideId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$ride", "$$rideId"] },
                  { $eq: ["$driver", driver._id] },
                  { $eq: ["$status", "pending"] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "myOffer",
      },
    },
    {
      $addFields: {
        hasOffered: { $gt: [{ $size: "$myOffer" }, 0] },
        rideFare: {
          $cond: [
            { $gt: ["$rideFare", 0] },
            "$rideFare",
            {
              $cond: [
                { $eq: [driver.vehicleType, "economy"] },
                "$economyRideFare",
                "$luxuryRideFare",
              ],
            },
          ],
        },
      },
    },
    {
      $addFields: {
        driverFare: {
          $cond: [
            { $eq: ["$rideType", "private"] },
            {
              $cond: [
                { $eq: [driver.vehicleType, "economy"] },
                {
                  $cond: [
                    {
                      $gt: [{ $ifNull: ["$originalEconomyRideFare", 0] }, 0],
                    },
                    "$originalEconomyRideFare",
                    "$rideFare",
                  ],
                },
                {
                  $cond: [
                    {
                      $gt: [{ $ifNull: ["$originalLuxuryRideFare", 0] }, 0],
                    },
                    "$originalLuxuryRideFare",
                    "$rideFare",
                  ],
                },
              ],
            },
            {
              $cond: [
                { $gt: [{ $ifNull: ["$originalRideFare", 0] }, 0] },
                "$originalRideFare",
                {
                  $add: [
                    { $ifNull: ["$rideFare", 0] },
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
            },
          ],
        },
      },
    },
    {
      $project: {
        myOffer: 0,
      },
    },
    { $skip: skip },
    { $limit: itemsPerPage },
  ];

  const rides = await RideModel.aggregate(pipeline);

  const total = await RideModel.countDocuments({
    rideStatus: status,
  });

  return {
    data: rides,
    pagination: {
      page: currentPage,
      limit: itemsPerPage,
      total,
      totalPages: Math.ceil(total / itemsPerPage),
    },
  };
}

async function generateSharedRideLink(rideId, locale) {
  const ride = await RideModel.findById(rideId);

  if (!ride) throw new NotFoundError(t("RIDE_NOT_FOUND_OR_DELETED", locale));

  const encodedURL = encodeSharedLink(ride._id, locale);

  return {
    data: {
      url: encodedURL,
    },
  };
}

async function cancelRideService(rideId, role, cancellationReason) {
  const ride = await RideModel.findById(rideId);

  if (!ride) throw new NotFoundError(t("RIDE_NOT_FOUND_OR_DELETED"));

  ride.cancelledBy = role;
  ride.cancellationReason = cancellationReason;
  await ride.save();

  return {
    data: {
      ride,
    },
  };
}

async function chargeCancellationFee(rideId, userId) {
  const ride = await RideModel.findById(rideId).lean();
  if (!ride) {
    throw new NotFoundError(`Ride ${rideId} not found`);
  }

  const fare = Number(ride.rideFare);

  if (!Number.isFinite(fare)) {
    throw new BadRequestError(
      `Ride ${rideId} has an invalid fare: ${ride.rideFare}`,
    );
  }

  // A ride the rider owes nothing for (a 100% promo, or a referral bigger than
  // the fare) has no fee to charge. Throwing here used to block the rider from
  // cancelling it at all.
  if (fare <= 0) return;

  if (![RIDE_STATUS.ARRIVED, RIDE_STATUS.COMING].includes(ride.rideStatus)) {
    return;
  }

  const cancellationFee = parseFloat(
    (ride.rideFare * CANCELLATION_FEE).toFixed(2),
  );

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const user = await UserModel.findById(userId).session(session);
      if (!user) {
        throw new NotFoundError(`User ${userId} not found`);
      }

      const walletAllocation = getWalletAllocation(user, cancellationFee, {
        allowNegativeBalance: true,
      });

      const createdTransactions = await TransactionModel.create(
        [
          {
            user: new mongoose.Types.ObjectId(userId),
            userType: "User",
            amount: cancellationFee,
            type: "Debit",
            status: "success",
            ...transactionRewardFields(walletAllocation),
            metadata: { rideId: ride._id, paymentMethod: "wallet" },
          },
          {
            user: new mongoose.Types.ObjectId(ride.driver),
            userType: "Driver",
            amount: cancellationFee,
            type: "Credit",
            status: "success",
            metadata: { rideId: ride._id, paymentMethod: "wallet" },
          },
        ],
        { session, ordered: true },
      );

      await UserModel.findByIdAndUpdate(
        userId,
        {
          $inc: {
            balance: -walletAllocation.regularAmount,
            rewardedBalance: -walletAllocation.rewardedAmount,
          },
        },
        { session, new: true },
      );

      await DriverModel.findByIdAndUpdate(
        ride.driver,
        { $inc: { balance: cancellationFee } },
        { session },
      );

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "ride",
          journeyId: ride._id,
          rideId: ride._id,
          eventType: "ride.cancellation_fee_succeeded",
          phase: "waiting_pickup",
          actor: { type: "user", id: userId },
          source: "service",
          references: { transactionId: createdTransactions[0]._id },
          amount: { value: cancellationFee, currency: "USD" },
          dedupeKey: `ride:${ride._id}:cancellation_fee_succeeded`,
          metadata: { paymentMethod: "wallet" },
        },
        ride.driver,
        { session },
      );
    });

    const user = await UserModel.findById(userId).select("locale");

    try {
      await sendNotificationToSpecificUser({
        title: t(
          "NOTIFICATION_CANCELLATION_FEE_CHARGED_TITLE",
          user?.locale || "en",
        ),
        description: t(
          "NOTIFICATION_CANCELLATION_FEE_CHARGED_DESC",
          user?.locale || "en",
        ),
        userIds: [userId],
        role: "user",
      });
    } catch (error) {
      console.error(
        `Failed to send cancellation fee notification for ride ${rideId}:`,
        error,
      );
    }

    return { success: true, rideId, cancellationFee };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      `Failed to charge cancellation fee for ride ${rideId}: ${error.message}`,
    );
  } finally {
    await session.endSession();
    console.log("Session ended for cancellation fee charge, ride:", rideId);
  }
}

async function handleDriverSuspension(driverId) {
  const cancellationKey = `${DRIVER}:${driverId}:${CANCELLATIONS}`;

  const cancellationCount = await redis.incr(cancellationKey);

  if (cancellationCount === 1) {
    await redis.expire(
      cancellationKey,
      REDIS_CONSTANTS.CANCELLATION_WINDOW_TTL,
    );
  }

  if (cancellationCount === 2) {
    const driver = await DriverModel.findById(driverId).select("locale");

    if (driver) {
      sendNotificationToSpecificUser({
        title: t("RIDE_CANCELLATION_WARNING", driver.locale),
        description: t("RIDE_CANCELLATION_WARNING_DESC", driver.locale),
        userIds: [driverId],
      });
    }
  }

  if (cancellationCount === REDIS_CONSTANTS.MAX_CANCELLATIONS) {
    const driver = await DriverModel.findById(driverId).select(
      "firstName lastName locale",
    );

    if (driver) {
      const remainingTime = await redis.ttl(cancellationKey);
      const suspensionDescription = t("DRIVER_SUSPENDED_DESC", driver.locale)
        .replace("${count}", REDIS_CONSTANTS.MAX_CANCELLATIONS)
        .replace("${duration}", secondsToWords(remainingTime, driver.locale));

      try {
        await sendNotificationToSpecificUser({
          title: t("DRIVER_SUSPENDED_TITLE", driver.locale),
          description: suspensionDescription,
          userIds: [driverId],
          role: "driver",
          metadata: {
            type: "DRIVER_SUSPENDED",
            reason: "ride_cancellations",
            cancellationCount: REDIS_CONSTANTS.MAX_CANCELLATIONS,
          },
        });
      } catch (error) {
        console.error("Failed to send driver suspension notification:", error);
      }
    }

    await LoggedDeviceModel.deleteMany({
      user: new mongoose.Types.ObjectId(driverId),
      userType: "Driver",
    });

    if (driver) {
      saveNotification({
        title: "Driver Suspended for Repeated Cancellations",
        description: `${driver.firstName} ${driver.lastName || ""} has been suspended due to repeated ride cancellations.`,
        metadata: {
          id: driverId,
          type: "driver",
        },
        userIds: [],
        role: "Admin",
      });
    }
  }

  return cancellationCount >= REDIS_CONSTANTS.MAX_CANCELLATIONS;
}

async function isDriverSuspended(driverId) {
  const cancellationKey = `${DRIVER}:${driverId}:${CANCELLATIONS}`;
  const adminSuspensionKey = REDIS_CONSTANTS.keys.adminSuspension(driverId);

  const [count, cancellationTtl, adminSuspensionRaw, adminSuspensionTtl] =
    await Promise.all([
      redis.get(cancellationKey),
      redis.ttl(cancellationKey),
      redis.get(adminSuspensionKey),
      redis.ttl(adminSuspensionKey),
    ]);

  const cancellationSuspended =
    Number(count) >= REDIS_CONSTANTS.MAX_CANCELLATIONS;

  if (adminSuspensionRaw) {
    return {
      suspended: true,
      remainingTime: adminSuspensionTtl >= 0 ? adminSuspensionTtl : null,
      reason: "admin_suspension",
    };
  }

  return {
    suspended: cancellationSuspended,
    remainingTime: cancellationSuspended ? cancellationTtl : null,
    reason: cancellationSuspended ? "ride_cancellations" : null,
  };
}

async function removeRideFromCache(rideId, userId, driverId) {
  await Promise.all([
    redis.del(`${RIDE}:${SESSION}:${rideId}`),
    redis.del(`${USER}:${userId}:${RIDE}:${ACTIVE}`),
    redis.del(`${USER}:${userId}:${RIDE}:${PENDING}`),
    redis.del(`${DRIVER}:${driverId}:${RIDE}:${ACTIVE}`),
  ]);
}

async function cancelRidePendingRequest(rideId, userId) {
  const cancelledAt = new Date();
  const ride = await RideModel.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(rideId),
      user: new mongoose.Types.ObjectId(userId),
      rideStatus: RIDE_STATUS.REQUESTED,
    },
    {
      rideStatus: RIDE_STATUS.CANCELLED,
      cancelledBy: "user",
      cancellationReason: "pending_request_cancelled",
      cancelledAt,
      endTime: cancelledAt,
    },
    { new: true },
  );

  if (!ride) {
    throw new NotFoundError(
      `Requested ride ${rideId} not found for user ${userId}`,
    );
  }

  // Cancelled before anyone took it: the rider keeps their referral code.
  if (ride.riderReferral) await releaseReferralForRide(ride._id);

  const cancelledAttempt = ride.searchAttempt ?? 0;

  await Promise.all([
    redis.del(`${RIDE}:${SESSION}:${rideId}`),
    redis.del(`${USER}:${userId}:${RIDE}:${PENDING}`),
    redis.del(REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId)),
    // The rider may have cancelled while an upgrade offer was on screen. The
    // ride is already `cancelled`, so the window job would find nothing to do —
    // dropping it is housekeeping, and must never fail the cancellation.
    cancelPendingRings({ rideId: String(rideId), attempt: cancelledAttempt }),
    cancelUpgradeDecision({
      rideId: String(rideId),
      attempt: cancelledAttempt,
    }),
  ]).catch((error) =>
    console.error(
      "Cleanup after a cancelled pending request failed",
      error?.message ?? error,
    ),
  );

  await recordJourneyEvent({
    journeyType: "ride",
    journeyId: ride._id,
    rideId: ride._id,
    eventType: "ride.cancelled",
    phase: "ended",
    actor: { type: "user", id: userId },
    source: "socket",
    transition: {
      from: RIDE_STATUS.REQUESTED,
      to: RIDE_STATUS.CANCELLED,
    },
    occurredAt: cancelledAt,
    location: ride.pickupPoint?.location,
    locationSource: "planned_stop",
    reasonCode: "pending_request_cancelled",
    dedupeKey: `ride:${ride._id}:cancelled`,
  });

  return ride;
}

async function iAmComing(rideId, io, userId) {
  const ride = await RideModel.findById(rideId).populate("driver");
  if (!ride) {
    throw new NotFoundError(`Ride ${rideId} not found`);
  }

  if (ride.rideStatus !== RIDE_STATUS.ARRIVED) {
    throw new BadRequestError(
      `Cannot mark as coming for ride ${rideId} with status ${ride.rideStatus}`,
    );
  }

  if (userId && ride.user.toString() !== userId.toString()) {
    throw new BadRequestError("You are not the passenger for this ride");
  }

  const updatedRide = await updateRideStatusService(
    rideId,
    RIDE_STATUS.COMING,
    null,
    {
      actorType: "user",
      actorId: userId || ride.user,
      source: "http",
    },
  );

  const rideRoom = `ride:${ride._id}`;
  io.to(rideRoom).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
    rideId,
    type: updatedRide.rideStatus,
    ride: parseRide(await getRideWithRelations(ride._id)),
    driverFare: getRideDriverFare(updatedRide),
  });

  sendNotificationToSpecificUser({
    title: t("PASSENGER_ON_THE_WAY", ride.driver.locale),
    description: t("PASSENGER_ON_THE_WAY_DESC", ride.driver.locale),
    userIds: [ride.driver._id],
    metadata: {
      rideId: ride._id,
      driverId: ride.driver._id,
      status: updatedRide.rideStatus,
    },
  });

  return { success: true };
}

module.exports = {
  assertRiderCanPayFare,
  createRideRequestService,
  acceptRideService,
  updateRideStatusService,
  updateRideService,
  prepareRideForStart,
  verifyRideOTPService,
  getActiveRideForUser,
  getActiveRideForDriver,
  getRideWithRelations,
  chargeUserForRide,
  rideFareCalculator,
  rideHistory,
  getRidesForDriverService,
  refreshDriverRequestList,
  generateSharedRideLink,
  cancelRideService,
  chargeCancellationFee,
  handleDriverSuspension,
  isDriverSuspended,
  removeRideFromCache,
  cancelRidePendingRequest,
  iAmComing,
  createRideOfferService,
  acceptRideOfferService,
  rejectRideOfferService,
  getRideOffers,
};
