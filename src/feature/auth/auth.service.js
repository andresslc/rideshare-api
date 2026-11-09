const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const admin = require("../../core/services/firebase/index");
const LoggedDeviceModel = require("./models/logged.device.model");
const {
  checkVerification,
} = require("../../core/services/sms/twilio-verify.service");
const {
  AppError,
  BadRequestError,
  ForbiddenError,
} = require("../../core/common/exceptions");
const UserModel = require("../user/models/user.model");
const {
  sendAndSaveNotification,
  saveNotification,
} = require("../notification/notification.service");
const {
  generateToken,
  secondsToWords,
  formatFullName,
  getRequestLocale,
  normalizeLocale,
  t,
} = require("../../core/common/helpers");
const SignupModel = require("./models/signup.model");
const DriverModel = require("../driver/models/driver.model");
const DocumentsModel = require("../driver/models/documents.model");
const VehicleModel = require("../driver/models/vehicle.model");
const env = require("../../../config/index");
const storageService = require("../../core/services/storage/storage.service");
const stripeService = require("../../core/services/stripe/stripe.service");
const { isDriverSuspended } = require("../ride/ride.service");
const {
  ensureDriverReferralCode,
  saveReferralCodeForRider,
} = require("../driver-referral/driver-referral.service");
const mongoose = require("mongoose");
const VehicleTypeModel = require("../admin/model/vehicle-type.model");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
// VERIFF DISABLED: Do not send driver data or documents to Veriff.
// const {
//   createVeriffSession,
//   uploadVeriffMedia,
//   submitVeriffSession,
// } = require("../../core/services/veriff.service");
const { getDriverGateKey } = require("./driver-gate.helper");

const resolveAuthLocale = async (body, req) => {
  const requestedLocale = getRequestLocale(req, null);
  if (requestedLocale) return requestedLocale;

  const { phone, role } = body;
  if (!phone || !["user", "driver"].includes(role)) return "en";

  const signupRecord = await SignupModel.findOne({
    phone,
    role,
    isDeleted: false,
  }).select("_id isOnboarded");

  if (!signupRecord?.isOnboarded) return "en";

  const Model = role === "driver" ? DriverModel : UserModel;
  const account = await Model.findOne({
    signUpRecord: signupRecord._id,
  }).select("locale");

  return normalizeLocale(account?.locale);
};

const signup = async (body) => {
  const { phone, role, locale: requestedLocale } = body;
  const existingUser = await SignupModel.findOne({
    phone,
    role,
    isDeleted: false,
  });

  if (!existingUser) {
    const signupRecord = await SignupModel.create({ phone, role });
    return signupRecord;
  }

  if (existingUser.isDeactivatedByAdmin) {
    throw new ForbiddenError(
      "Your account has been deactivated by admin. Please contact support.",
    );
  }

  if (role === "driver" && existingUser.isOnboarded) {
    const driver = await DriverModel.findOne({
      signUpRecord: existingUser._id,
    }).select("_id locale");
    if (!driver) return existingUser;

    const { suspended, remainingTime, reason } = await isDriverSuspended(
      driver._id,
    );

    if (suspended) {
      const locale = normalizeLocale(requestedLocale || driver.locale);
      const suspensionMessage =
        reason === "ride_cancellations"
          ? t("DRIVER_SUSPENDED_CANCELLATIONS", locale)
              .replace("${count}", REDIS_CONSTANTS.MAX_CANCELLATIONS)
              .replace("${duration}", secondsToWords(remainingTime, locale))
          : t("DRIVER_SUSPENDED_ADMIN", locale).replace(
              "${duration}",
              secondsToWords(remainingTime, locale),
            );

      throw new ForbiddenError(suspensionMessage);
    }
  }
  return existingUser;
};

const DRIVER_PORTAL_URL = env.FRONTEND_URL;

const localizedDriverGateText = (key) => ({
  en: t(key, "en"),
  es: t(key, "es"),
});

const DRIVER_GATE_CONFIGS = {
  incomplete: {
    severity: "warning",
    icon: "document",
    title: localizedDriverGateText("DRIVER_GATE_INCOMPLETE_TITLE"),
    description: localizedDriverGateText("DRIVER_GATE_INCOMPLETE_DESC"),
    secondaryDescription: localizedDriverGateText(
      "DRIVER_GATE_INCOMPLETE_SECONDARY_DESC",
    ),
    actions: [
      {
        id: "visit_portal",
        style: "link",
        type: "openExternal",
        label: localizedDriverGateText("DRIVER_GATE_INCOMPLETE_ACTION"),
        url: DRIVER_PORTAL_URL,
      },
    ],
  },
  subscription_not_purchased: {
    severity: "warning",
    icon: "credit_card",
    title: localizedDriverGateText(
      "DRIVER_GATE_SUBSCRIPTION_NOT_PURCHASED_TITLE",
    ),
    description: localizedDriverGateText(
      "DRIVER_GATE_SUBSCRIPTION_NOT_PURCHASED_DESC",
    ),
    secondaryDescription: localizedDriverGateText(
      "DRIVER_GATE_SUBSCRIPTION_NOT_PURCHASED_SECONDARY_DESC",
    ),
    actions: [
      {
        id: "visit_portal",
        style: "link",
        type: "openExternal",
        label: localizedDriverGateText(
          "DRIVER_GATE_SUBSCRIPTION_NOT_PURCHASED_ACTION",
        ),
        url: DRIVER_PORTAL_URL,
      },
    ],
  },
  inactive: {
    severity: "warning",
    icon: "credit_card",
    title: localizedDriverGateText("DRIVER_GATE_INACTIVE_TITLE"),
    description: localizedDriverGateText("DRIVER_GATE_INACTIVE_DESC"),
    secondaryDescription: localizedDriverGateText(
      "DRIVER_GATE_INACTIVE_SECONDARY_DESC",
    ),
    actions: [
      {
        id: "visit_portal",
        style: "link",
        type: "openExternal",
        label: localizedDriverGateText("DRIVER_GATE_INACTIVE_ACTION"),
        url: DRIVER_PORTAL_URL,
      },
    ],
  },
  rejected: {
    severity: "error",
    icon: "x_circle",
    title: localizedDriverGateText("DRIVER_GATE_REJECTED_TITLE"),
    description: localizedDriverGateText("DRIVER_GATE_REJECTED_DESC"),
    secondaryDescription: localizedDriverGateText(
      "DRIVER_GATE_REJECTED_SECONDARY_DESC",
    ),
    actions: [
      {
        id: "visit_portal",
        style: "link",
        type: "openExternal",
        label: localizedDriverGateText("DRIVER_GATE_REJECTED_ACTION"),
        url: DRIVER_PORTAL_URL,
      },
    ],
  },
  under_review: {
    severity: "warning",
    icon: "hourglass",
    title: localizedDriverGateText("DRIVER_GATE_UNDER_REVIEW_TITLE"),
    description: localizedDriverGateText("DRIVER_GATE_UNDER_REVIEW_DESC"),
    secondaryDescription: localizedDriverGateText(
      "DRIVER_GATE_UNDER_REVIEW_SECONDARY_DESC",
    ),
    actions: [
      {
        id: "visit_portal",
        style: "link",
        type: "openExternal",
        label: localizedDriverGateText("DRIVER_GATE_UNDER_REVIEW_ACTION"),
        url: DRIVER_PORTAL_URL,
      },
    ],
  },
};

const getDriverGate = (accountStatus, subscription) => {
  const gateKey = getDriverGateKey(accountStatus, subscription);
  return gateKey ? DRIVER_GATE_CONFIGS[gateKey] : null;
};

const verifyPhoneOTP = async (body, req) => {
  const { phone, otp, role, fcmToken } = body;
  const locale = await resolveAuthLocale(body, req);
  const deviceuniqueid = req.headers.deviceuniqueid || crypto.randomUUID();
  const devicemodel = req.headers.devicemodel;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers["user-agent"];

  const isNonProd = ["development", "staging", "production"].includes(
    env.NODE_ENV,
  );

  const isValid =
    (isNonProd && otp === env.TEST_OTP) ||
    (await verifyOTPControllerHelper(phone, otp));

  if (!isValid) throw new BadRequestError(t("INVALID_OTP", locale));

  const user = await SignupModel.findOne({ phone, isDeleted: false, role });

  if (!user)
    throw new BadRequestError("User not found or may have been deleted.");

  if (user.isDeactivatedByAdmin)
    throw new ForbiddenError(
      "Your account has been deactivated by admin. Please contact support.",
    );

  if (user.isOnboarded && user.role === "user") {
    const fullUser = await UserModel.findOne({ signUpRecord: user._id });

    await LoggedDeviceModel.findOneAndDelete({
      deviceIdentity: deviceuniqueid,
    });

    await LoggedDeviceModel.deleteMany({
      user: fullUser._id,
    });

    const loggedDevice = await LoggedDeviceModel.create({
      user: fullUser._id,
      userType: "User",
      deviceIdentity: deviceuniqueid,
      deviceModel: devicemodel,
      ipAddress: ip,
      userAgent,
      fcmToken,
    });

    return {
      isOnboarded: true,
      token: generateToken({
        id: fullUser._id,
        role: "user",
        loggedId: loggedDevice._id,
      }),
      user: { ...fullUser.toObject(), role: "user" },
    };
  }
  if (user.role === "driver") {
    const driver = await DriverModel.findOne({
      signUpRecord: user._id,
    })
      .populate({ path: "driverLicense" })
      .populate({ path: "vehicleRegistration" })
      .populate({ path: "insurance" })
      .populate({ path: "vehicleDetails" })
      .populate({ path: "subscription" });

    if (!driver) {
      return {
        isOnboarded: false,
        token: null,
        user: null,
        accountStatus: "incomplete",
        driverGate: DRIVER_GATE_CONFIGS.incomplete,
      };
    }

    const requiredDocs = [
      { key: "driverLicense", doc: driver.driverLicense },
      { key: "vehicleRegistration", doc: driver.vehicleRegistration },
      { key: "insurance", doc: driver.insurance },
      { key: "vehicleDetails", doc: driver.vehicleDetails },
    ];

    const approvedDocuments = [];
    const pendingDocuments = [];
    const rejectedDocuments = [];
    const missingDocuments = [];

    for (const { key, doc } of requiredDocs) {
      if (!doc) {
        missingDocuments.push(key);
        continue;
      }

      if (doc.status === "approved") {
        approvedDocuments.push(key);
      } else if (doc.status === "pending") {
        pendingDocuments.push(key);
      } else if (doc.status === "rejected") {
        rejectedDocuments.push({
          key,
          rejectReason: doc.rejectReason || "No reason provided",
          doc,
        });
      }
    }

    let stepToComplete = null;

    if (missingDocuments.length) {
      stepToComplete = missingDocuments[0];
    } else if (rejectedDocuments.length) {
      stepToComplete = rejectedDocuments[0].key;
    }

    const isOnboarded = approvedDocuments.length === requiredDocs.length;

    let accountStatus = "incomplete";

    if (missingDocuments.length > 0) {
      accountStatus = "incomplete";
    } else if (rejectedDocuments.length > 0) {
      accountStatus = "rejected";
    } else if (pendingDocuments.length > 0) {
      accountStatus = "pending";
    } else if (isOnboarded) {
      accountStatus = "approved";
    }

    const driverGate = getDriverGate(accountStatus, driver.subscription);

    if (isOnboarded) {
      await SignupModel.findByIdAndUpdate(user._id, {
        isOnboarded: true,
      });

      await LoggedDeviceModel.findOneAndDelete({
        deviceIdentity: deviceuniqueid,
      });

      await LoggedDeviceModel.deleteMany({
        user: driver._id,
      });

      const loggedDevice = await LoggedDeviceModel.create({
        user: driver._id,
        userType: "Driver",
        deviceIdentity: deviceuniqueid,
        deviceModel: devicemodel,
        ipAddress: ip,
        userAgent,
        fcmToken,
      });

      return {
        isOnboarded,
        token: generateToken({
          id: driver._id,
          role: "driver",
          loggedId: loggedDevice._id,
        }),
        user: {
          ...driver.toObject(),
          subscription: driver.subscription || { status: "inactive" },
          role: "driver",
          accountStatus,
          ...(driverGate && { driverGate }),
          pendingDocuments,
          stepToComplete,
        },
        stepToComplete: null,
        approvedDocuments,
        pendingDocuments,
        rejectedDocuments,
      };
    }

    return {
      isOnboarded: true,
      token: null,
      user: {
        ...driver.toObject(),
        subscription: driver.subscription || { status: "inactive" },
        role: "driver",
        accountStatus,
        ...(driverGate && { driverGate }),
        pendingDocuments,
        stepToComplete,
      },
      stepToComplete,
      approvedDocuments,
      pendingDocuments,
      rejectedDocuments,
    };
  }

  return {
    isOnboarded: false,
    token: null,
    user: null,
  };
};

const verifyPhoneOTPWeb = async (body, req) => {
  const { phone, otp, role, fcmToken } = body;
  const locale = await resolveAuthLocale(body, req);
  const deviceuniqueid = req.headers.deviceuniqueid || crypto.randomUUID();
  const devicemodel = req.headers.devicemodel;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers["user-agent"];

  const isNonProd = ["development", "staging", "production"].includes(
    env.NODE_ENV,
  );

  const isValid =
    (isNonProd && otp === env.TEST_OTP) ||
    (await verifyOTPControllerHelper(phone, otp));

  if (!isValid) throw new BadRequestError(t("INVALID_OTP", locale));

  const user = await SignupModel.findOne({ phone, isDeleted: false, role });

  if (!user)
    throw new BadRequestError("User not found or may have been deleted.");

  if (user.isDeactivatedByAdmin)
    throw new ForbiddenError(
      "Your account has been deactivated by admin. Please contact support.",
    );

  if (user.role === "driver") {
    const driver = await DriverModel.findOne({
      signUpRecord: user._id,
    })
      .populate({ path: "driverLicense" })
      .populate({ path: "vehicleRegistration" })
      .populate({ path: "insurance" })
      .populate({ path: "vehicleDetails" })
      .populate({ path: "subscription" });

    if (!driver) {
      return {
        isOnboarded: false,
        token: null,
        user: null,
        accountStatus: "incomplete",
        driverGate: DRIVER_GATE_CONFIGS.incomplete,
      };
    }

    const requiredDocs = [
      { key: "driverLicense", doc: driver.driverLicense },
      { key: "vehicleRegistration", doc: driver.vehicleRegistration },
      { key: "insurance", doc: driver.insurance },
      { key: "vehicleDetails", doc: driver.vehicleDetails },
    ];

    const approvedDocuments = [];
    const pendingDocuments = [];
    const rejectedDocuments = [];
    const missingDocuments = [];

    for (const { key, doc } of requiredDocs) {
      if (!doc) {
        missingDocuments.push(key);
        continue;
      }

      if (doc.status === "approved") {
        approvedDocuments.push(key);
      } else if (doc.status === "pending") {
        pendingDocuments.push(key);
      } else if (doc.status === "rejected") {
        rejectedDocuments.push({
          key,
          rejectReason: doc.rejectReason || "No reason provided",
          doc,
        });
      }
    }

    let stepToComplete = null;

    if (missingDocuments.length) {
      stepToComplete = missingDocuments[0];
    } else if (rejectedDocuments.length) {
      stepToComplete = rejectedDocuments[0].key;
    }

    const isOnboarded = approvedDocuments.length === requiredDocs.length;

    let accountStatus = "incomplete";

    if (missingDocuments.length > 0) {
      accountStatus = "incomplete";
    } else if (rejectedDocuments.length > 0) {
      accountStatus = "rejected";
    } else if (pendingDocuments.length > 0) {
      accountStatus = "pending";
    } else if (isOnboarded) {
      accountStatus = "approved";
    }

    const driverGate = getDriverGate(accountStatus, driver.subscription);

    await SignupModel.findByIdAndUpdate(user._id, {
      isOnboarded: true,
    });

    await LoggedDeviceModel.findOneAndDelete({
      deviceIdentity: deviceuniqueid,
    });

    await LoggedDeviceModel.deleteMany({
      user: driver._id,
    });

    const loggedDevice = await LoggedDeviceModel.create({
      user: driver._id,
      userType: "Driver",
      deviceIdentity: deviceuniqueid,
      deviceModel: devicemodel,
      ipAddress: ip,
      userAgent,
      fcmToken,
    });

    return {
      isOnboarded: true,
      token: generateToken({
        id: driver._id,
        role: "driver",
        loggedId: loggedDevice._id,
      }),
      user: {
        ...driver.toObject(),
        subscription: driver.subscription || { status: "inactive" },
        role: "driver",
        accountStatus,
        ...(driverGate && { driverGate }),
        pendingDocuments,
        stepToComplete,
      },
      stepToComplete: null,
      approvedDocuments,
      pendingDocuments,
      rejectedDocuments,
    };
  }

  return {
    isOnboarded: false,
    token: null,
    user: null,
  };
};

const onboardService = async (body, req) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    role,
    fcmToken,
    referredBy,
    referralCode,
    ssn,
    dob,
    address,
    state,
    city,
  } = body;
  const deviceuniqueid = req.headers.deviceuniqueid || crypto.randomUUID();
  const devicemodel = req.headers.devicemodel;
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers["user-agent"];

  if (!["user", "driver"].includes(role)) {
    throw new BadRequestError("Invalid role provided.");
  }

  const session = await SignupModel.startSession();
  session.startTransaction();

  try {
    const signupRecord = await SignupModel.findOne({
      phone,
      role,
      isDeleted: false,
    }).session(session);

    if (!signupRecord) {
      throw new BadRequestError(
        "Signup record not found. Please signup first.",
      );
    }

    if (signupRecord.isDeactivatedByAdmin) {
      throw new ForbiddenError(
        "Your account has been deactivated by admin. Please contact support.",
      );
    }

    if (signupRecord.isOnboarded && role === "user") {
      throw new BadRequestError("User already onboarded. Please login.");
    }

    const profilePicture = req.file
      ? (await storageService.upload(req.file)).location
      : null;

    const stripeCustomer = await stripeService.createCustomer({
      email,
      name: formatFullName({ firstName, lastName }),
    });

    const modelMap = {
      user: UserModel,
      driver: DriverModel,
    };

    const Model = modelMap[role];

    let referredByDriverId = null;
    if (role === "driver" && referredBy) {
      if (mongoose.Types.ObjectId.isValid(referredBy)) {
        const referrer = await DriverModel.findById(referredBy)
          .select("_id")
          .session(session);
        if (referrer) {
          referredByDriverId = referrer._id;
        }
      }
    }

    if (role === "driver") {
      const existingDriver = await DriverModel.findOne({
        signUpRecord: signupRecord._id,
      }).session(session);

      if (existingDriver) {
        throw new BadRequestError("Driver profile is already completed.");
      }
    }

    const user = await Model.create(
      [
        {
          signUpRecord: signupRecord._id,
          firstName,
          lastName,
          email,
          phone,
          profilePicture,
          stripeCustomerId: stripeCustomer.id,
          address,
          state,
          city,
          ...(role === "user" && { dob }),
          ...(role === "driver" &&
            referredByDriverId && { referredBy: referredByDriverId }),
          ...(role === "driver" && { ssn }),
        },
      ],
      { session },
    );

    if (role === "driver") {
      const createdDriver = user[0];
      const url = new URL(env.FRONTEND_URL);
      url.searchParams.set("referredBy", createdDriver._id.toString());

      await DriverModel.findByIdAndUpdate(
        createdDriver._id,
        {
          referralLink: url.toString(),
          ...(referredByDriverId &&
            referredByDriverId.toString() === createdDriver._id.toString() && {
              referredBy: null,
            }),
        },
        { session },
      );
    }

    if (role === "user") {
      signupRecord.isOnboarded = true;
      await signupRecord.save({ session });
    }

    await session.commitTransaction();

    // Driver referral codes, both done after the commit so neither can undo a
    // signup. A driver without a code gets one lazily from "My referral code";
    // a rider whose code is refused is told so and can enter it again later.
    let referral = null;

    if (role === "driver") {
      try {
        await ensureDriverReferralCode(user[0]._id);
      } catch (error) {
        console.error(
          "[DRIVER-REFERRAL] code not assigned at onboarding:",
          error?.message || error,
        );
      }
    }

    if (role === "user" && referralCode) {
      const locale = normalizeLocale(getRequestLocale(req));

      try {
        await saveReferralCodeForRider({
          riderId: user[0]._id,
          code: referralCode,
          locale,
        });
        referral = { saved: true };
      } catch (error) {
        referral = { saved: false, message: error.message };
      }
    }

    // VERIFF DISABLED: Do not create a session or send the driver's profile
    // image to Veriff during onboarding.
    // if (role === "driver") {
    //   const createdDriver = user?.[0];
    //
    //   if (createdDriver?._id && !createdDriver?.veriffSessionId) {
    //     try {
    //       const veriffSessionId = await createVeriffSession(createdDriver);
    //
    //       if (veriffSessionId) {
    //         await DriverModel.findByIdAndUpdate(createdDriver._id, {
    //           veriffSessionId,
    //         });
    //
    //         const profileImage = await uploadVeriffMedia(
    //           veriffSessionId,
    //           createdDriver.profilePicture,
    //           "face",
    //         );
    //
    //         if (!profileImage) {
    //           throw new BadRequestError("Veriff profile image upload failed.");
    //         }
    //       }
    //     } catch (err) {
    //       console.error(
    //         "[Veriff] Failed creating session during onboarding:",
    //         err?.message || err,
    //       );
    //     }
    //   }
    // }

    await LoggedDeviceModel.findOneAndDelete({
      deviceIdentity: deviceuniqueid,
    });

    const loggedDevice = await LoggedDeviceModel.create({
      user: user[0]._id,
      userType: role === "driver" ? "Driver" : "User",
      deviceIdentity: deviceuniqueid,
      deviceModel: devicemodel,
      ipAddress: ip,
      userAgent,
      fcmToken,
    });

    const token = generateToken({
      id: user[0]._id,
      role,
      loggedId: loggedDevice._id,
    });

    return {
      ...(token && { token }),
      user: { ...user[0].toObject(), role },
      ...(referral && { referral }),
    };
  } catch (error) {
    console.log("ERRR", JSON.stringify(error, null, 2));
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const uploadDocumentService = async (userId, body, files, step) => {
  const steps = {
    1: "driverLicense",
    2: "vehicleRegistration",
    3: "insurance",
    4: "vehicleDetails",
  };

  const documentType = steps[step];

  if (!documentType) {
    throw new BadRequestError("Invalid step provided for document upload.");
  }

  let uploadedFiles = [];

  if (documentType !== "vehicleDetails") {
    const existingDoc = await DocumentsModel.findOne({
      driver: userId,
      type: documentType,
    }).sort({ createdAt: -1 });

    if (existingDoc) {
      if (existingDoc.status === "pending") {
        throw new BadRequestError(
          `${documentType} already submitted and pending approval.`,
        );
      }

      if (existingDoc.status === "approved") {
        throw new BadRequestError(
          `${documentType} already approved. Cannot resubmit.`,
        );
      }
    }
  } else {
    const existingVehicle = await VehicleModel.findOne({
      driver: userId,
      isDeleted: false,
    });

    if (existingVehicle) {
      if (existingVehicle.status === "pending") {
        throw new BadRequestError(
          `${documentType} already submitted and pending approval.`,
        );
      }

      if (existingVehicle.status === "approved") {
        throw new BadRequestError(
          `${documentType} already approved. Cannot resubmit.`,
        );
      }
    }
  }

  if (files && files.length > 0) {
    uploadedFiles = await Promise.all(
      files.map(async (file) => {
        const { location } = await storageService.upload(file);
        return location;
      }),
    );
  }

  let payload = {
    type: documentType,
    driver: userId,
    status: "pending",
  };

  switch (documentType) {
    case "driverLicense": {
      const { expiryDate, licenseNumber } = body;

      if (uploadedFiles.length < 2) {
        throw new BadRequestError(
          "Driver license requires front and back images.",
        );
      }

      payload.frontImage = uploadedFiles[0];
      payload.backImage = uploadedFiles[1];
      payload.metadata = { expiryDate, licenseNumber };

      // VERIFF DISABLED: Do not create a Veriff session, upload the profile or
      // license images, or submit the session. Documents remain stored locally.
      // const driver = await DriverModel.findById(userId).select(
      //   "veriffSessionId firstName lastName profilePicture",
      // );
      //
      // let sessionId = await createVeriffSession(
      //   driver || {
      //     firstName: body?.firstName,
      //     lastName: body?.lastName,
      //   },
      // );
      // if (sessionId) {
      //   await DriverModel.findByIdAndUpdate(userId, {
      //     veriffSessionId: sessionId,
      //   });
      //
      //   const profileImage = await uploadVeriffMedia(
      //     sessionId,
      //     driver.profilePicture,
      //     "face",
      //   );
      //
      //   if (!profileImage) {
      //     throw new BadRequestError("Veriff profile image upload failed.");
      //   }
      // }
      //
      // if (!sessionId) {
      //   throw new BadRequestError(
      //     "Veriff session is not available for driver license upload.",
      //   );
      // }
      //
      // const frontResult = await uploadVeriffMedia(
      //   sessionId,
      //   payload.frontImage,
      //   "document-front",
      // );
      // if (!frontResult) {
      //   throw new BadRequestError("Veriff front image upload failed.");
      // }
      //
      // const backResult = await uploadVeriffMedia(
      //   sessionId,
      //   payload.backImage,
      //   "document-back",
      // );
      // if (!backResult) {
      //   throw new BadRequestError("Veriff back image upload failed.");
      // }
      //
      // const submitResult = await submitVeriffSession(sessionId);
      // if (!submitResult) {
      //   throw new BadRequestError("Veriff session submission failed.");
      // }
      //
      // payload.veriffSessionId = sessionId;
      // payload.veriffLastSubmittedAt = new Date();
      payload.rejectReason = null;
      payload.rejectionReason = null;
      break;
    }

    case "insurance": {
      if (uploadedFiles.length < 2) {
        throw new BadRequestError("Insurance requires at least two images.");
      }

      payload.frontImage = uploadedFiles[0];
      payload.backImage = uploadedFiles[1];
      break;
    }

    case "vehicleRegistration": {
      if (uploadedFiles.length < 1) {
        throw new BadRequestError("Vehicle registration requires front image.");
      }

      payload.frontImage = uploadedFiles[0];
      break;
    }

    case "vehicleDetails": {
      payload.metadata = body || {};

      const vehicle = await VehicleModel.findOne({
        driver: { $ne: userId },
        status: "approved",
        isDeleted: false,

        vehicleIdentificationNumber:
          payload.metadata.vehicleIdentificationNumber,
      });

      if (vehicle) {
        throw new BadRequestError(
          "A vehicle with the same VIN or registration number has already been approved.",
        );
      }
      break;
    }

    default:
      throw new BadRequestError("Unsupported document type.");
  }
  let documentRecord;

  // VERIFF DISABLED: Keep the session-based upsert for possible future reuse,
  // but save driver licenses through the normal document path for now.
  // if (documentType === "driverLicense") {
  //   const sessionId = payload.veriffSessionId;
  //   documentRecord = await DocumentsModel.findOneAndUpdate(
  //     { driver: userId, type: documentType, veriffSessionId: sessionId },
  //     {
  //       $set: {
  //         ...payload,
  //         status: "pending",
  //         rejectReason: null,
  //         rejectionReason: null,
  //       },
  //     },
  //     { upsert: true, new: true },
  //   );
  // }

  if (documentType === "vehicleDetails") {
    documentRecord = await VehicleModel.create({
      ...payload.metadata,
      driver: userId,
    });
  } else {
    documentRecord = await DocumentsModel.create(payload);
  }

  let rideType = null;
  if (documentType === "vehicleDetails") {
    const submittedVehicleType = documentRecord?.vehicleType
      ?.toLowerCase()
      ?.trim();

    let vehicleTypeDoc = await VehicleTypeModel.findOne({
      model: submittedVehicleType,
      isActive: true,
    });

    if (!vehicleTypeDoc) {
      vehicleTypeDoc = await VehicleTypeModel.findOne({
        model: null,
        isActive: true,
      });
    }

    rideType = vehicleTypeDoc?.rideType || "economy";
  }

  await DriverModel.findByIdAndUpdate(userId, {
    [documentType]: documentRecord._id,
    ...(documentType === "vehicleDetails" && {
      vehicleType: rideType,
    }),
  });

  const messages = {
    driverLicense: "Driver license uploaded and pending approval.",
    vehicleRegistration: "Vehicle registration uploaded and pending approval.",
    insurance: "Insurance document uploaded and pending approval.",
    vehicleDetails: "Vehicle details uploaded and pending approval.",
  };

  const label = documentType
    .replace(/([A-Z])/g, " $1") // "vehicleRegistration" → "vehicle Registration"
    .replace(/^./, (c) => c.toUpperCase()) // → "Vehicle Registration"
    .trim();

  saveNotification({
    title: "Approval Required",
    description: `A new ${label} document has been submitted for approval.`,
    metadata: {
      id: userId,
      type: "user",
    },
    userIds: [],
    role: "Admin",
  });

  return {
    message: messages[documentType],
    document: documentRecord,
  };
};

const respondToDocs = async (documents) => {
  const bulkOps = documents.map((doc) => ({
    updateOne: {
      filter: { _id: doc.id },
      update: {
        status: doc.status,
        rejectReason: doc.status === "rejected" ? doc.rejectReason : null,
      },
    },
  }));

  await Promise.all([
    DocumentsModel.bulkWrite(bulkOps),
    VehicleModel.bulkWrite(bulkOps),
  ]);

  return {
    message: "Documents have been processed successfully.",
  };
};

const getAccountStatus = async (driverId) => {
  const driver = await DriverModel.findOne({ _id: driverId })
    .populate({ path: "driverLicense" })
    .populate({ path: "vehicleRegistration" })
    .populate({ path: "insurance" })
    .populate({ path: "vehicleDetails" })
    .populate({ path: "subscription" });

  if (!driver) {
    return { accountStatus: "incomplete" };
  }

  const requiredDocs = [
    { key: "driverLicense", doc: driver.driverLicense },
    { key: "vehicleRegistration", doc: driver.vehicleRegistration },
    { key: "insurance", doc: driver.insurance },
    { key: "vehicleDetails", doc: driver.vehicleDetails },
  ];

  const approvedDocuments = [];
  const pendingDocuments = [];
  const rejectedDocuments = [];
  const missingDocuments = [];

  for (const { key, doc } of requiredDocs) {
    if (!doc) {
      missingDocuments.push(key);
      continue;
    }

    if (doc.status === "approved") {
      approvedDocuments.push(key);
    } else if (doc.status === "pending") {
      pendingDocuments.push(key);
    } else if (doc.status === "rejected") {
      rejectedDocuments.push({
        key,
        rejectReason: doc.rejectReason || "No reason provided",
        doc,
      });
    }
  }

  let stepToComplete = null;

  if (missingDocuments.length) {
    stepToComplete = missingDocuments[0];
  } else if (rejectedDocuments.length) {
    stepToComplete = rejectedDocuments[0].key;
  }

  const isOnboarded = true;

  let accountStatus = "incomplete";

  if (missingDocuments.length > 0) {
    accountStatus = "incomplete";
  } else if (rejectedDocuments.length > 0) {
    accountStatus = "rejected";
  } else if (pendingDocuments.length > 0) {
    accountStatus = "pending";
  } else if (isOnboarded) {
    accountStatus = "approved";
  }

  return {
    data: {
      user: driver,
      accountStatus,
      isOnboarded,
      stepToComplete,
      approvedDocuments,
      pendingDocuments,
      rejectedDocuments,
      missingDocuments,
    },
  };
};

const logout = async (id) => {
  await LoggedDeviceModel.findByIdAndDelete(id);

  return {
    message: "Logout successful",
  };
};

const updateFcmToken = async (id, token) => {
  const loggedDevice = await LoggedDeviceModel.findByIdAndUpdate(id, {
    fcmToken: token,
  });

  return {
    success: true,
    message: "FCM Token updated successfully",
  };
};

// common
const verifySocialToken = async (method, idToken) => {
  if (!["google", "apple"].includes(method)) return {};

  if (!idToken) {
    throw new AppError("idToken is required for social login", 400);
  }

  const decoded = await admin.auth().verifyIdToken(idToken);

  const rawName = (decoded.name || "").trim();
  const nameParts = rawName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || "app";
  const lastName = nameParts.slice(1).join(" ") || "user";

  return {
    uid: decoded.uid,
    email: decoded.email,
    firstName,
    lastName,
    isEmailVerified: true,
  };
};

const logDevice = async ({
  userId,
  deviceuniqueid,
  devicemodel,
  ip,
  userAgent,
}) => {
  const deviceIdentity = deviceuniqueid || crypto.randomUUID();

  await LoggedDeviceModel.findOneAndDelete({
    deviceIdentity,
  });

  return LoggedDeviceModel.create({
    user: userId,
    deviceIdentity,
    deviceModel: devicemodel,
    ipAddress: ip,
    userAgent,
  });
};

const verifyOTPControllerHelper = async (phone, otp) => {
  try {
    return await checkVerification(phone, otp);
  } catch (error) {
    console.log("Twilio OTP verification failed:", error?.message || error);
    throw new BadRequestError("Invalid OTP, please try again.");
  }
};

module.exports = {
  signup,
  resolveAuthLocale,
  verifySocialToken,
  logDevice,
  verifyOTPControllerHelper,
  verifyPhoneOTP,
  onboardService,
  uploadDocumentService,
  respondToDocs,
  logout,
  updateFcmToken,
  getAccountStatus,
  verifyPhoneOTPWeb,
};
