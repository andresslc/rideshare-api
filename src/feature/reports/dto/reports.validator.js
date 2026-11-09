const { default: mongoose } = require("mongoose");
const { z } = require("zod");

const empty = z.object({}).strip();
const isValidObjectId = (val) => mongoose.Types.ObjectId.isValid(val);

exports.addReportValidator = z.object({
  body: z
    .object({
      entityId: z
        .string({ required_error: "Entity ID is required" })
        .refine(isValidObjectId, {
          message: "Entity ID must be a valid ObjectId",
        }),
      entityType: z.enum(["Driver", "User"], {
        required_error: "Entity type is required",
        invalid_type_error: "Entity type must be either Driver or User",
      }),
      reason: z
        .string({
          required_error: "Reason is required",
        })
        .min(3, "Reason must be at least 3 characters")
        .max(250, "Reason cannot exceed 100 characters"),
      description: z
        .string()
        .max(500, "Description cannot exceed 500 characters")
        .optional(),
      supportingEntityId: z
        .string({ required_error: "Supporting Entity ID is required" })
        .refine(isValidObjectId, {
          message: "Supporting Entity ID must be a valid ObjectId",
        }),
      supportingEntityType: z.enum(["Ride", "CarpoolRoute"], {
        required_error: "Supporting Entity type is required",
        invalid_type_error:
          "Supporting Entity type must be either Ride or CarpoolRoute",
      }),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.deleteReportValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      reportId: z
        .string({ required_error: "Report ID is required" })
        .refine(isValidObjectId, {
          message: "Report ID must be a valid ObjectId",
        }),
    })
    .strip(),
});

exports.getReportsValidator = z.object({
  body: empty,
  params: empty,
  query: z
    .object({
      page: z
        .string()
        .optional()
        .refine((val) => !val || !isNaN(parseInt(val)), {
          message: "Page must be a number",
        }),
      limit: z
        .string()
        .optional()
        .refine((val) => !val || !isNaN(parseInt(val)), {
          message: "Limit must be a number",
        }),
      entityType: z
        .enum(["Driver", "User"], {
          invalid_type_error: "Entity type must be either Driver or User",
        })
        .optional(),
      search: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    })
    .strip()
    .refine(
      (data) => {
        if (data.startDate && !data.endDate) return false;
        if (!data.startDate && data.endDate) return false;
        return true;
      },
      { message: "Both startDate and endDate must be provided together" },
    ),
});
