const { z } = require("zod");

/* ─── Shared Schemas ─────────────────────────────────────── */

const locationSchema = z.object({
  type: z.string().default("Point"),
  coordinates: z
    .array(z.number())
    .length(2, "coordinates must be [longitude, latitude]"),
});

const RouteStopSchema = z.object({
  placeName: z.string().min(1, "placeName is required"),
  location: locationSchema,
  order: z.number().int().min(1, "order must be >= 1"),
});

/* ─── Create Carpool Route ───────────────────────────────── */

const createCarpoolRouteValidator = z
  .object({
    startingPoint: z.object({
      placeName: z.string().min(2, "Starting point name is required"),
      location: locationSchema,
    }),
    destination: z.object({
      placeName: z.string().min(2, "Destination name is required"),
      location: locationSchema,
    }),
    routes: z.array(RouteStopSchema).min(2, "At least 2 route stops required"),
    maxPassengers: z
      .number({
        required_error: "maxPassengers is required",
        invalid_type_error: "maxPassengers must be a number",
      })
      .int()
      .min(1, "Must allow at least 1 passenger")
      .max(10, "Cannot exceed 10 passengers"),
    graceTime: z.union([z.string(), z.number()]).refine((val) => {
      const date = new Date(val);
      return !isNaN(date.getTime()) && date.getTime() > Date.now();
    }, "graceTime must be a valid future date"),

    avgTime: z.number().nonnegative().optional().default(0),
    distance: z.number().nonnegative().optional().default(0),
  })
  .superRefine((data, ctx) => {
    /* Validate route orders are unique and strictly ascending */
    const orders = data.routes.map((r) => r.order);
    const uniqueOrders = new Set(orders);
    if (uniqueOrders.size !== orders.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each route stop must have a unique order value",
        path: ["routes"],
      });
    }

    const sorted = [...orders].sort((a, b) => a - b);
    const isAscending = orders.every((o, i) => o === sorted[i]);
    if (!isAscending) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Route stops must be in strictly ascending order",
        path: ["routes"],
      });
    }
  });

/* ─── Find Matching Routes (passenger search) ────────────── */

const findCarpoolRoutesValidator = z.object({
  pickupPoint: z.object({
    placeName: z.string().min(2, "Pickup place name is required"),
    location: locationSchema,
  }),
  dropOffPoint: z.object({
    placeName: z.string().min(2, "Drop-off place name is required"),
    location: locationSchema,
  }),
  requiredSeats: z
    .number()
    .int()
    .min(1, "At least 1 seat required")
    .max(10)
    .default(1),
  fare: z
    .number({ required_error: "fare is required" })
    .nonnegative("fare cannot be negative"),
  paymentMethod: z.enum(["wallet", "attached_card"], {
    errorMap: () => ({
      message: "paymentMethod must be 'wallet' or 'attached_card'",
    }),
  }),

  avgTime: z.number().nonnegative().optional().default(0),
  distance: z.number().nonnegative().optional().default(0),
});

/* ─── Join a Specific Carpool ────────────────────────────── */

const joinCarpoolValidator = z.object({
  carpoolId: z.string().min(1, "carpoolId is required"),

  pickupPoint: z.object({
    placeName: z.string().min(2, "Pickup place name is required"),
    location: locationSchema,
  }),

  dropOffPoint: z.object({
    placeName: z.string().min(2, "Drop-off place name is required"),
    location: locationSchema,
  }),

  requiredSeats: z.number().int().min(1).max(10).default(1),

  fare: z
    .number({ required_error: "fare is required" })
    .nonnegative("fare cannot be negative"),

  paymentMethod: z.enum(["wallet", "attached_card"], {
    errorMap: () => ({
      message: "paymentMethod must be 'wallet' or 'attached_card'",
    }),
  }),

  avgTime: z.number().nonnegative().optional().default(0),
  distance: z.number().nonnegative().optional().default(0),

  originalFare: z.number().optional(),
  codeId: z.string().optional(),
  campaignId: z.string().optional(),
  discountAmount: z.number().optional(),
});

/* ─── Driver Respond (accept/reject passenger) ───────────── */

const carpoolRespondValidator = z.object({
  bookingId: z.string().min(1, "bookingId is required"),
  action: z.enum(["accept", "reject"], {
    errorMap: () => ({ message: "action must be 'accept' or 'reject'" }),
  }),
});

/* ─── Start Ride (OTP verification) ─────────────────────── */

const carpoolStartValidator = z.object({
  carpoolId: z.string().min(1, "carpoolId is required"),
});

/* ─── Pick Passenger (OTP verification at pickup) ───────── */

const carpoolPickPassengerValidator = z.object({
  bookingId: z.string().min(1, "bookingId is required"),
  otp: z
    .string()
    .length(6, "OTP must be exactly 6 digits")
    .regex(/^\d{6}$/, "OTP must be numeric"),
});

/* ─── Complete Ride ──────────────────────────────────────── */

const carpoolCompleteValidator = z.object({
  bookingId: z.string().min(1, "bookingId is required"),
});

/* ─── Cancel Route (driver) ──────────────────────────────── */

const cancelCarpoolRouteValidator = z.object({
  carpoolId: z.string().min(1, "carpoolId is required"),
});

/* Arrive at Route (driver) */
const carpoolArriveValidator = z.object({
  carpoolId: z.string().min(1, "carpoolId is required"),
  routeStopId: z.string().min(1, "routeStopId is required"),
});

module.exports = {
  createCarpoolRouteValidator,
  findCarpoolRoutesValidator,
  joinCarpoolValidator,
  carpoolRespondValidator,
  carpoolStartValidator,
  carpoolCompleteValidator,
  cancelCarpoolRouteValidator,
  carpoolPickPassengerValidator,
  carpoolArriveValidator,
};
