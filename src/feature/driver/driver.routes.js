const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");
const { createMulter } = require("../../core/common/helpers/index.js");
const {
  setupConnectedAccoutController,
  attachBankAccountController,
  deleteBankAccountController,
  withdrawController,
  transactionHistoryController,
  banksListController,
  getMeController,
  editDriverController,
  deleteAccountController,
  changeLocaleController,
  setDefaultBankAccountController,
  dashboardController,
  driverStatsController,
} = require("./driver.controller");
const {
  attachBankValidator,
  deleteBankValidator,
  withdrawValidator,
  deleteAccountValidator,
} = require("./dto/driver.validators");
const upload = createMulter();

router.get(
  "/setup-account",
  protectRouteMiddleware,
  catchAsync(setupConnectedAccoutController),
);

router.get(
  "/:id/stats",
  protectRouteMiddleware,
  catchAsync(driverStatsController),
);

router.post(
  "/attach-bank",
  protectRouteMiddleware,
  validate(attachBankValidator),
  catchAsync(attachBankAccountController),
);

router.delete(
  "/delete-bank",
  protectRouteMiddleware,
  validate(deleteBankValidator),
  catchAsync(deleteBankAccountController),
);

router.post(
  "/set-default-bank",
  protectRouteMiddleware,
  catchAsync(setDefaultBankAccountController),
);

router.post(
  "/withdraw",
  protectRouteMiddleware,
  validate(withdrawValidator),
  catchAsync(withdrawController),
);

router.get(
  "/transaction-history",
  protectRouteMiddleware,
  catchAsync(transactionHistoryController),
);

router.get(
  "/banks-list",
  protectRouteMiddleware,
  catchAsync(banksListController),
);

router.get("/me", protectRouteMiddleware, catchAsync(getMeController));

router.patch(
  "/edit/:type",
  upload.array("files", 10),
  protectRouteMiddleware,
  catchAsync(editDriverController),
);

router.post(
  "/delete",
  protectRouteMiddleware,
  validate(deleteAccountValidator),
  catchAsync(deleteAccountController),
);

router.post(
  "/change-locale",
  protectRouteMiddleware,
  catchAsync(changeLocaleController),
);

router.get(
  "/dashboard",
  protectRouteMiddleware,
  catchAsync(dashboardController),
);

module.exports = {
  path: "/driver",
  router: router,
};
