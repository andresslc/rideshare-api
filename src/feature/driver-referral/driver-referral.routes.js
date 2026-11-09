const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");

const {
  applyReferralCodeController,
  getDriverReferralHistoryController,
  getDriverReferralSummaryController,
  getRiderReferralStatusController,
} = require("./driver-referral.controller");
const {
  applyReferralCodeValidator,
  driverReferralHistoryValidator,
  emptyRequestValidator,
} = require("./dto/driver-referral.validators");

router.use(protectRouteMiddleware);

// Rider
router.post(
  "/apply",
  validate(applyReferralCodeValidator),
  catchAsync(applyReferralCodeController),
);
router.get(
  "/me",
  validate(emptyRequestValidator),
  catchAsync(getRiderReferralStatusController),
);

// Driver — "My referral code"
router.get(
  "/driver/me",
  validate(emptyRequestValidator),
  catchAsync(getDriverReferralSummaryController),
);
router.get(
  "/driver/history",
  validate(driverReferralHistoryValidator),
  catchAsync(getDriverReferralHistoryController),
);

module.exports = {
  path: "/driver-referral",
  router,
};
