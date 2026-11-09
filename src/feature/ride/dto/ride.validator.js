const zod = require("zod");
const {
  RIDE_TYPE,
  REQUEST_CATEGORIES,
  RIDE_PAYMENT_METHODS,
} = require("../../../core/common/constants/ride-constants");
const { default: mongoose } = require("mongoose");

const isValidObjectId = (val) => mongoose.Types.ObjectId.isValid(val);
const empty = zod.object({}).strip();

const locationSchema = zod.object({
  type: zod.literal("Point").optional(),
  coordinates: zod
    .array(zod.number())
    .length(2, "Coordinates must contain [longitude, latitude]")
    .refine(
      (coords) =>
        coords[0] >= -180 &&
        coords[0] <= 180 &&
        coords[1] >= -90 &&
        coords[1] <= 90,
      "Invalid longitude or latitude values",
    ),
});

const rideRequestValidator = zod
  .object({
    // What the rider is asking for. `rideType` is the old spelling and is still
    // accepted so apps in the field keep working; new clients send `category`.
    category: zod
      .enum(REQUEST_CATEGORIES, {
        errorMap: () => ({
          message: `Category must be one of: ${REQUEST_CATEGORIES.join(", ")}`,
        }),
      })
      .optional(),

    pickupPoint: zod.object({
      placeName: zod.string().min(2, "Pickup place name is required"),
      location: locationSchema,
    }),

    dropOffPoint: zod.object({
      placeName: zod.string().min(2, "Drop-off place name is required"),
      location: locationSchema,
    }),

    specialRequest: zod
      .string()
      .max(255, "Special request must be less than 255 characters")
      .optional(),

    // The city the app priced the ride against — the same value it already
    // sends to the fare calculator. Optional so older builds keep working; a
    // request without it can only be re-quoted against the global rate.
    pickupCity: zod
      .string()
      .trim()
      .min(1, "Pickup city cannot be empty")
      .max(120, "Pickup city must be less than 120 characters")
      .optional(),

    rideType: zod.enum(RIDE_TYPE).optional(),

    rideDistance: zod
      .number()
      .positive("Ride distance must be greater than 0")
      .optional(),

    rideFare: zod
      .number()
      .nonnegative("Total amount cannot be negative")
      .optional(),

    economyRideFare: zod
      .number()
      .nonnegative("Total amount cannot be negative")
      .optional(),

    luxuryRideFare: zod
      .number()
      .nonnegative("Total amount cannot be negative")
      .optional(),

    originalRideFare: zod
      .number()
      .nonnegative("Discounted amount cannot be negative")
      .optional(),

    codeId: zod.string().optional(),
    campaignId: zod.string().optional(),
    originalEconomyRideFare: zod.number().optional(),
    originalLuxuryRideFare: zod.number().optional(),

    averageTime: zod
      .number()
      .positive("Average time must be greater than 0 (in minutes)")
      .optional(),

    paymentMethod: zod
      .enum(RIDE_PAYMENT_METHODS, {
        errorMap: () => ({
          message: "Payment method must be either 'attached_card' or 'wallet'",
        }),
      })
      .optional(),
  })
  .refine((data) => Boolean(data.category || data.rideType), {
    message: `A category is required: ${REQUEST_CATEGORIES.join(", ")}`,
    path: ["category"],
  });

const rideByIdValidator = zod.object({
  body: empty,
  query: empty,
  params: zod.object({
    id: zod.string().refine(isValidObjectId, "Invalid ride ID format"),
  }),
});

const rideFareCalculatorValidator = zod.object({
  body: zod
    .object({
      rideType: zod.enum(RIDE_TYPE),
      miles: zod.number().nonnegative("Miles cannot be negative"),
      // Optional for backward compatibility; missing/unconfigured cities use
      // the existing global ride-rate calculation.
      pickupCity: zod
        .string()
        .trim()
        .min(1, "Pickup city cannot be empty")
        .optional(),
    })
    .strip(),
  query: empty,
  params: empty,
});

module.exports = {
  rideRequestValidator,
  rideByIdValidator,
  rideFareCalculatorValidator,
};
