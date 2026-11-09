const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const { createMulter } = require("../../core/common/helpers/index.js");
const upload = createMulter();
const {
  getUserProfileController,
  editUserProfileController,
  attachCardController,
  topupWalletController,
  transactionHistoryController,
  cardsListController,
  setCardAsDefaultController,
  removeCardController,
  saveLocationController,
  myLocationsController,
  deleteAccountController,
  updateLocationOrderController,
  editLocationController,
  deleteLocationController,
  changeLocaleController,
} = require("./user.controller");
const { validate } = require("../../core/middlewares/validate.middleware.js");
const {
  attachCardValidator,
  topupWalletValidator,
  saveLocationValidator,
  deleteAccountValidator,
  updateLocationOrderValidator,
} = require("./dto/user.validators.js");

router.get("/me", protectRouteMiddleware, catchAsync(getUserProfileController));

router.patch(
  "/edit/me",
  protectRouteMiddleware,
  upload.single("file"),
  catchAsync(editUserProfileController),
);

router.post(
  "/attach-card",
  protectRouteMiddleware,
  validate(attachCardValidator),
  catchAsync(attachCardController),
);

router.post(
  "/topup-wallet",
  protectRouteMiddleware,
  validate(topupWalletValidator),
  catchAsync(topupWalletController),
);

router.get(
  "/transaction-history",
  protectRouteMiddleware,
  catchAsync(transactionHistoryController),
);

router.get(
  "/cards-list",
  protectRouteMiddleware,
  catchAsync(cardsListController),
);

router.post(
  "/card/:card/set-as-default",
  protectRouteMiddleware,
  catchAsync(setCardAsDefaultController),
);

router.post(
  "/card/:card/remove",
  protectRouteMiddleware,
  catchAsync(removeCardController),
);

router.post(
  "/locations/save",
  protectRouteMiddleware,
  validate(saveLocationValidator),
  catchAsync(saveLocationController),
);

router.patch(
  "/locations/re-order",
  protectRouteMiddleware,
  validate(updateLocationOrderValidator),
  catchAsync(updateLocationOrderController),
);

router.patch(
  "/locations/:id",
  protectRouteMiddleware,
  catchAsync(editLocationController),
);

router.delete(
  "/locations/:id",
  protectRouteMiddleware,
  catchAsync(deleteLocationController),
);

router.get(
  "/locations",
  protectRouteMiddleware,
  catchAsync(myLocationsController),
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

module.exports = {
  path: "/user",
  router: router,
};
