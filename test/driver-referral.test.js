const assert = require("node:assert/strict");
const test = require("node:test");

const {
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  computeReferralFare,
  generateReferralCode,
  isWellFormedReferralCode,
  normalizeReferralCode,
  referralBonusIdentifierKey,
  resolveFullRequestFare,
} = require("../src/feature/driver-referral/driver-referral.helper");
const {
  getDriverFare,
  getRideDriverFare,
} = require("../src/core/common/helpers/driver-fare.helper");
const {
  resolveDriverReferralConfiguration,
} = require("../src/feature/config/ride-configuration.service");
const {
  RideConfigurationModel,
} = require("../src/feature/config/model/ride-configuration.model");
const {
  updateRideConfigurationValidator,
} = require("../src/feature/admin/dto/ride-configuration.validators");
const {
  commitUpgradeAccepted,
} = require("../src/feature/ride/ride-upgrade-state.helper");
const {
  calculateCampaignDiscount,
} = require("../src/feature/promo-code/promo-code-discount.helper");
const RiderReferralModel = require("../src/feature/driver-referral/model/rider-referral.model");
const DriverModel = require("../src/feature/driver/models/driver.model");

const request = (body) => ({ body, query: {}, params: {} });

// ─── Codes ───────────────────────────────────────────────────────────────────

test("a generated code is 7 characters from the unambiguous alphabet", () => {
  for (let i = 0; i < 500; i += 1) {
    const code = generateReferralCode();

    assert.equal(code.length, REFERRAL_CODE_LENGTH);
    assert.ok(isWellFormedReferralCode(code), code);
    assert.doesNotMatch(code, /[01IO]/, "no characters people misread");
  }
});

test("code generation uses the random source it is given", () => {
  const code = generateReferralCode(() => 0);

  assert.equal(code, REFERRAL_CODE_ALPHABET[0].repeat(REFERRAL_CODE_LENGTH));
});

test("a typed code is normalised the way it is stored", () => {
  assert.equal(normalizeReferralCode(" ab3d-ef7 k "), "AB3DEF7K");
  assert.equal(normalizeReferralCode("ab3 def7"), "AB3DEF7");
  assert.equal(normalizeReferralCode(null), "");
  assert.equal(normalizeReferralCode(42), "");
});

test("malformed codes are refused before any lookup", () => {
  assert.equal(isWellFormedReferralCode("AB3DEF7"), true);
  assert.equal(isWellFormedReferralCode("AB3DEF"), false, "too short");
  assert.equal(isWellFormedReferralCode("AB3DEF78"), false, "too long");
  assert.equal(isWellFormedReferralCode("AB3DEF0"), false, "zero excluded");
  assert.equal(isWellFormedReferralCode("ab3def7"), false, "not normalised");
  assert.equal(isWellFormedReferralCode(""), false);
});

test("the driver code index is unique and sparse, so drivers without a code never collide", () => {
  const index = DriverModel.schema.path("referralCode");

  assert.equal(index.options.unique, true);
  assert.equal(index.options.sparse, true);
  assert.equal(
    new DriverModel({ email: "a@b.c" }).referralCode,
    undefined,
    "no default: a stored null would be indexed",
  );
});

test("a rider can hold only one referral, ever", () => {
  const unique = RiderReferralModel.schema
    .indexes()
    .find(([fields]) => Object.keys(fields).join() === "rider");

  assert.ok(unique, "an index on rider exists");
  assert.equal(unique[1].unique, true);
});

// ─── Money ───────────────────────────────────────────────────────────────────

test("a $100 ride with the $5 code: the rider pays 95 and the driver is paid 100", () => {
  const pricing = computeReferralFare({ fullFare: 100, discount: 5 });

  assert.deepEqual(pricing, {
    originalRideFare: 100,
    discountAmount: 5,
    rideFare: 95,
  });
  assert.equal(
    getRideDriverFare(pricing),
    100,
    "the discount is the platform's, never the driver's",
  );
});

test("a ride cheaper than the discount is free, never negative", () => {
  const pricing = computeReferralFare({ fullFare: 3.4, discount: 5 });

  assert.deepEqual(pricing, {
    originalRideFare: 3.4,
    discountAmount: 3.4,
    rideFare: 0,
  });
  assert.equal(getRideDriverFare(pricing), 3.4);
});

test("fare maths stays in whole cents", () => {
  const pricing = computeReferralFare({ fullFare: 18.555, discount: 5 });

  assert.equal(pricing.originalRideFare, 18.55);
  assert.equal(pricing.rideFare, 13.55);
});

test("a zero or junk discount leaves the fare untouched", () => {
  assert.equal(computeReferralFare({ fullFare: 20, discount: 0 }).rideFare, 20);
  assert.equal(
    computeReferralFare({ fullFare: 20, discount: "abc" }).discountAmount,
    0,
  );
  assert.equal(
    computeReferralFare({ fullFare: 20, discount: -5 }).discountAmount,
    0,
  );
});

test("the referral starts from the full fare even when the app also sent a promo", () => {
  assert.equal(
    resolveFullRequestFare({ rideFare: 16, originalRideFare: 20, codeId: "x" }),
    20,
  );
  assert.equal(resolveFullRequestFare({ rideFare: 20 }), 20);
  // An original with no code attached is not trusted over the fare itself.
  assert.equal(
    resolveFullRequestFare({ rideFare: 20, originalRideFare: 99 }),
    20,
  );
});

test("the bonus transaction key is per ride, so a ride can pay its bonus once", () => {
  assert.equal(
    referralBonusIdentifierKey("ride-1"),
    "driver_referral_bonus:ride-1",
  );
  assert.notEqual(
    referralBonusIdentifierKey("ride-1"),
    referralBonusIdentifierKey("ride-2"),
  );
});

// ─── Configuration ───────────────────────────────────────────────────────────

test("referral settings default to $5 and $5, enabled", () => {
  const configuration = new RideConfigurationModel();

  assert.deepEqual(configuration.driverReferral.toObject(), {
    enabled: true,
    riderDiscountAmount: 5,
    driverBonusAmount: 5,
  });
});

test("a configuration written before the feature falls back to the defaults", () => {
  assert.deepEqual(resolveDriverReferralConfiguration({}), {
    enabled: true,
    riderDiscountAmount: 5,
    driverBonusAmount: 5,
  });
  assert.deepEqual(resolveDriverReferralConfiguration(null), {
    enabled: true,
    riderDiscountAmount: 5,
    driverBonusAmount: 5,
  });
});

test("each stored referral setting is used, and a bad one falls back on its own", () => {
  assert.deepEqual(
    resolveDriverReferralConfiguration({
      driverReferral: {
        enabled: false,
        riderDiscountAmount: 7.5,
        driverBonusAmount: -1,
      },
    }),
    { enabled: false, riderDiscountAmount: 7.5, driverBonusAmount: 5 },
  );
});

test("the admin endpoint accepts a partial referral update", () => {
  const result = updateRideConfigurationValidator.safeParse(
    request({ driverReferral: { driverBonusAmount: 10 } }),
  );

  assert.equal(result.success, true);
});

test("the admin endpoint refuses negative, fractional-cent and unknown referral settings", () => {
  for (const driverReferral of [
    { riderDiscountAmount: -1 },
    { riderDiscountAmount: 5.001 },
    { driverBonusAmount: 1000 },
    { bonus: 5 },
    {},
  ]) {
    const result = updateRideConfigurationValidator.safeParse(
      request({ driverReferral }),
    );
    assert.equal(result.success, false, JSON.stringify(driverReferral));
  }
});

// ─── Category upgrade ────────────────────────────────────────────────────────

test("an upgraded referral ride keeps its discount and pays the driver the full new price", async () => {
  let captured;
  const FakeRideModel = {
    findOneAndUpdate: async (filter, update) => {
      captured = update;
      return { _id: filter._id };
    },
  };

  // Economy was 20 (rider paid 15). Luxury quotes 30, so the rider was offered 25.
  await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    rideFare: 25,
    fullFare: 30,
  });

  assert.equal(captured.$set.rideFare, 25);
  assert.equal(captured.$set.originalRideFare, 30);
  assert.equal(captured.$set.discountAmount, 5);
  assert.equal(captured.$unset, undefined, "nothing is dropped");
  assert.equal(
    getDriverFare(
      captured.$set.rideFare,
      captured.$set.originalRideFare,
      captured.$set.discountAmount,
    ),
    30,
  );
});

const captureUpgrade = async (options) => {
  let captured;
  const FakeRideModel = {
    findOneAndUpdate: async (filter, update) => {
      captured = update;
      return {};
    },
  };

  await commitUpgradeAccepted(FakeRideModel, "ride-1", {
    toRideType: "luxury",
    ...options,
  });

  return captured;
};

test("an upgrade with no discount never leaves the old category's price behind", async () => {
  // The ride was economy with originalRideFare 22.5; luxury is quoted at 30.
  const update = await captureUpgrade({ rideFare: 30 });

  assert.equal(update.$set.originalRideFare, 30);
  assert.equal(update.$set.discountAmount, 0);
  assert.equal(
    getDriverFare(
      update.$set.rideFare,
      update.$set.originalRideFare,
      update.$set.discountAmount,
    ),
    30,
    "the luxury driver is paid the luxury price",
  );
});

test("a kept promo code is re-priced on the upgrade and the driver is paid the full price", async () => {
  // Luxury is 30; a 20% code takes 6 off, so the rider was offered 24.
  const update = await captureUpgrade({ rideFare: 24, fullFare: 30 });

  assert.equal(update.$set.rideFare, 24);
  assert.equal(update.$set.originalRideFare, 30);
  assert.equal(update.$set.discountAmount, 6);
  assert.equal(update.$unset, undefined);
});

test("a dropped promo code still clears every promo field", async () => {
  const update = await captureUpgrade({ rideFare: 30, dropPromoCode: true });

  assert.deepEqual(update.$unset, {
    codeId: "",
    campaignId: "",
    discountAmount: "",
    originalRideFare: "",
  });
  assert.equal(update.$set.originalRideFare, undefined, "no $set/$unset clash");
  assert.equal(update.$set.discountAmount, undefined);
});

// ─── Promo campaign discount (shared by apply and upgrade) ───────────────────

test("a fixed campaign takes its amount off, never more than the fare", () => {
  const campaign = { discountType: "fixed", discountValue: 5 };

  assert.equal(calculateCampaignDiscount(campaign, 30).finalFare, 25);
  assert.equal(calculateCampaignDiscount(campaign, 3).finalFare, 0);
});

test("a percentage campaign is re-computed on the new fare and respects its cap", () => {
  const campaign = {
    discountType: "percentage",
    discountValue: 20,
    maxDiscountCap: 5,
  };

  assert.equal(calculateCampaignDiscount(campaign, 20).discountAmount, 4);
  assert.equal(calculateCampaignDiscount(campaign, 40).discountAmount, 5);
});

test("a fare under the campaign minimum gets no discount", () => {
  const campaign = {
    discountType: "fixed",
    discountValue: 5,
    minRideAmount: 25,
  };

  assert.deepEqual(calculateCampaignDiscount(campaign, 20), {
    originalFare: 20,
    discountApplied: false,
    discountAmount: 0,
    finalFare: 20,
  });
  assert.equal(calculateCampaignDiscount(campaign, 25).discountApplied, true);
});

// ─── Cancellation ────────────────────────────────────────────────────────────

const {
  REFERRAL_STATUS,
  shouldReturnReferralCode,
} = require("../src/feature/driver-referral/driver-referral.helper");

test("a ride cancelled before the rider is charged hands the code back, whoever cancels", () => {
  for (const previousStatus of ["requested", "accepted", "arrived", "coming"]) {
    assert.equal(
      shouldReturnReferralCode({ previousStatus, paymentStatus: "pending" }),
      true,
      previousStatus,
    );
  }
});

test("a ride cancelled after the charge uses the code up, so the discount is never given twice", () => {
  assert.equal(
    shouldReturnReferralCode({
      previousStatus: "in-progress",
      paymentStatus: "completed",
    }),
    false,
  );
  // Card settled but the status had not moved yet.
  assert.equal(
    shouldReturnReferralCode({
      previousStatus: "arrived",
      paymentStatus: "completed",
    }),
    false,
  );
});

test("a failed payment charged nobody, so the code goes back", () => {
  assert.equal(
    shouldReturnReferralCode({
      previousStatus: "arrived",
      paymentStatus: "failed",
    }),
    true,
  );
});

test("a used-up code is a status of its own, separate from a paid one", () => {
  assert.equal(REFERRAL_STATUS.VOIDED, "voided");
  assert.ok(
    RiderReferralModel.schema.path("status").enumValues.includes("voided"),
  );
});
