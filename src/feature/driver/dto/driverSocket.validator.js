const zod = require("zod");

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

const driverOnlineValidator = zod.object({
  location: locationSchema,
});

const driverLocationUpdateValidator = zod.object({
  location: locationSchema,
  eta: zod.string().optional(),
});

const rideAcceptValidator = zod.object({
  rideRequestId: zod.string().min(10, "Invalid ride request id"),
});

const rideStartValidator = zod.object({
  rideId: zod.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid MongoDB ObjectId"),
  otp: zod.number().max(999999, "OTP must be 6 digits"),
});

const rideIdValidator = zod.object({
  rideId: zod.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid MongoDB ObjectId"),
});

const offerIdValidator = zod.object({
  offerId: zod.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid MongoDB ObjectId"),
});

const rideCancellationValidator = zod.object({
  rideId: rideIdValidator.shape.rideId,
  cancellationReason: zod.string().optional(),
  isPendingRequestCancelled: zod.boolean().optional(),
});

const rideArriveValidator = zod.object({
  rideId: rideIdValidator.shape.rideId,
  location: locationSchema,
});

module.exports = {
  driverOnlineValidator,
  driverLocationUpdateValidator,
  rideAcceptValidator,
  rideIdValidator,
  rideStartValidator,
  rideCancellationValidator,
  rideArriveValidator,
  offerIdValidator,
};
