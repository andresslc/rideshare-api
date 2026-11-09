const { z } = require("zod");

const empty = z.object({}).strict();

const purchaseSubscriptionValidator = z.object({
  body: empty,
  query: empty,
  params: z.object({
    priceId: z.string().trim().min(1, "Price ID is required"),
  }),
});

module.exports = {
  purchaseSubscriptionValidator,
};