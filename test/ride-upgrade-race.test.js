const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OFFER_STATUS,
  claimUpgradeOffer,
  commitUpgradeAccepted,
  openUpgradeOffer,
  settleUpgradeOffer,
} = require("../src/feature/ride/ride-upgrade-state.helper");
const {
  makeJobId,
  makeUpgradeJobId,
} = require("../src/feature/ride/ride-dispatch.producer");

/**
 * One in-memory ride, matched the way Mongo would match it. Only the operators
 * the helper actually uses are implemented — dotted `$set`, `$inc` and `$unset`
 * — so a helper that reached for anything else would fail loudly here.
 */
class FakeRideModel {
  static reset(overrides = {}) {
    this.ride = {
      _id: "ride-1",
      user: "user-1",
      rideStatus: "requested",
      rideType: "economy",
      rideFare: 18.5,
      searchAttempt: 0,
      codeId: "code-1",
      campaignId: "campaign-1",
      discountAmount: 4,
      originalRideFare: 22.5,
      upgradeOffer: {
        status: null,
        fromRideType: null,
        toRideType: null,
        quotedFare: null,
        promoCodeDropped: false,
        offeredAt: null,
        expiresAt: null,
        decidedAt: null,
      },
      ...overrides,
    };
  }

  static read(path) {
    return path
      .split(".")
      .reduce((value, key) => (value == null ? value : value[key]), this.ride);
  }

  static write(path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((value, key) => value[key], this.ride);
    target[last] = value;
  }

  static async findOneAndUpdate(filter, update) {
    const matches = Object.entries(filter).every(
      ([path, expected]) => this.read(path) === expected,
    );
    if (!matches) return null;

    for (const [path, value] of Object.entries(update.$set ?? {})) {
      this.write(path, value);
    }
    for (const [path, amount] of Object.entries(update.$inc ?? {})) {
      this.write(path, (this.read(path) ?? 0) + amount);
    }
    for (const path of Object.keys(update.$unset ?? {})) {
      this.write(path, undefined);
    }

    return JSON.parse(JSON.stringify(this.ride));
  }
}

const offerFields = {
  fromRideType: "economy",
  toRideType: "luxury",
  quotedFare: 31.2,
  expiresAt: new Date(Date.now() + 30_000),
};

test("an offer can only be opened once", async () => {
  FakeRideModel.reset();

  const first = await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);
  const second = await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);

  assert.equal(first.upgradeOffer.status, OFFER_STATUS.OFFERED);
  assert.equal(second, null, "a retried job must not ask the rider twice");
});

test("an offer is never opened on a ride a driver already took", async () => {
  FakeRideModel.reset({ rideStatus: "accepted" });

  assert.equal(
    await openUpgradeOffer(FakeRideModel, "ride-1", offerFields),
    null,
  );
});

test("the rider's accept beats the timeout", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);

  const claimed = await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");
  const timedOut = await settleUpgradeOffer(FakeRideModel, "ride-1", {
    from: OFFER_STATUS.OFFERED,
    to: OFFER_STATUS.TIMED_OUT,
  });

  assert.ok(claimed, "the rider claimed the offer");
  assert.equal(timedOut, null, "the window cannot close on a claimed offer");
  assert.equal(FakeRideModel.ride.upgradeOffer.status, OFFER_STATUS.ACCEPTING);
});

test("the timeout beats a rider who answers too late", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);

  const timedOut = await settleUpgradeOffer(FakeRideModel, "ride-1", {
    from: OFFER_STATUS.OFFERED,
    to: OFFER_STATUS.TIMED_OUT,
  });
  const claimed = await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");

  assert.ok(timedOut);
  assert.equal(claimed, null);
});

test("a double tap claims the offer exactly once", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);

  const first = await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");
  const second = await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");

  assert.ok(first);
  assert.equal(second, null);
});

test("another rider cannot answer somebody else's offer", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);

  assert.equal(
    await claimUpgradeOffer(FakeRideModel, "ride-1", "user-2"),
    null,
  );
});

test("a committed upgrade moves to the next search generation", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);
  await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");

  const committed = await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    rideFare: 31.2,
  });

  assert.equal(committed.rideType, "luxury");
  assert.equal(committed.rideFare, 31.2);
  assert.equal(committed.searchAttempt, 1);
  assert.equal(committed.upgradeOffer.status, OFFER_STATUS.ACCEPTED);
});

test("a promo code that does not survive the category is dropped on commit", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);
  await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");

  await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    rideFare: 31.2,
    dropPromoCode: true,
  });

  assert.equal(FakeRideModel.ride.codeId, undefined);
  assert.equal(FakeRideModel.ride.campaignId, undefined);
  assert.equal(FakeRideModel.ride.discountAmount, undefined);
});

test("a kept promo code is left alone on commit", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);
  await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");

  await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    rideFare: 31.2,
  });

  assert.equal(FakeRideModel.ride.codeId, "code-1");
});

test("a driver who accepts during the window beats the upgrade", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);
  await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");

  // The driver wins the ride while the rider's card is being checked.
  FakeRideModel.ride.rideStatus = "accepted";

  const committed = await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    rideFare: 31.2,
  });

  assert.equal(committed, null, "an assigned ride must not change category");
  assert.equal(FakeRideModel.ride.rideType, "economy");
  assert.equal(FakeRideModel.ride.rideFare, 18.5);
  assert.equal(FakeRideModel.ride.searchAttempt, 0);
});

test("a ride that already upgraded is never offered another upgrade", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);
  await claimUpgradeOffer(FakeRideModel, "ride-1", "user-1");
  await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    rideFare: 31.2,
  });

  const again = await openUpgradeOffer(FakeRideModel, "ride-1", {
    ...offerFields,
    fromRideType: "luxury",
  });

  assert.equal(again, null);
});

test("an offer settles only once, whichever outcome gets there first", async () => {
  FakeRideModel.reset();
  await openUpgradeOffer(FakeRideModel, "ride-1", offerFields);

  const declined = await settleUpgradeOffer(FakeRideModel, "ride-1", {
    from: OFFER_STATUS.OFFERED,
    to: OFFER_STATUS.DECLINED,
  });
  const superseded = await settleUpgradeOffer(FakeRideModel, "ride-1", {
    from: OFFER_STATUS.OFFERED,
    to: OFFER_STATUS.SUPERSEDED,
  });

  assert.equal(declined.upgradeOffer.status, OFFER_STATUS.DECLINED);
  assert.equal(superseded, null);
});

test("ring job ids never collide across search generations", () => {
  const first = makeJobId("ride-1", 0);
  const second = makeJobId("ride-1", 0, 1);

  assert.notEqual(
    first,
    second,
    "a second search must not reuse a completed job id, or it is silently dropped",
  );
  assert.equal(first, "dispatch-ride-1-0", "generation 0 keeps the legacy id");
  assert.equal(makeJobId("ride-1", 3), makeJobId("ride-1", 3, 0));
});

test("an upgrade job id is distinct from every ring job id", () => {
  const upgradeId = makeUpgradeJobId("ride-1", 1);
  const ringIds = Array.from({ length: 8 }, (_, ring) => [
    makeJobId("ride-1", ring, 0),
    makeJobId("ride-1", ring, 1),
  ]).flat();

  assert.ok(!ringIds.includes(upgradeId));
  assert.notEqual(makeUpgradeJobId("ride-1", 0), makeUpgradeJobId("ride-1", 1));
});
