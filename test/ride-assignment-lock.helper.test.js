const assert = require("node:assert/strict");
const test = require("node:test");

const {
  claimRideForDriver,
  releaseRideForDriverClaim,
} = require("../src/feature/ride/ride-assignment-lock.helper");

class FakeRedis {
  constructor() {
    this.values = new Map();
  }

  async set(key, value, ...options) {
    if (options.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, String(value));
    return "OK";
  }

  async eval(_script, _numberOfKeys, key, expectedValue) {
    if (this.values.get(key) !== String(expectedValue)) return 0;
    this.values.delete(key);
    return 1;
  }
}

test("only one ride can atomically claim a driver", async () => {
  const redis = new FakeRedis();

  const claims = await Promise.all([
    claimRideForDriver(redis, { rideId: "ride-a", driverId: "driver-1" }),
    claimRideForDriver(redis, { rideId: "ride-b", driverId: "driver-1" }),
  ]);

  const winners = claims.filter((claim) => claim.acquired);
  const losers = claims.filter((claim) => !claim.acquired);

  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].reason, "DRIVER_ALREADY_ON_RIDE");
  assert.equal(
    redis.values.get("driver:driver-1:ride:active"),
    winners[0].rideId,
  );
  assert.equal(redis.values.has(losers[0].rideLockKey), false);
});

test("a failed assignment releases only the claims it still owns", async () => {
  const redis = new FakeRedis();
  const claim = await claimRideForDriver(redis, {
    rideId: "ride-a",
    driverId: "driver-1",
  });

  redis.values.set(claim.rideLockKey, "a-new-lock-owner");
  await releaseRideForDriverClaim(redis, claim);

  assert.equal(redis.values.get(claim.rideLockKey), "a-new-lock-owner");
  assert.equal(redis.values.has(claim.driverActiveKey), false);
});

test("a driver claim remains available as the active ride after success", async () => {
  const redis = new FakeRedis();
  const claim = await claimRideForDriver(redis, {
    rideId: "ride-a",
    driverId: "driver-1",
  });

  assert.equal(claim.acquired, true);
  assert.equal(redis.values.get(claim.driverActiveKey), "ride-a");

  const duplicate = await claimRideForDriver(redis, {
    rideId: "ride-b",
    driverId: "driver-1",
  });
  assert.deepEqual(
    { acquired: duplicate.acquired, reason: duplicate.reason },
    { acquired: false, reason: "DRIVER_ALREADY_ON_RIDE" },
  );
});
