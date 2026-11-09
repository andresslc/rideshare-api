const { z } = require("zod");

const empty = z.object({}).strip();

exports.applyReferralCodeValidator = z.object({
  body: z
    .object({
      code: z.string().trim().min(1, "A referral code is required").max(20),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.emptyRequestValidator = z.object({
  body: empty,
  query: empty,
  params: empty,
});

exports.driverReferralHistoryValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    })
    .strip(),
  params: empty,
});
