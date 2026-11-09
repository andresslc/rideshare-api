const express = require("express");
const {
  findMatchingCarpoolsController,
  carpoolPassengersController,
  carpoolHistoryController,
  carpoolByIdController,
  carpoolDetailsController,
  viewCarpoolPassengersController,
  generateSharedCarpoolLinkController,
} = require("./carpool.controller");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const catchAsync = require("../../core/common/catch-async");

const router = express.Router();

router.use(protectRouteMiddleware);

router.post("/user/matches", catchAsync(findMatchingCarpoolsController));
router.get("/history", catchAsync(carpoolHistoryController));
router.get(
  "/:id/passengers/details",
  catchAsync(viewCarpoolPassengersController),
);
router.get("/:id/passengers", catchAsync(carpoolPassengersController));
router.get("/:id/details", catchAsync(carpoolDetailsController));
router.get("/share/:id", catchAsync(generateSharedCarpoolLinkController));
router.get("/:id", catchAsync(carpoolByIdController));

module.exports = {
  path: "/carpool",
  router,
};
