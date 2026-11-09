const express = require("express");
const router = express.Router();

const {
  sendPhoneVerificationOTPController,
  verifyOTPController,
  onboardController,
  uploadDocumentsController,
  respondToDocsController,
  logoutController,
  updateFcmTokenController,
  getAccountStatusController,
  verifyOTPControllerWeb,
} = require("./auth.controller");

const {
  SendOtpValidator,
  verifyPhoneOTP,
  OnboardUserValidator,
  RespondToDocsValidator,
  updateFCMTokenControllerValidator,
} = require("./dto/auth.validators");

const { validate } = require("../../core/middlewares/validate.middleware.js");
const catchAsync = require("../../core/common/catch-async.js");
const { createMulter } = require("../../core/common/helpers/index.js");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware.js");
const upload = createMulter();

router.post(
  "/send-otp",
  validate(SendOtpValidator),
  catchAsync(sendPhoneVerificationOTPController),
);

router.post(
  "/verify-otp-web",
  validate(verifyPhoneOTP),
  catchAsync(verifyOTPControllerWeb),
);

router.post(
  "/verify-otp",
  validate(verifyPhoneOTP),
  catchAsync(verifyOTPController),
);

router.get("/account-status/",  protectRouteMiddleware, catchAsync(getAccountStatusController));

router.post("/logout", protectRouteMiddleware, catchAsync(logoutController));

router.post(
  "/onboard/driver/:userId/documents",
  upload.array("files", 10),
  catchAsync(uploadDocumentsController),
);

router.post(
  "/onboard/:role",
  upload.single("file"),
  validate(OnboardUserValidator),
  catchAsync(onboardController),
);

router.post(
  "/documents/respond",
  validate(RespondToDocsValidator),
  catchAsync(respondToDocsController),
);

router.patch(
  "/update-fcm",
  validate(updateFCMTokenControllerValidator),
  catchAsync(updateFcmTokenController),
);

module.exports = {
  path: "/auth",
  router: router,
};
