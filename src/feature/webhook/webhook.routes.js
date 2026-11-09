const express = require("express");
const { stripeWebhook, veriffWebhook } = require("./webhook.controller");

const router = express.Router();

// Stripe
router.post(
  "/stripe/:source",
  express.raw({ type: "application/json" }),
  stripeWebhook,
);

// Veriff
router.post(
  "/veriff",
  express.raw({ type: "application/json" }),
  veriffWebhook,
);

module.exports = {
  path: "/webhook",
  router,
};
