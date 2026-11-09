const { z } = require("zod");

const empty = z.object({}).strip();

const objectIdRegex = /^[a-f\d]{24}$/i;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ID");

exports.createCampaignValidator = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(100),
      description: z.string().trim().optional().or(z.null()),
      discountType: z.enum(["percentage", "fixed"]),
      discountValue: z.number().positive(),
      maxDiscountCap: z.number().positive().optional().or(z.null()),
      minRideAmount: z.number().positive().optional().or(z.null()),
      startDate: z.string().datetime().or(z.date()),
      expiresAt: z.string().datetime().or(z.date()),
      maxUsesPerUser: z.number().int().min(1).default(1),
      totalRedemptionLimit: z.number().int().min(1),
      codeMode: z.enum(["public", "unique"]),
      eligibility: z
        .object({
          rideTypes: z
            .array(z.enum(["economy", "luxury", "private", "carpool"]))
            .optional()
            .default([]),
          userType: z.enum(["all", "new", "existing"]).optional().default("all"),
          minAge: z.number().min(0).optional().or(z.null()),
          cities: z.array(z.string()).optional().default([]),
        })
        .optional(),
      code: z
        .string()
        .trim()
        .min(3)
        .max(20)
        .regex(/^[a-zA-Z0-9]+$/)
        .optional(),
      prefix: z
        .string()
        .trim()
        .min(2)
        .max(10)
        .regex(/^[a-zA-Z0-9]+$/)
        .optional(),
      quantity: z.number().int().min(1).max(500).optional(),
    })
    .superRefine((data, ctx) => {
      // Validate dates
      if (new Date(data.expiresAt) <= new Date(data.startDate)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expiration date must be after start date.",
          path: ["expiresAt"],
        });
      }

      // Validate discount
      if (data.discountType === "percentage") {
        if (data.discountValue > 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Percentage discount must not exceed 100.",
            path: ["discountValue"],
          });
        }
        if (!data.maxDiscountCap) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "A maximum discount cap is required for percentage-based discounts.",
            path: ["maxDiscountCap"],
          });
        }
      }

      // Validate code modes
      if (data.codeMode === "public") {
        if (!data.code) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "code is required for public campaigns.",
            path: ["code"],
          });
        }
      } else if (data.codeMode === "unique") {
        if (!data.prefix) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "prefix is required for unique campaigns.",
            path: ["prefix"],
          });
        }
        if (!data.quantity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "quantity is required for unique campaigns.",
            path: ["quantity"],
          });
        }
      }
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.updateCampaignValidator = z.object({
  body: z
    .object({
      name: z.string().trim().min(2).max(100).optional(),
      description: z.string().trim().optional().or(z.null()),
      minRideAmount: z.number().positive().optional().or(z.null()),
      maxDiscountCap: z.number().positive().optional().or(z.null()),
      expiresAt: z.string().datetime().or(z.date()).optional(),
      eligibility: z
        .object({
          rideTypes: z
            .array(z.enum(["economy", "luxury", "private", "carpool"]))
            .optional(),
          userType: z.enum(["all", "new", "existing"]).optional(),
          minAge: z.number().min(0).optional().or(z.null()),
          cities: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .strip(),
  query: empty,
  params: z
    .object({
      id: z.string().regex(objectIdRegex, "Invalid Campaign ID"),
    })
    .strip(),
});

exports.updateCampaignStatusValidator = z.object({
  body: z
    .object({
      status: z.enum(["active", "paused", "expired"]),
    })
    .strip(),
  query: empty,
  params: z
    .object({
      id: z.string().regex(objectIdRegex, "Invalid Campaign ID"),
    })
    .strip(),
});

exports.getAllCampaignsValidator = z.object({
  body: empty,
  query: z
    .object({
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
      status: z.enum(["active", "paused", "expired"]).optional(),
      search: z.string().trim().optional(),
    })
    .strip(),
  params: empty,
});

exports.campaignIdValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z.string().regex(objectIdRegex, "Invalid Campaign ID"),
    })
    .strip(),
});

exports.getCampaignCodesValidator = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  query: z
    .object({
      page: z.preprocess((v) => parseInt(v, 10), z.number().int().min(1).default(1)),
      limit: z.preprocess(
        (v) => parseInt(v, 10),
        z.number().int().min(1).max(100).default(10)
      ),
    })
    .strip(),
  body: empty,
});

exports.getCampaignRedemptionsValidator = z.object({
  params: z.object({
    id: objectIdSchema,
  }),
  query: z
    .object({
      page: z.preprocess((v) => parseInt(v, 10), z.number().int().min(1).default(1)),
      limit: z.preprocess(
        (v) => parseInt(v, 10),
        z.number().int().min(1).max(100).default(20)
      ),
      search: z.string().optional(),
    })
    .strip(),
  body: empty,
});

exports.userRedemptionHistoryValidator = z.object({
  params: z.object({
    id: objectIdSchema,
    userId: objectIdSchema,
  }),
  query: empty,
  body: empty,
});
