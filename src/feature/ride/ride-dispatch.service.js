const RideModel = require("./model/ride.model");
const DriverModel = require("../driver/models/driver.model");
const UserModel = require("../user/models/user.model");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  USER,
  RIDE,
  PENDING,
  SESSION,
  RIDE_STATUS,
  RIDE_SOCKET_EVENTS,
  DRIVER_SOCKET_EVENTS,
  DEFAULT_DISTANCE_UNIT,
} = require("../../core/common/constants/ride-constants");
const {
  getRideDistanceConfigurationForRuntime,
  resolveAppMessage,
  toDisplayDistance,
} = require("../config/ride-configuration.service");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const { t } = require("../../core/common/helpers");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { recordJourneyEvent } = require("../journey-log/journey-log.service");
const {
  releaseReferralForRide,
} = require("../driver-referral/driver-referral.service");

const redis = getRedisConnection();

const TAG = "[DISPATCH]";

/**
 * Socket.IO is created in app.js, which requires this module transitively, and
 * the BullMQ worker runs with no `io` in hand at all. Both paths resolve it
 * late rather than holding a reference that may not exist yet.
 */
function resolveIo(io) {
  if (io) return io;
  try {
    const { socketService } = require("../../../app");
    return socketService?.io || null;
  } catch {
    return null;
  }
}

const rideRoom = (rideId) => `${RIDE}:${rideId}`;

/**
 * Narrow a ring of geo hits down to the drivers who can actually take the ride.
 *
 * One pipeline for every Redis read, one query for every locale. The previous
 * inline version issued three serial round trips per driver, which made a
 * request slower the more drivers were nearby — exactly backwards.
 */
async function filterEligibleDrivers(driverIds, { rideType }) {
  if (!driverIds.length) return [];

  const pipeline = redis.pipeline();
  for (const driverId of driverIds) {
    pipeline.hgetall(REDIS_CONSTANTS.keys.driverHash(driverId));
    pipeline.get(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId));
    pipeline.get(REDIS_CONSTANTS.keys.driverActive(driverId));
  }

  const results = await pipeline.exec();
  const eligible = [];

  driverIds.forEach((driverId, index) => {
    const base = index * 3;
    const hash = results?.[base]?.[1];
    const activeCarpool = results?.[base + 1]?.[1];
    const activeRide = results?.[base + 2]?.[1];

    if (!hash || hash.status !== DRIVER_SOCKET_EVENTS.ONLINE_STATUS) return;
    if (hash.vehicleType !== rideType) return;
    if (activeCarpool || activeRide) return;
    if (!hash.socket) return;

    eligible.push({ driverId: String(driverId), socket: hash.socket });
  });

  return eligible;
}

function buildIncomingPayload(ride, { ringIndex, radiusMiles, distanceUnit }) {
  const rider = ride.user;
  const unit = distanceUnit || DEFAULT_DISTANCE_UNIT;

  return {
    rideId: ride._id,
    pickupPoint: ride.pickupPoint,
    dropOffPoint: ride.dropOffPointRequested,
    rideType: ride.rideType,
    specialRequest: ride.specialRequest,
    rideDistance: ride.rideDistance,
    averageTime: ride.averageTime,
    paymentMethod: ride.paymentMethod,
    rideFare: ride.rideFare,
    driverFare: getRideDriverFare(ride),
    user: {
      id: rider?._id,
      firstName: rider?.firstName,
      lastName: rider?.lastName,
      profilePicture: rider?.profilePicture,
      rating: rider?.rating,
      reviews: rider?.reviewsReceived,
    },
    // `radius` and `distanceUnit` ride along so the driver app prints the reach
    // of the ring without converting anything or knowing what a mile is.
    dispatch: {
      ring: ringIndex + 1,
      radiusMiles,
      radius: toDisplayDistance(radiusMiles, unit),
      distanceUnit: unit,
    },
  };
}

async function notifyDrivers({
  ride,
  eligible,
  io,
  ringIndex,
  radiusMiles,
  distanceUnit,
}) {
  const payload = buildIncomingPayload(ride, {
    ringIndex,
    radiusMiles,
    distanceUnit,
  });
  const driverIds = eligible.map((driver) => driver.driverId);

  const drivers = await DriverModel.find({ _id: { $in: driverIds } })
    .select("locale")
    .lean();
  const localeByDriver = new Map(
    drivers.map((driver) => [String(driver._id), driver.locale || "en"]),
  );

  for (const { socket } of eligible) {
    io?.to(socket).emit(RIDE_SOCKET_EVENTS.INCOMING, payload);
  }

  // Push notifications are fire-and-forget: a failed push must never hold up
  // the ring or keep the ladder from advancing.
  for (const { driverId } of eligible) {
    const locale = localeByDriver.get(driverId) || "en";
    sendNotificationToSpecificUser({
      title: t("NEW_RIDE", locale),
      description: t("NEW_RIDE_DESC", locale),
      userIds: [driverId],
      skipSave: true,
      metadata: { type: "NEW_RIDE_REQUEST", id: String(ride._id) },
    });
  }
}

/**
 * Close a request that no driver took. Conditional on the ride still being
 * "requested", so a driver who accepts in the last instant always wins the race
 * against the expiry rather than ending up assigned to a dead ride.
 */
async function exhaustSearch({
  rideId,
  io,
  radiusReachedMiles,
  configuration,
  distanceUnit,
  // Why this request died. Defaults describe a search nobody answered; the
  // upgrade path passes its own, so a declined or unanswered offer is
  // distinguishable in history from a search that simply found nobody.
  cancellationReason = "no_drivers_available",
  reasonCode = "NO_DRIVERS_AVAILABLE",
}) {
  const occurredAt = new Date();

  const ride = await RideModel.findOneAndUpdate(
    { _id: rideId, rideStatus: RIDE_STATUS.REQUESTED },
    {
      rideStatus: RIDE_STATUS.EXPIRED,
      cancellationReason,
      endTime: occurredAt,
    },
    { new: true },
  );

  if (!ride) return { stopped: "ALREADY_RESOLVED" };

  // Nobody took the ride, so the rider keeps their referral code for the next.
  if (ride.riderReferral) await releaseReferralForRide(ride._id);

  const userId = ride.user.toString();

  // Locale lives on the rider, not the ride.
  const rider = await UserModel.findById(userId).select("locale").lean();

  await Promise.all([
    redis.del(`${RIDE}:${SESSION}:${rideId}`),
    redis.del(`${USER}:${userId}:${RIDE}:${PENDING}`),
    redis.del(REDIS_CONSTANTS.keys.rideNotifiedDrivers(rideId)),
    redis.del(REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId)),
  ]);

  const locale = rider?.locale || "en";
  const unit = distanceUnit || DEFAULT_DISTANCE_UNIT;

  resolveIo(io)
    ?.to(rideRoom(rideId))
    .emit(RIDE_SOCKET_EVENTS.SEARCH_EXHAUSTED, {
      rideId: ride._id,
      reason: reasonCode,
      // Resolved here rather than in the app: the panel can rewrite this
      // sentence without anybody shipping a build.
      message: resolveAppMessage(
        configuration,
        "RIDE_SEARCH_EXHAUSTED",
        locale,
        {
          radius: toDisplayDistance(radiusReachedMiles, unit),
          unit,
        },
      ),
      radiusReachedMiles,
      radiusReached: toDisplayDistance(radiusReachedMiles, unit),
      distanceUnit: unit,
    });

  await recordJourneyEvent({
    journeyType: "ride",
    journeyId: ride._id,
    rideId: ride._id,
    eventType: "ride.search_exhausted",
    phase: "ended",
    actor: { type: "system", id: null },
    source: "dispatch",
    transition: { from: RIDE_STATUS.REQUESTED, to: RIDE_STATUS.EXPIRED },
    reasonCode,
    dedupeKey: `ride:${ride._id}:search_exhausted`,
    metadata: { radiusReachedMiles },
  });

  console.log(
    `${TAG} ride ${rideId} expired — no driver within ${radiusReachedMiles} mi`,
  );

  return { stopped: "EXHAUSTED" };
}

/**
 * Open one ring of the ladder: search, notify whoever is new, tell the rider
 * where the search stands, and hand the next ring to the queue.
 *
 * Every entry re-reads the ride first. That single check is what makes the
 * whole chain safe to leave queued: a cancelled or already-accepted ride stops
 * the ladder dead, whether or not the pending job was removed.
 */
async function dispatchRing({
  rideId,
  ringIndex = 0,
  io: providedIo,
  attempt = 0,
}) {
  const io = resolveIo(providedIo);

  const ride = await RideModel.findById(rideId).populate(
    "user",
    // `locale` rides along because the dispatch copy is built for the rider,
    // not for the server.
    "firstName lastName profilePicture rating reviewsReceived locale",
  );

  if (!ride) return { stopped: "RIDE_NOT_FOUND" };
  if (ride.rideStatus !== RIDE_STATUS.REQUESTED) {
    return { stopped: "ALREADY_RESOLVED", rideStatus: ride.rideStatus };
  }

  // A straggler ring from a search that has since been replaced must not reopen
  // a ring, and must never conclude the search that superseded it. Without this
  // the job queued by the old search's last ring wakes up mid-upgrade and
  // expires a search that is only seconds old.
  if ((ride.searchAttempt ?? 0) !== attempt) {
    return { stopped: "STALE_SEARCH", searchAttempt: ride.searchAttempt };
  }

  const {
    dispatchLadderMiles,
    dispatchLadderKilometers,
    dispatchRingTimeoutSeconds,
    distanceUnit,
    categoryUpgrade,
    configuration,
  } = await getRideDistanceConfigurationForRuntime();

  // Past the last ring: the final wave has had its window and nobody took it.
  // What happens now — expire, or ask the rider to search another category —
  // belongs to the upgrade service. Required late: it loads this module back.
  if (ringIndex >= dispatchLadderKilometers.length) {
    const { concludeSearch } = require("./ride-upgrade.service");

    return concludeSearch({
      rideId,
      io,
      radiusReachedMiles: dispatchLadderMiles[dispatchLadderMiles.length - 1],
      configuration,
      distanceUnit,
      categoryUpgrade,
      attempt,
    });
  }

  const radiusMiles = dispatchLadderMiles[ringIndex];
  const [lng, lat] = ride.pickupPoint.location.coordinates;

  const found = await redis.geosearch(
    REDIS_CONSTANTS.DRIVER_GEO_KEY,
    REDIS_CONSTANTS.FROMLONLAT,
    lng,
    lat,
    REDIS_CONSTANTS.BYRADIUS,
    dispatchLadderKilometers[ringIndex],
    REDIS_CONSTANTS.KM,
  );

  const notifiedKey = REDIS_CONSTANTS.keys.rideNotifiedDrivers(rideId);
  const alreadyNotified = new Set(await redis.smembers(notifiedKey));

  // A wider ring re-contains every driver from the narrower ones. Offering the
  // same ride twice to the same driver is noise, so only newcomers are kept.
  const newcomers = found
    .map(String)
    .filter((driverId) => !alreadyNotified.has(driverId));

  const eligible = await filterEligibleDrivers(newcomers, {
    rideType: ride.rideType,
  });

  if (eligible.length) {
    await redis.sadd(notifiedKey, ...eligible.map((driver) => driver.driverId));
    await redis.expire(notifiedKey, REDIS_CONSTANTS.RIDE_SESSION_TTL);
    await notifyDrivers({
      ride,
      eligible,
      io,
      ringIndex,
      radiusMiles,
      distanceUnit,
    });
  }

  const totalNotified = alreadyNotified.size + eligible.length;
  const riderLocale = ride.user?.locale || "en";
  const displayRadius = toDisplayDistance(radiusMiles, distanceUnit);

  io?.to(rideRoom(rideId)).emit(RIDE_SOCKET_EVENTS.SEARCH_STATUS, {
    rideId: ride._id,
    ring: ringIndex + 1,
    totalRings: dispatchLadderMiles.length,
    radiusMiles,
    // The same radius in whatever unit the apps are set to print, with the
    // sentence already built from it. An app that shows `message` needs to know
    // nothing about rings, miles or kilometres.
    radius: displayRadius,
    distanceUnit,
    message: resolveAppMessage(
      configuration,
      "RIDE_SEARCH_IN_PROGRESS",
      riderLocale,
      {
        ring: ringIndex + 1,
        totalRings: dispatchLadderMiles.length,
        radius: displayRadius,
        unit: distanceUnit,
        seconds: dispatchRingTimeoutSeconds,
      },
    ),
    driversNotified: eligible.length,
    totalNotified,
    nextRingInSeconds: dispatchRingTimeoutSeconds,
  });

  console.log(
    `${TAG} ride ${rideId} ring ${ringIndex + 1}/${dispatchLadderMiles.length} ` +
      `(${radiusMiles} mi): ${found.length} found, ${eligible.length} new, ${totalNotified} total`,
  );

  // The next step is always scheduled, even after the last ring — that queued
  // job is what gives the final wave its full window before the request dies.
  const { enqueueNextRing } = require("./ride-dispatch.producer");
  await enqueueNextRing({
    rideId: String(rideId),
    ringIndex: ringIndex + 1,
    delayMs: dispatchRingTimeoutSeconds * 1000,
    attempt,
  });

  return {
    ring: ringIndex + 1,
    radiusMiles,
    driversNotified: eligible.length,
    totalNotified,
  };
}

/**
 * Kick off the ladder for a brand-new request. Ring 0 runs inline so the
 * closest drivers are pinged in the same breath as the request, with no queue
 * latency in between.
 */
async function startDispatch({ rideId, io, attempt = 0 }) {
  return dispatchRing({ rideId, ringIndex: 0, io, attempt });
}

/**
 * Tell every driver who was offered this ride, except the winner, that it is
 * gone — and hand them a refreshed list, so the request leaves their screen
 * without them having to tap a dead card to find out.
 */
async function withdrawRideFromOtherDrivers({
  rideId,
  winnerDriverId,
  io,
  // Why the card is going away. A `winnerDriverId` of null withdraws from
  // everyone, which is what an upgrade needs: the request has changed category
  // and belongs to nobody in this one any more.
  reason = "RIDE_ALREADY_TAKEN",
}) {
  const resolvedIo = resolveIo(io);
  const notifiedKey = REDIS_CONSTANTS.keys.rideNotifiedDrivers(rideId);
  const notified = await redis.smembers(notifiedKey);

  const losers = notified.filter(
    (driverId) => String(driverId) !== String(winnerDriverId),
  );

  if (losers.length && resolvedIo) {
    // Required late: ride.service.js loads this module, so a top-level require
    // here would close the cycle.
    const { refreshDriverRequestList } = require("./ride.service");

    await Promise.all(
      losers.map(async (driverId) => {
        try {
          const socketId = await redis.hget(
            REDIS_CONSTANTS.keys.driverHash(driverId),
            "socket",
          );
          if (!socketId) return;

          const availableRides = await refreshDriverRequestList(driverId);

          resolvedIo.to(socketId).emit(RIDE_SOCKET_EVENTS.REQUEST_TAKEN, {
            rideId,
            reason,
            availableRides,
          });
        } catch (error) {
          console.error(
            `${TAG} could not withdraw ride ${rideId} from driver ${driverId}:`,
            error.message,
          );
        }
      }),
    );
  }

  await redis.del(notifiedKey);

  return { withdrawnFrom: losers.length };
}

module.exports = {
  dispatchRing,
  exhaustSearch,
  filterEligibleDrivers,
  startDispatch,
  withdrawRideFromOtherDrivers,
};
