const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const { randomUUID } = require("node:crypto");

const RELEASE_IF_OWNED_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

async function releaseIfOwned(redis, key, value) {
  return redis.eval(RELEASE_IF_OWNED_SCRIPT, 1, key, String(value));
}

async function claimRideForDriver(
  redis,
  { rideId, driverId, rideLockTtlSeconds = 30 },
) {
  const normalizedRideId = String(rideId);
  const normalizedDriverId = String(driverId);
  const rideLockOwner = `${normalizedDriverId}:${randomUUID()}`;
  const rideLockKey = REDIS_CONSTANTS.keys.rideLock(normalizedRideId);
  const driverActiveKey = REDIS_CONSTANTS.keys.driverActive(normalizedDriverId);

  const rideLock = await redis.set(
    rideLockKey,
    rideLockOwner,
    REDIS_CONSTANTS.NX,
    REDIS_CONSTANTS.EX,
    rideLockTtlSeconds,
  );

  if (!rideLock) {
    return {
      acquired: false,
      reason: "RIDE_ALREADY_TAKEN",
      rideId: normalizedRideId,
      driverId: normalizedDriverId,
      rideLockKey,
      driverActiveKey,
      rideLockOwner,
    };
  }

  // The active-ride key doubles as the atomic, cross-ride driver claim. It has
  // no TTL because it remains the source of truth until the ride ends.
  const driverClaim = await redis.set(
    driverActiveKey,
    normalizedRideId,
    REDIS_CONSTANTS.NX,
  );

  if (!driverClaim) {
    await releaseIfOwned(redis, rideLockKey, rideLockOwner);
    return {
      acquired: false,
      reason: "DRIVER_ALREADY_ON_RIDE",
      rideId: normalizedRideId,
      driverId: normalizedDriverId,
      rideLockKey,
      driverActiveKey,
      rideLockOwner,
    };
  }

  return {
    acquired: true,
    rideId: normalizedRideId,
    driverId: normalizedDriverId,
    rideLockKey,
    driverActiveKey,
    rideLockOwner,
  };
}

async function releaseRideForDriverClaim(redis, claim) {
  if (!claim?.acquired) return;

  await Promise.all([
    releaseIfOwned(redis, claim.rideLockKey, claim.rideLockOwner),
    releaseIfOwned(redis, claim.driverActiveKey, claim.rideId),
  ]);
}

module.exports = {
  claimRideForDriver,
  releaseRideForDriverClaim,
};
