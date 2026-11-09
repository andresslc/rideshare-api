/**
 * End-to-end check of the dispatch ladder against the local stack.
 *
 *   docker compose -f docker-compose.local.yml exec app-local node scripts/verify-dispatch.js
 *
 * Seeds synthetic drivers at known distances from a pickup point, then walks
 * the ladder ring by ring and asserts who is reached when. Cleans up after
 * itself. Safe to re-run; it only touches the fixtures it creates.
 */
const mongoose = require("mongoose");

const {
  getRedisConnection,
} = require("../src/core/services/redis/redis.service");
const {
  REDIS_CONSTANTS,
} = require("../src/core/common/constants/redis-constants");
const { RIDE_STATUS } = require("../src/core/common/constants/ride-constants");
const {
  getRideDistanceConfigurationForRuntime,
} = require("../src/feature/config/ride-configuration.service");
const {
  filterEligibleDrivers,
  exhaustSearch,
} = require("../src/feature/ride/ride-dispatch.service");
const RideModel = require("../src/feature/ride/model/ride.model");
const { MONGO_URI } = require("../config");

const redis = getRedisConnection();

// Brickell, Miami. Longitude first, the order both Redis and GeoJSON expect.
const PICKUP = { lng: -80.1918, lat: 25.7617 };

const MILES_TO_DEGREES_LAT = 1 / 69.0;

function pointAtMiles(miles) {
  return { lng: PICKUP.lng, lat: PICKUP.lat + miles * MILES_TO_DEGREES_LAT };
}

const FIXTURES = [
  {
    id: "verify-near-economy",
    miles: 0.5,
    status: "online",
    vehicleType: "economy",
  },
  {
    id: "verify-mid-economy",
    miles: 2.5,
    status: "online",
    vehicleType: "economy",
  },
  {
    id: "verify-far-economy",
    miles: 4.5,
    status: "online",
    vehicleType: "economy",
  },
  {
    id: "verify-out-economy",
    miles: 7.0,
    status: "online",
    vehicleType: "economy",
  },
  {
    id: "verify-near-offline",
    miles: 0.6,
    status: "offline",
    vehicleType: "economy",
  },
  {
    id: "verify-near-luxury",
    miles: 0.7,
    status: "online",
    vehicleType: "luxury",
  },
];

let failures = 0;

function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label}` +
      (pass
        ? ""
        : `\n        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`),
  );
}

async function seedDrivers() {
  const pipeline = redis.pipeline();

  for (const fixture of FIXTURES) {
    const { lng, lat } = pointAtMiles(fixture.miles);
    pipeline.geoadd(REDIS_CONSTANTS.DRIVER_GEO_KEY, lng, lat, fixture.id);
    pipeline.hset(REDIS_CONSTANTS.keys.driverHash(fixture.id), {
      socket: `socket-${fixture.id}`,
      status: fixture.status,
      vehicleType: fixture.vehicleType,
    });
  }

  await pipeline.exec();
}

async function cleanupDrivers() {
  const pipeline = redis.pipeline();
  for (const fixture of FIXTURES) {
    pipeline.zrem(REDIS_CONSTANTS.DRIVER_GEO_KEY, fixture.id);
    pipeline.del(REDIS_CONSTANTS.keys.driverHash(fixture.id));
  }
  await pipeline.exec();
}

async function verifyRings() {
  const { dispatchLadderMiles, dispatchLadderKilometers } =
    await getRideDistanceConfigurationForRuntime();

  console.log(`\nLadder in use: ${dispatchLadderMiles.join(" -> ")} miles\n`);

  const cumulative = new Set();
  const reachedPerRing = [];

  for (let ring = 0; ring < dispatchLadderKilometers.length; ring += 1) {
    const found = await redis.geosearch(
      REDIS_CONSTANTS.DRIVER_GEO_KEY,
      REDIS_CONSTANTS.FROMLONLAT,
      PICKUP.lng,
      PICKUP.lat,
      REDIS_CONSTANTS.BYRADIUS,
      dispatchLadderKilometers[ring],
      REDIS_CONSTANTS.KM,
    );

    const mine = found.map(String).filter((id) => id.startsWith("verify-"));
    const newcomers = mine.filter((id) => !cumulative.has(id));
    newcomers.forEach((id) => cumulative.add(id));

    const eligible = await filterEligibleDrivers(newcomers, {
      rideType: "economy",
    });

    reachedPerRing.push(eligible.map((driver) => driver.driverId).sort());

    console.log(
      `  ring ${ring + 1} (${dispatchLadderMiles[ring]} mi): ` +
        `${mine.length} in radius, ${newcomers.length} new, ` +
        `${eligible.length} eligible -> ${eligible.map((d) => d.driverId).join(", ") || "none"}`,
    );
  }

  console.log("");
  check("ring 1 reaches only the closest economy driver", reachedPerRing[0], [
    "verify-near-economy",
  ]);
  check("ring 2 adds nobody new between 1 and 2 miles", reachedPerRing[1], []);
  check("ring 3 reaches the 2.5 mile driver", reachedPerRing[2], [
    "verify-mid-economy",
  ]);
  check("ring 4 reaches the 4.5 mile driver", reachedPerRing[3], [
    "verify-far-economy",
  ]);

  const everyoneReached = [...cumulative].sort();
  check(
    "the 7 mile driver is never reached, and offline/luxury are filtered out",
    everyoneReached.includes("verify-out-economy"),
    false,
  );

  // The offline and luxury drivers sit inside ring 1 but must not be offered
  // the ride: the geo hit finds them, the eligibility filter drops them.
  const ringOneRaw = await redis.geosearch(
    REDIS_CONSTANTS.DRIVER_GEO_KEY,
    REDIS_CONSTANTS.FROMLONLAT,
    PICKUP.lng,
    PICKUP.lat,
    REDIS_CONSTANTS.BYRADIUS,
    dispatchLadderKilometers[0],
    REDIS_CONSTANTS.KM,
  );
  const ringOneMine = ringOneRaw
    .map(String)
    .filter((id) => id.startsWith("verify-"));

  check(
    "offline and luxury drivers are inside ring 1 geographically",
    ["verify-near-offline", "verify-near-luxury"].every((id) =>
      ringOneMine.includes(id),
    ),
    true,
  );
}

async function verifyExhaustion() {
  const userId = new mongoose.Types.ObjectId();

  const ride = await RideModel.create({
    user: userId,
    pickupPoint: {
      placeName: "Verify pickup",
      location: { type: "Point", coordinates: [PICKUP.lng, PICKUP.lat] },
    },
    dropOffPointRequested: {
      placeName: "Verify dropoff",
      location: { type: "Point", coordinates: [-80.2, 25.8] },
    },
    rideType: "economy",
    rideDistance: 4.2,
    rideFare: 18.5,
    paymentMethod: "wallet",
    rideStatus: RIDE_STATUS.REQUESTED,
    requestedAt: new Date(),
  });

  console.log(`\nCreated probe ride ${ride._id} in status ${ride.rideStatus}`);

  await exhaustSearch({
    rideId: String(ride._id),
    io: null,
    radiusReachedMiles: 5,
  });

  const after = await RideModel.findById(ride._id).select(
    "rideStatus cancellationReason",
  );

  check("an exhausted search expires the ride", after.rideStatus, "expired");
  check(
    "the reason says no drivers were available",
    after.cancellationReason,
    "no_drivers_available",
  );

  // Re-running must be a no-op, so a late driver acceptance can never be
  // clobbered by a straggler job.
  const second = await exhaustSearch({
    rideId: String(ride._id),
    io: null,
    radiusReachedMiles: 5,
  });
  check("exhausting twice is a no-op", second.stopped, "ALREADY_RESOLVED");

  await RideModel.deleteOne({ _id: ride._id });
  console.log(`Cleaned up probe ride ${ride._id}`);
}

/**
 * A probe ride sitting in `requested`, ready for a search to conclude on it.
 */
async function createProbeRide(userId, overrides = {}) {
  return RideModel.create({
    user: userId,
    pickupPoint: {
      placeName: "Verify pickup",
      location: { type: "Point", coordinates: [PICKUP.lng, PICKUP.lat] },
    },
    dropOffPointRequested: {
      placeName: "Verify dropoff",
      location: { type: "Point", coordinates: [-80.2, 25.8] },
    },
    rideType: "economy",
    rideDistance: 4.2,
    rideFare: 18.5,
    paymentMethod: "wallet",
    rideStatus: RIDE_STATUS.REQUESTED,
    requestedAt: new Date(),
    ...overrides,
  });
}

/**
 * The upgrade path, end to end: the offer an exhausted economy search puts up,
 * the acceptance that restarts the ladder as luxury, and the two ways the offer
 * can die instead.
 *
 * Runs against the live upgrade map, since the feature has no on/off switch —
 * an environment whose map is empty would report every upgrade check as a plain
 * expiry, which is correct behaviour rather than a failure.
 */
async function verifyCategoryUpgrade() {
  const {
    concludeSearch,
    acceptCategoryUpgrade,
    declineCategoryUpgrade,
    expireCategoryUpgrade,
  } = require("../src/feature/ride/ride-upgrade.service");

  const { distanceUnit, configuration, categoryUpgrade } =
    await getRideDistanceConfigurationForRuntime();

  const conclude = (rideId) =>
    concludeSearch({
      rideId: String(rideId),
      io: null,
      radiusReachedMiles: 5,
      configuration,
      distanceUnit,
      categoryUpgrade,
    });

  // ── The offer ──────────────────────────────────────────────────────────────
  const userId = new mongoose.Types.ObjectId();
  const ride = await createProbeRide(userId);
  console.log(`\nCreated upgrade probe ride ${ride._id}`);

  const offered = await conclude(ride._id);
  const withOffer = await RideModel.findById(ride._id);

  check("an exhausted economy search offers an upgrade", offered.offered, true);
  check(
    "the ride is left requested so a late driver can still win",
    withOffer.rideStatus,
    RIDE_STATUS.REQUESTED,
  );
  check("the offer is open", withOffer.upgradeOffer.status, "offered");
  check("it points at luxury", withOffer.upgradeOffer.toRideType, "luxury");
  check("it carries a price", withOffer.upgradeOffer.quotedFare > 0, true);

  const mirrorTtl = await redis.ttl(
    REDIS_CONSTANTS.keys.rideUpgradeOffer(String(ride._id)),
  );
  check(
    "the resume mirror outlives the decision window",
    mirrorTtl > categoryUpgrade.decisionSeconds,
    true,
  );

  // A retried job must not ask twice.
  const twice = await conclude(ride._id);
  check(
    "concluding twice is a no-op",
    twice.stopped,
    "UPGRADE_ALREADY_OFFERED",
  );

  // ── The acceptance ─────────────────────────────────────────────────────────
  // A wallet that covers the luxury fare, so the payment re-check passes.
  const UserModel = require("../src/feature/user/models/user.model");
  await UserModel.updateOne(
    { _id: userId },
    {
      $setOnInsert: { balance: 500, rewardedBalance: 0 },
    },
    { upsert: true },
  );

  await redis.del(REDIS_CONSTANTS.keys.rideNotifiedDrivers(String(ride._id)));

  const accepted = await acceptCategoryUpgrade({
    rideId: String(ride._id),
    userId: String(userId),
    io: null,
  });
  const upgraded = await RideModel.findById(ride._id);

  check("accepting the offer upgrades the ride", accepted.accepted, true);
  check("the ride is now luxury", upgraded.rideType, "luxury");
  check(
    "the fare is the one the rider was quoted",
    upgraded.rideFare,
    withOffer.upgradeOffer.quotedFare,
  );
  check("the search moved a generation", upgraded.searchAttempt, 1);
  check(
    "the ride is still requested, now searching luxury",
    upgraded.rideStatus,
    RIDE_STATUS.REQUESTED,
  );
  check(
    "the luxury ring reached the seeded luxury driver",
    (
      await redis.smembers(
        REDIS_CONSTANTS.keys.rideNotifiedDrivers(String(ride._id)),
      )
    ).includes("verify-near-luxury"),
    true,
  );
  check(
    "the offer mirror is gone once answered",
    await redis.exists(REDIS_CONSTANTS.keys.rideUpgradeOffer(String(ride._id))),
    0,
  );

  await RideModel.deleteOne({ _id: ride._id });
  await UserModel.deleteOne({ _id: userId });

  // ── Declining ──────────────────────────────────────────────────────────────
  const declineUser = new mongoose.Types.ObjectId();
  const declineRide = await createProbeRide(declineUser);
  await conclude(declineRide._id);
  await declineCategoryUpgrade({
    rideId: String(declineRide._id),
    userId: String(declineUser),
    io: null,
  });

  const declined = await RideModel.findById(declineRide._id);
  check("declining expires the ride", declined.rideStatus, "expired");
  check(
    "the reason says the rider declined",
    declined.cancellationReason,
    "upgrade_declined",
  );
  await RideModel.deleteOne({ _id: declineRide._id });

  // ── The window closing ─────────────────────────────────────────────────────
  const timeoutUser = new mongoose.Types.ObjectId();
  const timeoutRide = await createProbeRide(timeoutUser);
  await conclude(timeoutRide._id);
  await expireCategoryUpgrade({ rideId: String(timeoutRide._id) });

  const timedOut = await RideModel.findById(timeoutRide._id);
  check("an unanswered offer expires the ride", timedOut.rideStatus, "expired");
  check(
    "the reason says nobody answered",
    timedOut.cancellationReason,
    "upgrade_timed_out",
  );

  const again = await expireCategoryUpgrade({
    rideId: String(timeoutRide._id),
  });
  check("expiring twice is a no-op", again.stopped, "OFFER_NOT_PENDING");
  await RideModel.deleteOne({ _id: timeoutRide._id });

  // ── A driver winning the race ──────────────────────────────────────────────
  const raceUser = new mongoose.Types.ObjectId();
  const raceRide = await createProbeRide(raceUser);
  await conclude(raceRide._id);

  // The driver gets there first, exactly as `acceptRideService` would leave it.
  await RideModel.updateOne(
    { _id: raceRide._id },
    { rideStatus: RIDE_STATUS.ACCEPTED },
  );

  const lost = await acceptCategoryUpgrade({
    rideId: String(raceRide._id),
    userId: String(raceUser),
    io: null,
  });
  const raced = await RideModel.findById(raceRide._id);

  check("a driver beats the upgrade", lost.accepted, false);
  check("and the ride keeps its category", raced.rideType, "economy");
  check("and its original fare", raced.rideFare, 18.5);
  await RideModel.deleteOne({ _id: raceRide._id });
}

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB\n");

  try {
    await seedDrivers();
    await verifyRings();
    await verifyExhaustion();
    await verifyCategoryUpgrade();
  } finally {
    await cleanupDrivers();
    await mongoose.disconnect();
    redis.disconnect();
  }

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("verify-dispatch crashed:", error);
  process.exit(1);
});
