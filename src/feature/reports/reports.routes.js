const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");
const {
  addReportValidator,
  deleteReportValidator,
  getReportsValidator,
} = require("./dto/reports.validator");
const {
  addReportController,
  deleteReportController,
  getReportsController,
} = require("./reports.controller");

router.post(
  "/",
  protectRouteMiddleware,
  validate(addReportValidator),
  catchAsync(addReportController),
);

router.delete(
  "/:reportId",
  protectRouteMiddleware,
  validate(deleteReportValidator),
  catchAsync(deleteReportController),
);

router.get(
  "/",
  protectRouteMiddleware,
  validate(getReportsValidator),
  catchAsync(getReportsController),
);

module.exports = {
  path: "/report",
  router: router,
};
