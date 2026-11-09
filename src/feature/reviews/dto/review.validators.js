const { default: mongoose } = require("mongoose");
const { z } = require("zod");

const empty = z.object({}).strip();
const isValidObjectId = (val) => mongoose.Types.ObjectId.isValid(val);

exports.addReviewValidator = z.object({
  body: z
    .object({
      receiverId: z
        .string({ required_error: "Receiver ID is required" })
        .refine(isValidObjectId, {
          message: "Receiver ID must be a valid ObjectId",
        }),
      receiverType: z.enum(["Driver", "User"], {
        required_error: "Receiver type is required",
        invalid_type_error: "Receiver type must be either Driver or User",
      }),
      stars: z
        .number({
          required_error: "Stars are required",
          invalid_type_error: "Stars must be a number",
        })
        .min(1, "Stars must be at least 1")
        .max(5, "Stars cannot exceed 5"),
      description: z
        .string()
        .max(500, "Description cannot exceed 500 characters")
        .optional(),
      rideId: z.string().optional(),
      carpoolId: z.string().optional(),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.updateReviewValidator = z.object({
  body: z
    .object({
      stars: z
        .number({ invalid_type_error: "Stars must be a number" })
        .min(1, "Stars must be at least 1")
        .max(5, "Stars cannot exceed 5")
        .optional(),
      description: z
        .string()
        .max(500, "Description cannot exceed 500 characters")
        .optional(),
    })
    .strip(),
  query: empty,
  params: z
    .object({
      reviewId: z
        .string({ required_error: "Review ID is required" })
        .refine(isValidObjectId, {
          message: "Review ID must be a valid ObjectId",
        }),
    })
    .strip(),
});

exports.deleteReviewValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      reviewId: z
        .string({ required_error: "Review ID is required" })
        .refine(isValidObjectId, {
          message: "Review ID must be a valid ObjectId",
        }),
    })
    .strip(),
});

exports.getReviewsValidator = z.object({
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
      userId: z
        .string()
        .refine(isValidObjectId, {
          message: "User ID must be a valid ObjectId",
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
