const RideModel = require("./model/ride.model");
const RideOfferModel = require("./model/ride-offer.model");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  RIDE_STATUS,
  RIDE_SOCKET_EVENTS,
  USER,
  RIDE,
  PENDING,
  SESSION,
  SOCKET,
} = require("../../core/common/constants/ride-constants");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");

const redis = getRedisConnection();
const { recordJourneyEvent } = require("../journey-log/journey-log.service");
const {
  releaseReferralForRide,
} = require("../driver-referral/driver-referral.service");
const {
  retryPendingMidTripSettlements,
} = require("./ride-mid-trip-cancellation.service");

/**
 * Expire private rides whose 1-hour acceptance window has elapsed.
 *
 * A private ride is considered expired when its `ride:<id>:private:alive`
 * Redis key (set with a 1-hour TTL at creation) no longer exists.
 *
 * For each such ride we:
 *  1. Update the ride status to "cancelled" in MongoDB.
 *  2. Mark all pending RideOffers for that ride as "expired".
 *  3. Clean up the Redis session / pending keys for the user.
 *  4. Emit a STATUS_UPDATE socket event to the ride room so the user's
 *     app reacts immediately if they are still connected.
 */
async function expirePrivateRides(io) {
  // Find all private rides that are still in REQUESTED status.
  // We only need rides created more than 1 hour ago — if the alive key
  // still exists Redis will confirm it, so we query with a generous window
  // (older than 55 minutes to account for any clock skew) and then let
  // the Redis key be the definitive truth.
  const cutoff = new Date(Date.now() - 55 * 60 * 1000); // 55 min ago

  const staleRides = await RideModel.find({
    rideType: "private",
    rideStatus: RIDE_STATUS.REQUESTED,
    createdAt: { $lte: cutoff },
  }).select("_id user rideFare originalRideFare discountAmount");

  if (!staleRides.length) return;

  for (const ride of staleRides) {
    const rideId = ride._id.toString();
    const userId = ride.user.toString();

    // Redis is the authoritative expiry check — if the key still exists
    // the ride is still within its 1-hour window, skip it.
    const aliveKey = `${RIDE}:${rideId}:private:alive`;
    const isAlive = await redis.exists(aliveKey);
    if (isAlive) continue;

    console.log(
      `⏰ [RIDE CRON] Expiring private ride ${rideId} for user ${userId}`,
    );

    // 1. Only expire a ride that is still requested. Acceptance uses the
    // inverse conditional transition, so exactly one operation can win.
    const expiredRide = await RideModel.findOneAndUpdate(
      { _id: rideId, rideStatus: RIDE_STATUS.REQUESTED },
      {
        rideStatus: RIDE_STATUS.CANCELLED,
        cancellationReason: "private_ride_expired",
        cancelledBy: null,
        endTime: new Date(),
      },
      { new: true },
    );

    if (!expiredRide) continue;

    if (expiredRide.riderReferral) {
      await releaseReferralForRide(expiredRide._id);
    }

    await recordJourneyEvent({
      journeyType: "ride",
      journeyId: ride._id,
      rideId: ride._id,
      eventType: "ride.cancelled",
      phase: "ended",
      actor: { type: "system", id: null },
      source: "cron",
      transition: {
        from: RIDE_STATUS.REQUESTED,
        to: RIDE_STATUS.CANCELLED,
      },
      reasonCode: "private_ride_expired",
      dedupeKey: `ride:${ride._id}:cancelled`,
    });

    // 2. Mark all pending offers for this ride as expired
    await RideOfferModel.updateMany(
      { ride: ride._id, status: "pending" },
      { status: "expired" },
    );

    // 3. Clean up Redis keys for this user / ride
    await Promise.all([
      redis.del(`${RIDE}:${SESSION}:${rideId}`),
      redis.del(`${USER}:${userId}:${RIDE}:${PENDING}`),
    ]);

    // 4. Notify the user via socket if they are connected
    if (io) {
      const userSocketId = await redis.get(`${USER}:${userId}:${SOCKET}`);
      if (userSocketId) {
        const rideRoom = `${RIDE}:${rideId}`;
        io.to(rideRoom).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
          rideId,
          type: RIDE_STATUS.CANCELLED,
          message: "Private ride expired — no driver accepted within 1 hour.",
          driverFare: getRideDriverFare(ride),
        });
      }
    }

    console.log(`✅ [RIDE CRON] Private ride ${rideId} expired and cancelled.`);
  }
}

class RideCron {
  static schedule() {
    let io = null;
    try {
      const { socketService } = require("../../../app");
      io = socketService?.io || null;
    } catch (e) {
      // Will retry on next tick
    }

    setInterval(async () => {
      try {
        if (!io) {
          const { socketService } = require("../../../app");
          io = socketService?.io || null;
        }
        await expirePrivateRides(io);
      } catch (err) {
        console.error("RideCron error:", err?.message);
      }

      // Refunds for mid-trip cancellations that failed or crashed.
      try {
        await retryPendingMidTripSettlements();
      } catch (err) {
        console.error(
          "RideCron mid-trip settlement retry error:",
          err?.message,
        );
      }
    }, 60 * 1000); // every 1 minute
  }
}

module.exports = {
  init: () => RideCron.schedule(),
};
