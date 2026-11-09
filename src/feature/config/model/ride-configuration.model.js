const mongoose = require("mongoose");
const {
  DEFAULT_NEARBY_RADIUS_MILES,
  DEFAULT_DISPATCH_RADIUS_LADDER_MILES,
  DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS,
  DEFAULT_DISTANCE_UNIT,
  DISTANCE_UNITS,
  SUPPORTED_LOCALES,
  DEFAULT_CATEGORY_UPGRADE_MAP,
  DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS,
  MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
  MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
  DEFAULT_DRIVER_REFERRAL_ENABLED,
  DEFAULT_DRIVER_REFERRAL_RIDER_DISCOUNT,
  DEFAULT_DRIVER_REFERRAL_DRIVER_BONUS,
  MAX_DRIVER_REFERRAL_AMOUNT,
} = require("../../../core/common/constants/ride-constants");
const {
  DEFAULT_CARPOOL_MATCH_RADIUS_MILES,
} = require("../../../core/common/constants/carpool-constants");

const RIDE_CONFIGURATION_KEY = "ride-distances";

// One message in every locale the apps are served in. A locale left empty falls
// back to the shipped translation, so a half-filled override is safe.
const localizedMessageSchema = new mongoose.Schema(
  Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [locale, { type: String, trim: true }]),
  ),
  { _id: false },
);

// A driver's code shared with riders. Amounts are dollars. They are copied onto
// each referral when it is attached to a ride, so editing them here never
// changes what a ride already in flight pays out.
const driverReferralSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: DEFAULT_DRIVER_REFERRAL_ENABLED,
    },
    riderDiscountAmount: {
      type: Number,
      min: 0,
      max: MAX_DRIVER_REFERRAL_AMOUNT,
      default: DEFAULT_DRIVER_REFERRAL_RIDER_DISCOUNT,
    },
    driverBonusAmount: {
      type: Number,
      min: 0,
      max: MAX_DRIVER_REFERRAL_AMOUNT,
      default: DEFAULT_DRIVER_REFERRAL_DRIVER_BONUS,
    },
  },
  { _id: false },
);

const rideConfigurationSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: RIDE_CONFIGURATION_KEY,
      immutable: true,
      unique: true,
      select: false,
    },
    nearbyRadius: {
      type: Number,
      required: true,
      min: 0.01,
      default: DEFAULT_NEARBY_RADIUS_MILES,
    },
    carpoolNearbyRadius: {
      type: Number,
      required: true,
      min: 0.01,
      default: DEFAULT_CARPOOL_MATCH_RADIUS_MILES,
    },
    // Ascending radii in miles. The dispatcher opens one ring at a time and
    // stops as soon as a driver accepts, so the winner is the closest responder.
    dispatchRadiusLadderMiles: {
      type: [Number],
      required: true,
      default: () => [...DEFAULT_DISPATCH_RADIUS_LADDER_MILES],
    },
    // How long a ring stays open before the next, wider one is added.
    dispatchRingTimeoutSeconds: {
      type: Number,
      required: true,
      min: 3,
      max: 60,
      default: DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS,
    },
    // What the apps print next to a distance. Display only: the ladder is stored
    // and reasoned about in miles whatever this says.
    distanceUnit: {
      type: String,
      required: true,
      enum: DISTANCE_UNITS,
      default: DEFAULT_DISTANCE_UNIT,
    },
    // How long the rider has to answer before the request dies anyway.
    categoryUpgradeDecisionSeconds: {
      type: Number,
      required: true,
      min: MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
      max: MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
      default: DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS,
    },
    // Source category -> the category offered in its place. Both sides must be
    // dispatchable, or the new search would never reach the ladder.
    categoryUpgradeMap: {
      type: Map,
      of: String,
      default: () => new Map(Object.entries(DEFAULT_CATEGORY_UPGRADE_MAP)),
    },
    // Overrides for the copy the apps show while a ride is being dispatched.
    // Empty means "use the shipped translation", which is how this starts and
    // how it stays until somebody edits a message from the panel.
    appMessages: {
      type: Map,
      of: localizedMessageSchema,
      default: () => new Map(),
    },
    driverReferral: {
      type: driverReferralSchema,
      default: () => ({}),
    },
  },
  { timestamps: true },
);

const RideConfigurationModel =
  mongoose.models.RideConfiguration ||
  mongoose.model("RideConfiguration", rideConfigurationSchema);

module.exports = {
  RIDE_CONFIGURATION_KEY,
  RideConfigurationModel,
};
