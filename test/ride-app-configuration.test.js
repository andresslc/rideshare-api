const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONFIGURABLE_APP_MESSAGES,
  CONFIGURABLE_APP_MESSAGE_KEYS,
  DISPATCHABLE_CATEGORIES,
  DISTANCE_UNITS,
  SUPPORTED_LOCALES,
  DEFAULT_CATEGORY_UPGRADE_MAP,
  DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS,
  MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
  MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
} = require("../src/core/common/constants/ride-constants");
const {
  updateRideConfigurationValidator,
} = require("../src/feature/admin/dto/ride-configuration.validators");
const {
  RideConfigurationModel,
} = require("../src/feature/config/model/ride-configuration.model");
const {
  interpolate,
  isUsableCategoryUpgradeMap,
  resolveAppMessage,
  resolveAppMessages,
  toDisplayDistance,
} = require("../src/feature/config/ride-configuration.service");

const enMessages = require("../src/core/common/locales/en.json");
const esMessages = require("../src/core/common/locales/es.json");

const asRequest = (body) => ({ body, query: {}, params: {} });

test("a new configuration prints distances in miles", () => {
  const configuration = new RideConfigurationModel();

  assert.equal(configuration.distanceUnit, "mi");
  assert.equal(configuration.appMessages.size, 0);
});

test("every configurable message ships with a translation in each locale", () => {
  const catalogues = { en: enMessages, es: esMessages };

  for (const key of CONFIGURABLE_APP_MESSAGE_KEYS) {
    for (const locale of SUPPORTED_LOCALES) {
      assert.ok(
        catalogues[locale][key],
        `${key} has no ${locale} fallback, so clearing its override would leave a blank screen`,
      );
    }
  }
});

test("a message with no override falls back to the shipped translation", () => {
  assert.equal(
    resolveAppMessage(null, "RIDE_SEARCH_EXHAUSTED", "es"),
    esMessages.RIDE_SEARCH_EXHAUSTED,
  );

  // A blank override is how the panel reverts one, so it must not win.
  assert.equal(
    resolveAppMessage(
      { appMessages: { RIDE_SEARCH_EXHAUSTED: { es: "   " } } },
      "RIDE_SEARCH_EXHAUSTED",
      "es",
    ),
    esMessages.RIDE_SEARCH_EXHAUSTED,
  );
});

test("an override replaces the shipped translation for that locale only", () => {
  const configuration = {
    appMessages: { RIDE_SEARCH_EXHAUSTED: { es: "Nadie cerca ahora mismo." } },
  };

  assert.equal(
    resolveAppMessage(configuration, "RIDE_SEARCH_EXHAUSTED", "es"),
    "Nadie cerca ahora mismo.",
  );
  assert.equal(
    resolveAppMessage(configuration, "RIDE_SEARCH_EXHAUSTED", "en"),
    enMessages.RIDE_SEARCH_EXHAUSTED,
  );
});

test("an unknown locale is served in English rather than blank", () => {
  assert.equal(
    resolveAppMessage(null, "RIDE_SEARCH_EXHAUSTED", "pt"),
    enMessages.RIDE_SEARCH_EXHAUSTED,
  );
});

test("overrides stored as a Map are read like plain objects", () => {
  const configuration = {
    appMessages: new Map([
      ["RIDE_SEARCH_EXHAUSTED", new Map([["es", "Desde un Map."]])],
    ]),
  };

  assert.equal(
    resolveAppMessage(configuration, "RIDE_SEARCH_EXHAUSTED", "es"),
    "Desde un Map.",
  );
});

test("placeholders are filled, and unknown ones are left alone", () => {
  assert.equal(
    interpolate("{{ring}} of {{totalRings}} — {{radius}} {{unit}}", {
      ring: 2,
      totalRings: 4,
      radius: 2,
      unit: "mi",
    }),
    "2 of 4 — 2 mi",
  );

  assert.equal(interpolate("within {{radius}}", {}), "within {{radius}}");
});

test("the catalogue answers with every key the apps render", () => {
  const catalogue = resolveAppMessages(null, "en");

  assert.deepEqual(
    Object.keys(catalogue).sort(),
    [...CONFIGURABLE_APP_MESSAGE_KEYS].sort(),
  );
  assert.ok(Object.values(catalogue).every((text) => text.length > 0));
});

test("a distance is converted only for display", () => {
  assert.equal(toDisplayDistance(3, "mi"), 3);
  assert.equal(toDisplayDistance(3, "km"), 4.8);
  assert.equal(toDisplayDistance(1, "km"), 1.6);
});

test("the panel may change the unit, but only to a real one", () => {
  for (const unit of DISTANCE_UNITS) {
    assert.equal(
      updateRideConfigurationValidator.safeParse(
        asRequest({ distanceUnit: unit }),
      ).success,
      true,
    );
  }

  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({ distanceUnit: "leagues" }),
    ).success,
    false,
  );
});

test("the panel may only edit messages the apps know how to show", () => {
  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({ appMessages: { RIDE_SEARCH_EXHAUSTED: { es: "Nadie." } } }),
    ).success,
    true,
  );

  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({ appMessages: { SOMETHING_ELSE: { es: "Nadie." } } }),
    ).success,
    false,
  );
});

test("a mistyped placeholder is rejected before it reaches a rider", () => {
  const result = updateRideConfigurationValidator.safeParse(
    asRequest({
      appMessages: { RIDE_SEARCH_IN_PROGRESS: { es: "A {{radious}} de ti" } },
    }),
  );

  assert.equal(result.success, false);
  assert.match(result.error.issues[0].message, /radious/);
});

test("each message declares the placeholders it accepts", () => {
  for (const key of CONFIGURABLE_APP_MESSAGE_KEYS) {
    assert.ok(Array.isArray(CONFIGURABLE_APP_MESSAGES[key]));
  }

  // The shipped translations must only use placeholders their key declares,
  // or the fallback would render them literally.
  for (const [key, allowed] of Object.entries(CONFIGURABLE_APP_MESSAGES)) {
    for (const catalogue of [enMessages, esMessages]) {
      const used = [...catalogue[key].matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
        (match) => match[1],
      );

      for (const name of used) {
        assert.ok(
          allowed.includes(name),
          `${key} uses {{${name}}}, which it does not declare`,
        );
      }
    }
  }
});

test("the category upgrade has no on/off switch to forget", () => {
  const configuration = new RideConfigurationModel();

  // There is deliberately no `categoryUpgradeEnabled`. The upgrade is always
  // offered where a mapping exists, so nothing has to be turned on per
  // environment — and nothing can be left off by accident.
  assert.equal(configuration.categoryUpgradeEnabled, undefined);
  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({ categoryUpgradeEnabled: true }),
    ).success,
    false,
    "the panel cannot set a switch that no longer exists",
  );
  assert.equal(
    configuration.categoryUpgradeDecisionSeconds,
    DEFAULT_CATEGORY_UPGRADE_DECISION_SECONDS,
  );
  assert.deepEqual(
    Object.fromEntries(configuration.categoryUpgradeMap),
    DEFAULT_CATEGORY_UPGRADE_MAP,
  );
  assert.equal(configuration.validateSync(), undefined);
});

test("an upgrade map must point one dispatchable category at another", () => {
  assert.equal(isUsableCategoryUpgradeMap({ economy: "luxury" }), true);
  assert.equal(
    isUsableCategoryUpgradeMap(new Map([["economy", "luxury"]])),
    true,
  );

  // A self-loop would search the same category twice; a carpool target would
  // restart into a category the ring ladder never serves.
  assert.equal(isUsableCategoryUpgradeMap({ economy: "economy" }), false);
  assert.equal(isUsableCategoryUpgradeMap({ economy: "carpool" }), false);
  assert.equal(isUsableCategoryUpgradeMap({ carpool: "luxury" }), false);
  assert.equal(isUsableCategoryUpgradeMap({}), false);
  assert.equal(isUsableCategoryUpgradeMap(null), false);
  assert.equal(isUsableCategoryUpgradeMap("economy"), false);
});

test("the decision window is bounded where a rider still waits for it", () => {
  for (const seconds of [
    MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
    30,
    MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
  ]) {
    assert.equal(
      updateRideConfigurationValidator.safeParse(
        asRequest({ categoryUpgradeDecisionSeconds: seconds }),
      ).success,
      true,
      `${seconds}s should be accepted`,
    );
  }

  for (const seconds of [
    MIN_CATEGORY_UPGRADE_DECISION_SECONDS - 1,
    MAX_CATEGORY_UPGRADE_DECISION_SECONDS + 1,
    12.5,
  ]) {
    assert.equal(
      updateRideConfigurationValidator.safeParse(
        asRequest({ categoryUpgradeDecisionSeconds: seconds }),
      ).success,
      false,
      `${seconds}s should be refused`,
    );
  }
});

test("the panel cannot save an upgrade map that loops or leaves the ladder", () => {
  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({ categoryUpgradeMap: { economy: "luxury" } }),
    ).success,
    true,
  );

  const selfLoop = updateRideConfigurationValidator.safeParse(
    asRequest({ categoryUpgradeMap: { economy: "economy" } }),
  );
  assert.equal(selfLoop.success, false);
  assert.match(selfLoop.error.issues[0].message, /upgraded to itself/);

  for (const map of [{ economy: "carpool" }, { carpool: "luxury" }, {}]) {
    assert.equal(
      updateRideConfigurationValidator.safeParse(
        asRequest({ categoryUpgradeMap: map }),
      ).success,
      false,
    );
  }
});

test("the upgrade copy declares only the placeholders it is given", () => {
  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({
        appMessages: {
          RIDE_UPGRADE_OFFERED: { en: "Luxury for ${{fare}} in {{seconds}}s" },
        },
      }),
    ).success,
    true,
  );

  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({
        appMessages: { RIDE_UPGRADE_OFFERED: { en: "Within {{radius}}" } },
      }),
    ).success,
    false,
  );

  assert.equal(
    updateRideConfigurationValidator.safeParse(
      asRequest({
        appMessages: { RIDE_UPGRADE_UNAVAILABLE: { en: "Sorry {{fare}}" } },
      }),
    ).success,
    false,
  );
});

test("the category names a rider reads ship in every locale", () => {
  for (const catalogue of [enMessages, esMessages]) {
    for (const category of DISPATCHABLE_CATEGORIES) {
      const key = `RIDE_CATEGORY_${category.toUpperCase()}`;
      assert.equal(
        typeof catalogue[key],
        "string",
        `${key} is missing, so an upgrade sentence would print an English word in Spanish`,
      );
      assert.ok(catalogue[key].length > 0);
    }
  }
});
