const express = require("express");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const catchAsync = require("../../core/common/catch-async");
const {
  toggleNotificationController,
  retrieveNotificationController,
  sendNotificationToUser,
  clearAllNotificationsController,
  deleteSingleNotificationController,
} = require("./notification.controller");
const { validate } = require("../../core/middlewares/validate.middleware");
const { PaginationValidator } = require("../../core/common/global.validators");

const router = express.Router();

router.post(
  "/test",
  protectRouteMiddleware,
  catchAsync(sendNotificationToUser),
);

router.post(
  "/:role/toggle",
  protectRouteMiddleware,
  catchAsync(toggleNotificationController),
);

router.get(
  "/",
  protectRouteMiddleware,
  validate(PaginationValidator),
  catchAsync(retrieveNotificationController),
);

router.delete(
  "/",
  protectRouteMiddleware,
  catchAsync(clearAllNotificationsController),
);

router.delete(
  "/:notificationId",
  protectRouteMiddleware,
  catchAsync(deleteSingleNotificationController),
);

module.exports = {
  path: "/notification",
  router: router,
};
