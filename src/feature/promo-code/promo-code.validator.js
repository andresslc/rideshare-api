const { z } = require("zod");

const empty = z.object({}).strip();

exports.redeemCodeValidator = z.object({
  body: z
    .object({
      code: z.string().trim().min(2).max(30),
      rideType: z.enum(["economy", "luxury", "private", "carpool"]),
      pickupCity: z.string().trim().min(1),
      rideFare: z.array(z.number().positive()).min(1),
    })
    .strip(),
  query: empty,
  params: empty,
});
