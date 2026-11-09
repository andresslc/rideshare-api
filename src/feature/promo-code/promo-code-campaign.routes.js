const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");

const {
  createCampaignController,
  updateCampaignController,
  updateCampaignStatusController,
  deleteCampaignController,
  getAllCampaignsController,
  getCampaignByIdController,
  getCampaignCodesController,
} = require("./promo-code-campaign.controller");

const {
  getCampaignStatsController,
  getCampaignRedemptionsController,
  getUserRedemptionHistoryController,
} = require("./promo-code-analytics.controller");

const {
  createCampaignValidator,
  updateCampaignValidator,
  updateCampaignStatusValidator,
  getAllCampaignsValidator,
  campaignIdValidator,
  getCampaignCodesValidator,
  getCampaignRedemptionsValidator,
  userRedemptionHistoryValidator,
} = require("./promo-code-campaign.validator");

router.post(
  "/",
  protectRouteMiddleware,
  validate(createCampaignValidator),
  catchAsync(createCampaignController)
);

router.patch(
  "/:id",
  protectRouteMiddleware,
  validate(updateCampaignValidator),
  catchAsync(updateCampaignController)
);

router.patch(
  "/:id/status",
  protectRouteMiddleware,
  validate(updateCampaignStatusValidator),
  catchAsync(updateCampaignStatusController)
);

router.delete(
  "/:id",
  protectRouteMiddleware,
  validate(campaignIdValidator),
  catchAsync(deleteCampaignController)
);

router.get(
  "/",
  protectRouteMiddleware,
  validate(getAllCampaignsValidator),
  catchAsync(getAllCampaignsController)
);

router.get(
  "/:id",
  protectRouteMiddleware,
  validate(campaignIdValidator),
  catchAsync(getCampaignByIdController)
);

router.get(
  "/:id/codes",
  protectRouteMiddleware,
  validate(getCampaignCodesValidator),
  catchAsync(getCampaignCodesController)
);

router.get(
  "/:id/stats",
  protectRouteMiddleware,
  validate(campaignIdValidator),
  catchAsync(getCampaignStatsController)
);

router.get(
  "/:id/redemptions",
  protectRouteMiddleware,
  validate(getCampaignRedemptionsValidator),
  catchAsync(getCampaignRedemptionsController)
);

router.get(
  "/:id/redemptions/:userId",
  protectRouteMiddleware,
  validate(userRedemptionHistoryValidator),
  catchAsync(getUserRedemptionHistoryController)
);

module.exports = router;
