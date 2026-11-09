const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");
const {
  purchaseSubscriptionValidator,
} = require("./dto/subscription.validators");
const {
  purchaseSubscriptionController,
  cancelSubscriptionController,
  subscriptionDetailsController,
} = require("./subscription.controller");

router.post(
  "/purchase/:priceId/:id",
  catchAsync(purchaseSubscriptionController),
);

router.post(
  "/cancel",
  protectRouteMiddleware,
  catchAsync(cancelSubscriptionController),
);

router.get(
  "/details/:id",
  catchAsync(subscriptionDetailsController),
);

module.exports = {
  path: "/subscription",
  router: router,
};
