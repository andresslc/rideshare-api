const assert = require("node:assert/strict");
const test = require("node:test");

const {
  acquireAssignmentLock,
  releaseAssignmentLock,
} = require("../src/feature/ride/assignment-lock.helper");
const {
  acceptPendingOffer,
  cancelPendingOffersForDriver,
  rejectPendingOffer,
} = require("../src/feature/ride/ride-offer-state.helper");

class FakeRedis {
  constructor() {
    this.values = new Map();
  }

  async set(key, value, ...options) {
    if (options.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, String(value));
    return "OK";
  }

  async eval(_script, _keyCount, key, expectedOwner) {
    if (this.values.get(key) !== expectedOwner) return 0;
    this.values.delete(key);
    return 1;
  }
}

class FakeRideOfferModel {
  static reset() {
    this.offer = {
      _id: "offer-1",
      driver: "driver-1",
      status: "pending",
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  static async findOneAndUpdate(filter, update) {
    const offer = this.offer;
    const isMatch =
      offer._id === filter._id &&
      offer.status === filter.status &&
      (!filter.expiresAt?.$gt || offer.expiresAt > filter.expiresAt.$gt);

    if (!isMatch) return null;
    Object.assign(offer, update.$set);
    return { ...offer };
  }

  static async updateMany(filter, update) {
    const isMatch =
      this.offer.driver === filter.driver &&
      this.offer.status === filter.status;
    if (!isMatch) return { modifiedCount: 0 };
    Object.assign(this.offer, update.$set);
    return { modifiedCount: 1 };
  }
}

test("cancellation wins when it changes a pending offer first", async () => {
  FakeRideOfferModel.reset();

  const [cancellation, acceptance] = await Promise.all([
    cancelPendingOffersForDriver(FakeRideOfferModel, "driver-1"),
    acceptPendingOffer(FakeRideOfferModel, "offer-1"),
  ]);

  assert.equal(cancellation.modifiedCount, 1);
  assert.equal(acceptance, null);
  assert.equal(FakeRideOfferModel.offer.status, "canceled");
});

test("cancellation cannot overwrite an offer that acceptance claimed first", async () => {
  FakeRideOfferModel.reset();

  const [acceptance, cancellation] = await Promise.all([
    acceptPendingOffer(FakeRideOfferModel, "offer-1"),
    cancelPendingOffersForDriver(FakeRideOfferModel, "driver-1"),
  ]);

  assert.equal(acceptance.status, "accepted");
  assert.equal(cancellation.modifiedCount, 0);
  assert.equal(FakeRideOfferModel.offer.status, "accepted");
});

test("reject and accept are mutually exclusive state transitions", async () => {
  FakeRideOfferModel.reset();

  const [rejection, acceptance] = await Promise.all([
    rejectPendingOffer(FakeRideOfferModel, "offer-1"),
    acceptPendingOffer(FakeRideOfferModel, "offer-1"),
  ]);

  assert.equal(rejection.status, "rejected");
  assert.equal(acceptance, null);
});

test("driver assignment operations are serialized and locks are owner-safe", async () => {
  const redis = new FakeRedis();
  const first = await acquireAssignmentLock(redis, "driver-1", {
    waitMilliseconds: 0,
  });
  const competing = await acquireAssignmentLock(redis, "driver-1", {
    waitMilliseconds: 0,
  });

  assert.ok(first);
  assert.equal(competing, null);

  redis.values.set(first.key, "new-owner");
  await releaseAssignmentLock(redis, first);
  assert.equal(redis.values.get(first.key), "new-owner");
});
