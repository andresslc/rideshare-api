const { z } = require("zod");

const empty = z.object({}).strip();

exports.ExportRideValidator = z.object({
  body: empty,
  query: z
    .object({
      status: z.enum(["completed", "cancelled"], {
        required_error: "Ride status is required",
        invalid_type_error:
          "Ride status must be either 'completed' or 'cancelled'",
      }),
      search: z.string().trim().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional().default("desc"),
    })
    .strip(),
  params: empty,
});

exports.getCarpoolDetailsValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid Carpool ID"),
    })
    .strip(),
});

exports.getRideByIdValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid Ride ID"),
    })
    .strip(),
});

exports.getJourneyTimelineValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      journeyType: z.enum(["ride", "carpool"]),
      journeyId: z.string().regex(/^[a-f\d]{24}$/i, "Invalid Journey ID"),
    })
    .strip(),
});
