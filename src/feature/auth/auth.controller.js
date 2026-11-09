const { AppError } = require("../../core/common/exceptions.js");
const {
  sendVerification,
} = require("../../core/services/sms/twilio-verify.service.js");
const {
  signup,
  verifyPhoneOTP,
  onboardService,
  uploadDocumentService,
  respondToDocs,
  logout,
  updateFcmToken,
  getAccountStatus,
  resolveAuthLocale,
  verifyPhoneOTPWeb,
} = require("./auth.service.js");
const env = require("../../../config/index.js");
const { t } = require("../../core/common/helpers");

const verifyOTPController = async (req, res) => {
  const locale = await resolveAuthLocale(req.body, req);
  const result = await verifyPhoneOTP(req.body, req);

  return {
    success: true,
    message: result.isOnboarded
      ? t("OTP_VERIFIED_SUCCESS", locale)
      : t("OTP_VERIFIED_COMPLETE_ONBOARDING", locale),
    data: result,
  };
};

const verifyOTPControllerWeb = async (req, res) => {
  const locale = await resolveAuthLocale(req.body, req);
  const result = await verifyPhoneOTPWeb(req.body, req);

  return {
    success: true,
    message: result.isOnboarded
      ? t("OTP_VERIFIED_SUCCESS", locale)
      : t("OTP_VERIFIED_COMPLETE_ONBOARDING", locale),
    data: result,
  };
};

const sendPhoneVerificationOTPController = async (req, res) => {
  const locale = await resolveAuthLocale(req.body, req);
  await signup({ phone: req.body.phone, role: req.body.role, locale });

  if (env.NODE_ENV === "production") {
    try {
      await sendVerification(req.body.phone);
    } catch (error) {
      console.log("Twilio verification failed:", error?.message || error);
      if (Number(error?.code) === 60203) {
        throw new AppError(
          "You have reached max attempts. Try again in a few minutes.",
          429,
        );
      }
      throw new AppError("Invalid phone number", 400);
    }
  }

  return {
    message: t("OTP_SENT_TO_PHONE", locale),
  };
};

const onboardController = async (req, res) => {
  const {
    phone,
    email,
    firstName,
    lastName,
    fcmToken,
    referredBy,
    refferedBy,
    referralCode,
    ssn,
    dob,
    address,
    state,
    city,
  } = req.body;
  const role = req.params.role;

  const result = await onboardService(
    {
      phone,
      email,
      firstName,
      lastName,
      role,
      fcmToken,
      referredBy: referredBy || refferedBy || null,
      referralCode: referralCode || null,
      ssn,
      dob,
      address,
      state,
      city,
    },
    req,
  );

  return {
    success: true,
    message: "User's profile updated successfully",
    data: result,
  };
};

const uploadDocumentsController = async (req, res) => {
  const { userId } = req.params;
  const files = req.files;
  const step = req.query.step;
  const body = req.body;

  const result = await uploadDocumentService(userId, body, files, step);

  return {
    success: true,
    message: result.message,
    data: result,
  };
};

const respondToDocsController = async (req, res) => {
  const { documents } = req.body;

  const result = await respondToDocs(documents);

  return {
    success: true,
    data: result,
  };
};

const logoutController = async (req, res) => {
  const id = req.session.id;
  const session = await logout(id);

  return session;
};

const updateFcmTokenController = async (req, res) => {
  const id = req.session.id;
  const result = await updateFcmToken(id, req.body.fcmToken);

  return result;
};

const getAccountStatusController = async (req, res) => {
  const driverId = req.user.id || req.user._id;
  const result = await getAccountStatus(driverId);

  return result;
};

module.exports = {
  sendPhoneVerificationOTPController,
  verifyOTPController,
  verifyOTPControllerWeb,
  onboardController,
  uploadDocumentsController,
  respondToDocsController,
  logoutController,
  updateFcmTokenController,
  getAccountStatusController,
};
