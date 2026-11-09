const {
  RIDE_CONFIGURATION_KEY,
  RideConfigurationModel,
} = require("./model/ride-configuration.model");
const {
  DEFAULT_NEARBY_RADIUS_MILES,
  DEFAULT_DISPATCH_RADIUS_LADDER_MILES,
  DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS,
  DEFAULT_DISTANCE_UNIT,
  DISTANCE_UNITS,
  SUPPORTED_LOCALES,
  CONFIGURABLE_APP_MESSAGE_KEYS,
  MAX_DISPATCH_RADIUS_MILES,
  MAX_DISPATCH_RINGS,
  DISPATCHABLE_CATEGORIES,
  DEFAULT_CATEGORY_UPGRADE_MAP,
  DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS,
  MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
  MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
  DEFAULT_DRIVER_REFERRAL_ENABLED,
  DEFAULT_DRIVER_REFERRAL_RIDER_DISCOUNT,
  DEFAULT_DRIVER_REFERRAL_DRIVER_BONUS,
  MAX_DRIVER_REFERRAL_AMOUNT,
} = require("../../core/common/constants/ride-constants");
const {
  DEFAULT_CARPOOL_MATCH_RADIUS_MILES,
} = require("../../core/common/constants/carpool-constants");
const { t } = require("../../core/common/helpers");

const METERS_PER_MILE = 1609.344;
const KILOMETERS_PER_MILE = 1.609344;

// The projection is explicit, so a field missing from this list reads back as
// `undefined` everywhere — add new settings here as well as to the schema.
const CONFIGURATION_FIELDS =
  "_id nearbyRadius carpoolNearbyRadius dispatchRadiusLadderMiles dispatchRingTimeoutSeconds distanceUnit categoryUpgradeDecisionSeconds categoryUpgradeMap appMessages driverReferral createdAt updatedAt";

function isUsableReferralAmount(amount) {
  return (
    Number.isFinite(amount) &&
    amount >= 0 &&
    amount <= MAX_DRIVER_REFERRAL_AMOUNT
  );
}

/**
 * The driver-referral settings with every field filled in. A document written
 * before the feature existed has no `driverReferral` at all, and a hand-edited
 * one may carry junk; either way each field falls back to its shipped default
 * on its own, so one bad value never switches the others off.
 */
function resolveDriverReferralConfiguration(configuration) {
  const stored = configuration?.driverReferral ?? {};

  return {
    enabled:
      typeof stored.enabled === "boolean"
        ? stored.enabled
        : DEFAULT_DRIVER_REFERRAL_ENABLED,
    riderDiscountAmount: isUsableReferralAmount(stored.riderDiscountAmount)
      ? stored.riderDiscountAmount
      : DEFAULT_DRIVER_REFERRAL_RIDER_DISCOUNT,
    driverBonusAmount: isUsableReferralAmount(stored.driverBonusAmount)
      ? stored.driverBonusAmount
      : DEFAULT_DRIVER_REFERRAL_DRIVER_BONUS,
  };
}

/**
 * A ladder is only usable if it is a non-empty ascending list of positive radii
 * that stays inside the reach cap. Anything else (a legacy document written
 * before this field existed, a hand-edited record) falls back to the default
 * rather than sending drivers an unbounded distance away.
 */
function isUsableDispatchLadder(ladder) {
  if (!Array.isArray(ladder) || ladder.length === 0) return false;
  if (ladder.length > MAX_DISPATCH_RINGS) return false;

  return ladder.every(
    (radius, index) =>
      Number.isFinite(radius) &&
      radius >= 0.01 &&
      radius <= MAX_DISPATCH_RADIUS_MILES &&
      (index === 0 || radius > ladder[index - 1]),
  );
}

/**
 * A Map from a live document and a plain object from a `.lean()` read are both
 * valid shapes for the upgrade map, so both are turned into plain entries
 * rather than assuming either.
 */
function toPlainMap(value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value };
  }
  return null;
}

/**
 * An upgrade map is only usable if every entry points one dispatchable category
 * at a *different* dispatchable one. A self-loop would search the same category
 * twice; a carpool target would restart into a category the ladder never
 * serves. Either way the fallback is the shipped default, not a broken search.
 */
function isUsableCategoryUpgradeMap(map) {
  const entries = toPlainMap(map);
  if (!entries) return false;

  const pairs = Object.entries(entries);
  if (pairs.length === 0) return false;

  return pairs.every(
    ([from, to]) =>
      DISPATCHABLE_CATEGORIES.includes(from) &&
      DISPATCHABLE_CATEGORIES.includes(to) &&
      from !== to,
  );
}

/**
 * Read the override stored for one message and locale, if there is one.
 *
 * Overrides arrive as a Map from a live document and as a plain object from a
 * `.lean()` read, so both are handled rather than assuming either.
 */
function readStoredMessage(appMessages, key, locale) {
  if (!appMessages) return null;

  const entry =
    typeof appMessages.get === "function"
      ? appMessages.get(key)
      : appMessages[key];

  if (!entry) return null;

  const stored =
    typeof entry.get === "function" ? entry.get(locale) : entry[locale];
  const text = typeof stored === "string" ? stored.trim() : "";

  return text || null;
}

/**
 * Fill `{{placeholders}}` in a message. Anything the caller did not supply is
 * left untouched: a visible `{{radius}}` on screen is a bug somebody will
 * report, while a silent blank is one nobody notices.
 */
function interpolate(text, values = {}) {
  if (typeof text !== "string") return text;

  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name) =>
    values[name] === undefined || values[name] === null
      ? match
      : String(values[name]),
  );
}

/**
 * The text the apps show for one message, in one locale.
 *
 * Order: the admin's override, then the shipped translation. That fallback is
 * what makes the panel safe to use — an override that is deleted, blank, or
 * never written for a locale simply reverts to what the release contains.
 */
function resolveAppMessage(configuration, key, locale, values) {
  const language = SUPPORTED_LOCALES.includes(locale) ? locale : "en";
  const stored = readStoredMessage(configuration?.appMessages, key, language);

  return interpolate(stored ?? t(key, language), values);
}

/**
 * Every configurable message resolved for one locale — the catalogue the apps
 * download once and render by key.
 */
function resolveAppMessages(configuration, locale) {
  return Object.fromEntries(
    CONFIGURABLE_APP_MESSAGE_KEYS.map((key) => [
      key,
      resolveAppMessage(configuration, key, locale),
    ]),
  );
}

function milesToMeters(miles) {
  return miles * METERS_PER_MILE;
}

function milesToKilometers(miles) {
  return miles * KILOMETERS_PER_MILE;
}

async function getRideDistanceConfiguration() {
  const configuration = await RideConfigurationModel.findOneAndUpdate(
    { key: RIDE_CONFIGURATION_KEY },
    { $setOnInsert: { key: RIDE_CONFIGURATION_KEY } },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  )
    .select(CONFIGURATION_FIELDS)
    .lean();

  const missingDefaults = {};

  if (!Number.isFinite(configuration.nearbyRadius)) {
    missingDefaults.nearbyRadius = DEFAULT_NEARBY_RADIUS_MILES;
  }
  if (!Number.isFinite(configuration.carpoolNearbyRadius)) {
    missingDefaults.carpoolNearbyRadius = DEFAULT_CARPOOL_MATCH_RADIUS_MILES;
  }
  if (!isUsableDispatchLadder(configuration.dispatchRadiusLadderMiles)) {
    missingDefaults.dispatchRadiusLadderMiles = [
      ...DEFAULT_DISPATCH_RADIUS_LADDER_MILES,
    ];
  }
  if (!Number.isFinite(configuration.dispatchRingTimeoutSeconds)) {
    missingDefaults.dispatchRingTimeoutSeconds =
      DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS;
  }
  if (!DISTANCE_UNITS.includes(configuration.distanceUnit)) {
    missingDefaults.distanceUnit = DEFAULT_DISTANCE_UNIT;
  }
  if (!Number.isFinite(configuration.categoryUpgradeDecisionSeconds)) {
    missingDefaults.categoryUpgradeDecisionSeconds =
      DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS;
  }
  if (!isUsableCategoryUpgradeMap(configuration.categoryUpgradeMap)) {
    missingDefaults.categoryUpgradeMap = { ...DEFAULT_CATEGORY_UPGRADE_MAP };
  }

  if (Object.keys(missingDefaults).length === 0) {
    return configuration;
  }

  return RideConfigurationModel.findOneAndUpdate(
    { key: RIDE_CONFIGURATION_KEY },
    { $set: missingDefaults },
    { new: true, runValidators: true },
  )
    .select(CONFIGURATION_FIELDS)
    .lean();
}

async function updateRideDistanceConfiguration(updates) {
  const distanceUpdates = {};

  if (Number.isFinite(updates.nearbyRadius)) {
    distanceUpdates.nearbyRadius = updates.nearbyRadius;
  }
  if (Number.isFinite(updates.carpoolNearbyRadius)) {
    distanceUpdates.carpoolNearbyRadius = updates.carpoolNearbyRadius;
  }
  if (isUsableDispatchLadder(updates.dispatchRadiusLadderMiles)) {
    distanceUpdates.dispatchRadiusLadderMiles = [
      ...updates.dispatchRadiusLadderMiles,
    ];
  }
  if (Number.isFinite(updates.dispatchRingTimeoutSeconds)) {
    distanceUpdates.dispatchRingTimeoutSeconds =
      updates.dispatchRingTimeoutSeconds;
  }
  if (DISTANCE_UNITS.includes(updates.distanceUnit)) {
    distanceUpdates.distanceUnit = updates.distanceUnit;
  }
  if (Number.isFinite(updates.categoryUpgradeDecisionSeconds)) {
    distanceUpdates.categoryUpgradeDecisionSeconds =
      updates.categoryUpgradeDecisionSeconds;
  }
  // Written whole, not dotted-path merged like `appMessages`: the map is small,
  // read as a unit, and a partial merge would leave orphan entries behind.
  if (isUsableCategoryUpgradeMap(updates.categoryUpgradeMap)) {
    distanceUpdates.categoryUpgradeMap = toPlainMap(updates.categoryUpgradeMap);
  }

  // Merged field by field, so the panel can change the bonus without resending
  // the discount or the switch.
  if (updates.driverReferral && typeof updates.driverReferral === "object") {
    const { enabled, riderDiscountAmount, driverBonusAmount } =
      updates.driverReferral;

    if (typeof enabled === "boolean") {
      distanceUpdates["driverReferral.enabled"] = enabled;
    }
    if (isUsableReferralAmount(riderDiscountAmount)) {
      distanceUpdates["driverReferral.riderDiscountAmount"] =
        riderDiscountAmount;
    }
    if (isUsableReferralAmount(driverBonusAmount)) {
      distanceUpdates["driverReferral.driverBonusAmount"] = driverBonusAmount;
    }
  }

  // Messages are merged one key at a time, never wholesale: editing the search
  // copy from the panel must not silently drop every other override.
  if (updates.appMessages && typeof updates.appMessages === "object") {
    for (const [key, translations] of Object.entries(updates.appMessages)) {
      if (!CONFIGURABLE_APP_MESSAGE_KEYS.includes(key)) continue;
      if (!translations || typeof translations !== "object") continue;

      for (const locale of SUPPORTED_LOCALES) {
        const text = translations[locale];
        if (text === undefined) continue;

        // An empty string is how the panel clears an override and goes back to
        // the shipped translation, so it is stored as an empty value, not
        // rejected.
        distanceUpdates[`appMessages.${key}.${locale}`] =
          typeof text === "string" ? text.trim() : "";
      }
    }
  }

  return RideConfigurationModel.findOneAndUpdate(
    { key: RIDE_CONFIGURATION_KEY },
    {
      $set: distanceUpdates,
      $setOnInsert: { key: RIDE_CONFIGURATION_KEY },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  )
    .select(CONFIGURATION_FIELDS)
    .lean();
}

async function getRideDistanceConfigurationForRuntime() {
  const configuration = await getRideDistanceConfiguration();

  const ladderMiles = configuration.dispatchRadiusLadderMiles;

  return {
    maxRideDistanceMeters: milesToMeters(configuration.nearbyRadius),
    nearbyDriverDistanceLimitKilometers: milesToKilometers(
      configuration.nearbyRadius,
    ),
    carpoolMatchRadiusMeters: milesToMeters(configuration.carpoolNearbyRadius),
    // Miles for anything the rider sees, kilometres for GEOSEARCH.
    dispatchLadderMiles: ladderMiles,
    dispatchLadderKilometers: ladderMiles.map(milesToKilometers),
    dispatchRingTimeoutSeconds: configuration.dispatchRingTimeoutSeconds,
    distanceUnit: configuration.distanceUnit,
    // Which category an exhausted search is offered in its place, and how long
    // the rider has to answer. A category with no mapping is simply never
    // offered one, which is the only way this is limited.
    categoryUpgrade: {
      decisionSeconds: configuration.categoryUpgradeDecisionSeconds,
      map: toPlainMap(configuration.categoryUpgradeMap) ?? {},
    },
    // Handed back so a caller that needs a message can resolve it without a
    // second trip to the database.
    configuration,
  };
}

/**
 * A distance in whatever unit the apps are currently set to display, rounded
 * the way a person reads it rather than the way a float stores it.
 */
function toDisplayDistance(miles, unit = DEFAULT_DISTANCE_UNIT) {
  // A missing distance is a caller's bug, but it must not throw inside the
  // sentence a rider is waiting on — the ride would already have been closed by
  // then, and nobody would ever be told.
  if (!Number.isFinite(miles)) return null;

  const value = unit === "km" ? milesToKilometers(miles) : miles;

  return Number(value.toFixed(1));
}

/**
 * Everything the apps need to render a dispatch without a single number or
 * sentence compiled into the build: the ladder, its timings, the unit and the
 * copy. Changing a ring in the panel changes the apps on their next read.
 */
async function getAppRideConfiguration(locale = "en") {
  const configuration = await getRideDistanceConfiguration();
  const unit = configuration.distanceUnit;
  const ladderMiles = configuration.dispatchRadiusLadderMiles;

  return {
    locale: SUPPORTED_LOCALES.includes(locale) ? locale : "en",
    distanceUnit: unit,
    dispatch: {
      totalRings: ladderMiles.length,
      ringTimeoutSeconds: configuration.dispatchRingTimeoutSeconds,
      // What a ring covers, already converted for display. `radiusMiles` stays
      // alongside it because that is the number every backend event carries.
      rings: ladderMiles.map((radiusMiles, index) => ({
        ring: index + 1,
        radiusMiles,
        radius: toDisplayDistance(radiusMiles, unit),
      })),
      // How long the rider may be kept waiting before the search gives up.
      maxSearchSeconds:
        ladderMiles.length * configuration.dispatchRingTimeoutSeconds,
      // The same number once an upgrade is in play: the first search, the time
      // the rider has to answer, and the second search that follows. Apps size
      // their waiting UI from this so it doesn't finish before the search does.
      maxSearchSecondsWithUpgrade:
        ladderMiles.length * configuration.dispatchRingTimeoutSeconds * 2 +
        configuration.categoryUpgradeDecisionSeconds,
      categoryUpgrade: {
        // Always true. The field stays in the payload because the apps gate
        // their upgrade UI on it, and removing it would read as `undefined` —
        // silently switching the feature off in every build that checks it.
        enabled: true,
        decisionSeconds: configuration.categoryUpgradeDecisionSeconds,
        map: toPlainMap(configuration.categoryUpgradeMap) ?? {},
      },
    },
    messages: resolveAppMessages(configuration, locale),
    updatedAt: configuration.updatedAt,
  };
}

/**
 * One configurable message, ready to send. For callers that hold no
 * configuration of their own — a socket handler answering a single request —
 * and would otherwise reach for `t()` and hard-code what the panel can change.
 */
async function getAppMessage(key, locale = "en", values) {
  const configuration = await getRideDistanceConfiguration();

  return resolveAppMessage(configuration, key, locale, values);
}

/**
 * The live driver-referral settings: whether codes can be used, what the rider
 * saves and what the code's owner earns.
 */
async function getDriverReferralConfiguration() {
  const configuration = await getRideDistanceConfiguration();

  return resolveDriverReferralConfiguration(configuration);
}

module.exports = {
  getAppMessage,
  getDriverReferralConfiguration,
  resolveDriverReferralConfiguration,
  getAppRideConfiguration,
  getRideDistanceConfiguration,
  getRideDistanceConfigurationForRuntime,
  isUsableCategoryUpgradeMap,
  isUsableDispatchLadder,
  interpolate,
  milesToKilometers,
  milesToMeters,
  resolveAppMessage,
  resolveAppMessages,
  toDisplayDistance,
  updateRideDistanceConfiguration,
};
