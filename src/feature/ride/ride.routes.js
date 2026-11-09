const express = require("express");
const {
  getRidesForDriver,
  getRideById,
  rideFareCalculatorController,
  rideHistoryController,
  generateSharedRideLinkController,
  iAmComingController,
} = require("./ride.controller");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const catchAsync = require("../../core/common/catch-async");
const { validate } = require("../../core/middlewares/validate.middleware");
const {
  rideByIdValidator,
  rideFareCalculatorValidator,
} = require("./dto/ride.validator");

const router = express.Router();

router.use(protectRouteMiddleware);

router.get("/history", catchAsync(rideHistoryController));
router.route("/:id", validate(rideByIdValidator)).get(catchAsync(getRideById));
router.post("/:id/coming", catchAsync(iAmComingController));
// POST /:id/offers is retired along with rider-picked driver offers. The
// RideOffer records it read are still written by nothing and kept for history.
router.post(
  "/fare-calculator",
  validate(rideFareCalculatorValidator),
  catchAsync(rideFareCalculatorController),
);
router.get("/share/:id", catchAsync(generateSharedRideLinkController));
router.route("/").get(catchAsync(getRidesForDriver));

module.exports = {
  path: "/rides",
  router,
};
