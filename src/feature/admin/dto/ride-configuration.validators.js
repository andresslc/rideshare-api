const { z } = require("zod");
const {
  MAX_DISPATCH_RADIUS_MILES,
  MAX_DISPATCH_RINGS,
  CONFIGURABLE_APP_MESSAGES,
  CONFIGURABLE_APP_MESSAGE_KEYS,
  DISTANCE_UNITS,
  SUPPORTED_LOCALES,
  DISPATCHABLE_CATEGORIES,
  MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
  MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
  MAX_DRIVER_REFERRAL_AMOUNT,
} = require("../../../core/common/constants/ride-constants");

const empty = z.object({}).strip();

const referralAmount = (label) =>
  z
    .number({ message: `${label} must be a number` })
    .min(0, `${label} cannot be negative`)
    .max(
      MAX_DRIVER_REFERRAL_AMOUNT,
      `${label} must be at most ${MAX_DRIVER_REFERRAL_AMOUNT}`,
    )
    .refine(
      (amount) => Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6,
      {
        message: `${label} must be in whole cents`,
      },
    );

const driverReferral = z
  .object({
    enabled: z.boolean({ message: "enabled must be true or false" }).optional(),
    riderDiscountAmount: referralAmount("The rider discount").optional(),
    driverBonusAmount: referralAmount("The driver bonus").optional(),
  })
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, {
    message: "driverReferral needs at least one setting",
  });
const radiusInMiles = z
  .number({ message: "Radius must be a number" })
  .min(0.01, "Radius must be at least 0.01");

// The ladder is what decides how far a driver may be asked to travel for a
// pickup, so it is validated harder than a plain radius: ascending, bounded in
// length, and never past the reach cap.
const dispatchRadiusLadderMiles = z
  .array(
    z
      .number({ message: "Each dispatch radius must be a number" })
      .min(0.01, "Each dispatch radius must be at least 0.01")
      .max(
        MAX_DISPATCH_RADIUS_MILES,
        `No dispatch radius may exceed ${MAX_DISPATCH_RADIUS_MILES} miles`,
      ),
  )
  .min(1, "The dispatch ladder needs at least one ring")
  .max(
    MAX_DISPATCH_RINGS,
    `The dispatch ladder allows at most ${MAX_DISPATCH_RINGS} rings`,
  )
  .refine(
    (ladder) => ladder.every((radius, i) => i === 0 || radius > ladder[i - 1]),
    { message: "Dispatch radii must be strictly ascending" },
  );

// A message the apps render. Only the keys they know how to display are
// accepted, and only with placeholders that key actually receives — a typo in
// `{{radious}}` would otherwise reach a rider's screen verbatim.
const localizedMessage = z
  .object(
    Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => [
        locale,
        z
          .string()
          .max(300, "A message must be at most 300 characters")
          .optional(),
      ]),
    ),
  )
  .strict()
  .refine((translations) => Object.keys(translations).length > 0, {
    message: `A message needs at least one of: ${SUPPORTED_LOCALES.join(", ")}`,
  });

const appMessages = z
  .object(
    Object.fromEntries(
      CONFIGURABLE_APP_MESSAGE_KEYS.map((key) => [
        key,
        localizedMessage.optional(),
      ]),
    ),
  )
  .strict()
  .refine((messages) => Object.keys(messages).length > 0, {
    message: `At least one message is required: ${CONFIGURABLE_APP_MESSAGE_KEYS.join(", ")}`,
  })
  .superRefine((messages, ctx) => {
    for (const [key, translations] of Object.entries(messages)) {
      const allowed = CONFIGURABLE_APP_MESSAGES[key] ?? [];

      for (const [locale, text] of Object.entries(translations ?? {})) {
        // An empty string clears the override, so it has nothing to check.
        if (typeof text !== "string" || text.trim() === "") continue;

        const used = [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
          (match) => match[1],
        );
        const unknown = used.filter((name) => !allowed.includes(name));

        if (unknown.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, locale],
            message: `Unknown placeholder(s) ${unknown.map((name) => `{{${name}}}`).join(", ")}. ${
              allowed.length
                ? `Available: ${allowed.map((name) => `{{${name}}}`).join(", ")}`
                : "This message takes no placeholders."
            }`,
          });
        }
      }
    }
  });

exports.getRideConfigurationValidator = z.object({
  body: empty,
  query: empty,
  params: empty,
});

exports.updateRideConfigurationValidator = z.object({
  body: z
    .object({
      nearbyRadius: radiusInMiles.optional(),
      carpoolNearbyRadius: radiusInMiles.optional(),
      dispatchRadiusLadderMiles: dispatchRadiusLadderMiles.optional(),
      dispatchRingTimeoutSeconds: z
        .number({ message: "Ring timeout must be a number" })
        .int("Ring timeout must be a whole number of seconds")
        .min(3, "Ring timeout must be at least 3 seconds")
        .max(60, "Ring timeout must be at most 60 seconds")
        .optional(),
      distanceUnit: z
        .enum(DISTANCE_UNITS, {
          errorMap: () => ({
            message: `Distance unit must be one of: ${DISTANCE_UNITS.join(", ")}`,
          }),
        })
        .optional(),
      // There is no `categoryUpgradeEnabled`. The upgrade is always offered
      // where a mapping exists; narrowing `categoryUpgradeMap` is what limits
      // it. The body is `.strict()`, so an old panel still sending the switch
      // gets a clear error rather than silently changing nothing.
      categoryUpgradeDecisionSeconds: z
        .number({ message: "The decision window must be a number" })
        .int("The decision window must be a whole number of seconds")
        .min(
          MIN_CATEGORY_UPGRADE_DECISION_SECONDS,
          `The decision window must be at least ${MIN_CATEGORY_UPGRADE_DECISION_SECONDS} seconds`,
        )
        .max(
          MAX_CATEGORY_UPGRADE_DECISION_SECONDS,
          `The decision window must be at most ${MAX_CATEGORY_UPGRADE_DECISION_SECONDS} seconds`,
        )
        .optional(),
      // Only dispatchable categories on either side: an upgrade into carpool
      // would restart a search the ring ladder never serves. Built as an object
      // of optional keys rather than a `record`, which in zod 4 demands every
      // key of an enum and would refuse a map that upgrades only economy.
      categoryUpgradeMap: z
        .object(
          Object.fromEntries(
            DISPATCHABLE_CATEGORIES.map((category) => [
              category,
              z.enum(DISPATCHABLE_CATEGORIES).optional(),
            ]),
          ),
        )
        .strict()
        .refine((map) => Object.keys(map).length > 0, {
          message: "The upgrade map needs at least one category",
        })
        .refine(
          (map) => Object.entries(map).every(([from, to]) => from !== to),
          { message: "A category cannot be upgraded to itself" },
        )
        .optional(),
      appMessages: appMessages.optional(),
      driverReferral: driverReferral.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
      message: "At least one setting must be provided",
    }),
  query: empty,
  params: empty,
});
