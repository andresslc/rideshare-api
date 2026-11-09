const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");
const {
  addReviewValidator,
  updateReviewValidator,
  deleteReviewValidator,
  getReviewsValidator,
} = require("./dto/review.validators");
const {
  addReviewController,
  updateReviewController,
  deleteReviewController,
  getReviewsController,
} = require("./review.controller");

router.post(
  "/",
  protectRouteMiddleware,
  validate(addReviewValidator),
  catchAsync(addReviewController),
);

router.put(
  "/",
  protectRouteMiddleware,
  validate(updateReviewValidator),
  catchAsync(updateReviewController),
);

router.delete(
  "/:reviewId",
  protectRouteMiddleware,
  validate(deleteReviewValidator),
  catchAsync(deleteReviewController),
);

router.get(
  "/",
  protectRouteMiddleware,
  validate(getReviewsValidator),
  catchAsync(getReviewsController),
);

module.exports = {
  path: "/review",
  router: router,
};
