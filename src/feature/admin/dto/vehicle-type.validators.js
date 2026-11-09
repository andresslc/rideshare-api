const { z } = require("zod");

const empty = z.object({}).strip();

exports.createVehicleTypeValidator = z.object({
  body: z
    .object({
      make: z
        .string({
          required_error: "Vehicle make is required",
        })
        .trim()
        .min(1, "Make cannot be empty")
        .optional(),
      model: z.string().trim().optional().or(z.null()),

      rideType: z.enum(["economy", "luxury", "carpool"], {
        required_error: "Ride type is required",
        invalid_type_error:
          "Ride type must be one of: economy, luxury, carpool",
      }),

      notes: z.string().trim().optional().or(z.null()),
    })
    .strip(),

  query: empty,
  params: empty,
});

exports.updateVehicleTypeValidator = z.object({
  body: z
    .object({
      make: z.string().trim().min(1, "Make cannot be empty").optional(),

      model: z.string().trim().optional().or(z.null()),

      rideType: z.enum(["economy", "luxury", "carpool"]).optional(),

      isActive: z.boolean().optional(),

      notes: z.string().trim().optional().or(z.null()),
    })
    .strip(),

  query: empty,
  params: z
    .object({
      id: z
        .string({
          required_error: "Vehicle Type ID is required",
        })
        .regex(/^[a-f\d]{24}$/i, "Invalid Vehicle Type ID"),
    })
    .strip(),
});

exports.listVehicleTypesValidator = z.object({
  body: z.object({}).strip(),

  query: z
    .object({
      search: z.string().trim().optional(),

      rideType: z.enum(["economy", "luxury", "carpool"]).optional(),

      isActive: z
        .enum(["true", "false"])
        .transform((val) => val === "true")
        .optional(),

      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),

      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
    })
    .strip(),

  params: z.object({}).strip(),
});

exports.deleteVehicleTypeValidator = z.object({
  body: z.object({}).strip(),

  query: empty,
  params: z
    .object({
      id: z
        .string({
          required_error: "Vehicle Type ID is required",
        })
        .regex(/^[a-f\d]{24}$/i, "Invalid Vehicle Type ID"),
    })
    .strip(),
});
