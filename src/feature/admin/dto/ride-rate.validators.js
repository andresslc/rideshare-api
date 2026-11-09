const { z } = require("zod");

const empty = z.object({}).strip();

// ── Rate bracket ──────────────────────────────────────────────────────────────
const rateBracketValidator = z.object({
  minMiles: z
    .number({ required_error: "minMiles is required" })
    .nonnegative("minMiles must be >= 0"),
  maxMiles: z
    .number()
    .positive("maxMiles must be > 0")
    .nullable()
    .optional()
    .default(null),
  ratePerMile: z
    .number({ required_error: "ratePerMile is required" })
    .positive("ratePerMile must be > 0"),
});

const cityRateBracketValidator = z.object({
  minMiles: z.number().nonnegative(),
  maxMiles: z.number().positive().nullable(),
  price: z.number().positive("price must be > 0"),
});

const requiredCityBrackets = [
  [0, 4],
  [5, 9],
  [10, 15],
  [16, 20],
  [21, null],
];

const cityBracketsValidator = z
  .array(cityRateBracketValidator)
  .length(5, "Exactly five mileage brackets are required")
  .refine((brackets) => {
    const sorted = [...brackets].sort((a, b) => a.minMiles - b.minMiles);
    return sorted.every(
      (bracket, index) =>
        bracket.minMiles === requiredCityBrackets[index][0] &&
        bracket.maxMiles === requiredCityBrackets[index][1],
    );
  }, "Brackets must be exactly 0-4, 5-9, 10-15, 16-20, and 21+ miles");

// ── GET /ride-rates ───────────────────────────────────────────────────────────
exports.getRideRatesValidator = z.object({
  body: empty,
  query: z
    .object({
      city: z.string().trim().min(1).optional(),
      cityName: z.string().trim().min(1).max(100).optional(),
    })
    .strip(),
  params: empty,
});

// ── POST /city-ride-rates ────────────────────────────────────────────────────
exports.createCityRideRateValidator = z.object({
  body: z
    .object({
      city: z.string().trim().min(1, "city is required").max(100),
      rideType: z.enum(["economy", "luxury", "carpool"]),
      brackets: cityBracketsValidator,
      peakSurchargePerMile: z
        .number()
        .nonnegative("peakSurchargePerMile must be >= 0")
        .optional()
        .default(0),
      isActive: z.boolean().optional().default(true),
    })
    .strip(),
  query: empty,
  params: empty,
});

// ── PUT /city-ride-rates/:id ─────────────────────────────────────────────────
exports.updateCityRideRateValidator = z.object({
  body: z
    .object({
      city: z.string().trim().min(1).max(100).optional(),
      rideType: z.enum(["economy", "luxury", "carpool"]).optional(),
      brackets: cityBracketsValidator.optional(),
      peakSurchargePerMile: z
        .number()
        .nonnegative("peakSurchargePerMile must be >= 0")
        .optional(),
      isActive: z.boolean().optional(),
    })
    .strip()
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided for update",
    }),
  query: empty,
  params: z.object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid city rate ID"),
  }),
});

// ── DELETE /city-ride-rates/:id ──────────────────────────────────────────────
exports.deleteCityRideRateValidator = z.object({
  body: empty,
  query: empty,
  params: z.object({
    id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid city rate ID"),
  }),
});

// ── PUT /ride-rates/:rideType ─────────────────────────────────────────────────
exports.updateRideRateValidator = z.object({
  params: z
    .object({
      rideType: z.enum(["economy", "luxury", "carpool"], {
        required_error: "rideType must be economy, luxury, or carpool",
      }),
    })
    .strip(),
  body: z
    .object({
      brackets: z
        .array(rateBracketValidator)
        .min(1, "At least one bracket is required")
        .optional(),
      peakSurchargePerMile: z
        .number()
        .nonnegative("peakSurchargePerMile must be >= 0")
        .optional(),
      discountPercentage: z
        .number()
        .min(0, "discountPercentage must be >= 0")
        .max(100, "discountPercentage must be <= 100")
        .optional(),
      isActive: z.boolean().optional(),
    })
    .strip()
    .refine(
      (data) => Object.keys(data).length > 0,
      "At least one field must be provided for update",
    ),
  query: empty,
});

// ── GET /peak-windows ─────────────────────────────────────────────────────────
exports.getPeakWindowsValidator = z.object({
  body: empty,
  query: empty,
  params: empty,
});

// ── POST /peak-windows ────────────────────────────────────────────────────────
exports.createPeakWindowValidator = z.object({
  body: z
    .object({
      startHour: z
        .number({ required_error: "startHour is required" })
        .int()
        .min(0)
        .max(23, "startHour must be 0–23"),
      endHour: z
        .number({ required_error: "endHour is required" })
        .int()
        .min(1)
        .max(24, "endHour must be 1–24"),
      isActive: z.boolean().optional().default(true),
    })
    .strip()
    .refine((d) => d.endHour > d.startHour, {
      message: "endHour must be greater than startHour",
      path: ["endHour"],
    }),
  query: empty,
  params: empty,
});

// ── PUT /peak-windows/:id ─────────────────────────────────────────────────────
exports.updatePeakWindowValidator = z.object({
  params: z
    .object({
      id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid peak window ID"),
    })
    .strip(),
  body: z
    .object({
      startHour: z.number().int().min(0).max(23).optional(),
      endHour: z.number().int().min(1).max(24).optional(),
      isActive: z.boolean().optional(),
    })
    .strip()
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided for update",
    }),
  query: empty,
});

// ── DELETE /peak-windows/:id ──────────────────────────────────────────────────
exports.deletePeakWindowValidator = z.object({
  params: z
    .object({
      id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid peak window ID"),
    })
    .strip(),
  body: empty,
  query: empty,
});
