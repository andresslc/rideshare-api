const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");

const { redeemCodeController } = require("./promo-code.controller");
const { redeemCodeValidator } = require("./promo-code.validator");

router.post(
  "/apply",
  protectRouteMiddleware,
  validate(redeemCodeValidator),
  catchAsync(redeemCodeController)
);

module.exports = {
  path: "/promo-code",
  router: router,
};
