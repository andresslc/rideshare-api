const DriverModel = require("./models/driver.model");
const stripeService = require("../../core/services/stripe/stripe.service");
const {
  BadRequestError,
  NotFoundError,
} = require("../../core/common/exceptions");
const BankModel = require("../bank/models/bank.model");
const TransactionModel = require("../transactions/model/transaction.model");
const {
  getWalletAllocation,
  transactionRewardFields,
} = require("../wallet/wallet.service");
const mongoose = require("mongoose");
const storageService = require("../../core/services/storage/storage.service");
const VehicleModel = require("./models/vehicle.model");
const SubscriptionModel = require("../subscription/models/subscription.model");
const DocumentsModel = require("./models/documents.model");
const { verifyOTPControllerHelper } = require("../auth/auth.service");
const env = require("../../../config/index");
const LoggedDeviceModel = require("../auth/models/logged.device.model");
const SignupModel = require("../auth/models/signup.model");
const RideModel = require("../ride/model/ride.model");
const {
  t,
  aggregatePaginate,
  capitalize,
} = require("../../core/common/helpers");
const ReviewModel = require("../reviews/models/review.model");
const VehicleTypeService = require("../admin/vehicle-type.service");
const CarpoolRouteModel = require("../carpool/model/carpool-route.model");
const {
  CARPOOL_STATUS_ENUM,
} = require("../../core/common/constants/carpool-constants");
// VERIFF DISABLED: Do not send driver data or documents to Veriff.
// const {
//   createVeriffSession,
//   uploadVeriffMedia,
//   submitVeriffSession,
// } = require("../../core/services/veriff.service");

const buildDriverAccountStatus = (driver) => {
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

  return {
    accountStatus,
    approvedDocuments,
    pendingDocuments,
    rejectedDocuments,
    missingDocuments,
    stepToComplete,
    isOnboarded,
  };
};

const setupConnectedAccout = async (driverId) => {
  const driver = await DriverModel.findById(driverId);

  if (!driver.stripeAccountId) {
    const accountId = await stripeService.createConnectedAccount(
      driver.email,
      "US",
    );

    driver.stripeAccountId = accountId;
    await driver.save();
  }

  const accountLink = await stripeService.createAccountLink(
    driver.stripeAccountId,
    driver.isStripeConnectOnboardingCompleted
      ? "account_onboarding"
      : "account_update",
    `${env.FRONTEND_URL}/complete-setup`,
    `${env.FRONTEND_URL}/complete-setup`,
  );

  return {
    data: {
      url: accountLink.url,
    },
  };
};

const attachBankAccount = async (driverId, token) => {
  const driver = await DriverModel.findById(driverId);

  if (!driver.stripeAccountId) {
    throw new BadRequestError(
      t("CREATE_STRIPE_CONNECTED_ACCOUNT", driver.locale),
    );
  }

  const externalAccount = await stripeService.addBankAccount({
    accountId: driver.stripeAccountId,
    token,
  });

  return externalAccount;
};

const deleteBankAccount = async (driverId, bankId) => {
  const driver = await DriverModel.findById(driverId);

  if (!driver) {
    throw new NotFoundError(t("DRIVER_NOT_FOUND"));
  }

  if (!driver.stripeAccountId) {
    throw new BadRequestError(
      t("CREATE_STRIPE_CONNECTED_ACCOUNT", driver.locale),
    );
  }

  const bank = await BankModel.findOne({
    bankId,
    driver: driverId,
  });

  if (!bank) {
    throw new BadRequestError(t("BANK_NOT_FOUND", driver.locale));
  }

  const wasSelected = bank.selected;

  await stripeService.removeBankAccount(driver.stripeAccountId, bankId);

  await BankModel.deleteOne({ bankId });

  if (wasSelected) {
    const nextBankAccount = await BankModel.findOne({ driver: driverId }).sort({
      createdAt: -1,
    });

    if (nextBankAccount) {
      nextBankAccount.selected = true;
      await nextBankAccount.save();

      await DriverModel.findByIdAndUpdate(driverId, {
        bank: nextBankAccount._id,
      });
    } else {
      await DriverModel.findByIdAndUpdate(driverId, {
        bank: null,
      });
    }
  }

  return {
    success: true,
    message: t("BANK_ACCOUNT_DELETED", driver.locale),
  };
};

const setDefaultBankAccount = async (driverId, bankId) => {
  const driver = await DriverModel.findById(driverId).lean();

  if (!driver) {
    throw new NotFoundError(t("DRIVER_NOT_FOUND"));
  }

  if (!driver.stripeAccountId) {
    throw new BadRequestError(
      t("CREATE_STRIPE_CONNECTED_ACCOUNT", driver.locale),
    );
  }

  const bank = await BankModel.findOne({ bankId: bankId, driver: driverId });

  if (!bank) {
    throw new NotFoundError(t("BANK_NOT_FOUND", driver.locale));
  }

  if (driver.bank?.toString() === bank?._id?.toString() && bank.selected) {
    return {
      success: true,
      message: t("DEFAULT_BANK_ACCOUNT_SET", driver.locale),
    };
  }

  const r = await stripeService.setDefaultBankAccount(
    driver.stripeAccountId,
    bank.bankId,
  );

  const [updatedBank] = await Promise.all([
    BankModel.findByIdAndUpdate(bank._id, { selected: true }, { new: true }),
    BankModel.updateMany(
      { _id: { $ne: bank._id }, driver: driverId, selected: true },
      { selected: false },
    ),
    DriverModel.findByIdAndUpdate(driverId, { bank: bank._id }),
  ]);

  if (!updatedBank) {
    throw new NotFoundError(t("BANK_NOT_FOUND", driver.locale));
  }

  return {
    success: true,
    message: t("DEFAULT_BANK_ACCOUNT_SET", driver.locale),
  };
};

const withdraw = async (body) => {
  const { driverId, amount, bankId } = body;

  const session = await mongoose.startSession();
  session.startTransaction();

  let driver;

  try {
    const currentDriver = await DriverModel.findOne({
      _id: driverId,
      isDeleted: false,
      isDeactivatedByAdmin: false,
    }).session(session);

    if (!currentDriver) {
      throw new NotFoundError(t("DRIVER_NOT_FOUND"));
    }

    const walletAllocation = getWalletAllocation(currentDriver, amount, {
      pendingBalance: currentDriver.pendingWithdrawalBalance,
      pendingRewardedBalance: currentDriver.pendingRewardedWithdrawalBalance,
    });

    if (!walletAllocation) {
      throw new BadRequestError(t("INSUFFICIENT_FUNDS", currentDriver.locale));
    }

    // Atomically verify the combined available balance and reserve it.
    driver = await DriverModel.findOneAndUpdate(
      {
        _id: driverId,
        isDeleted: false,
        isDeactivatedByAdmin: false,
        $expr: {
          $gte: [
            {
              $subtract: [
                { $add: ["$balance", { $ifNull: ["$rewardedBalance", 0] }] },
                "$pendingWithdrawalBalance",
              ],
            },
            amount,
          ],
        },
      },
      {
        $inc: {
          pendingWithdrawalBalance: amount,
          pendingRewardedWithdrawalBalance: walletAllocation.rewardedAmount,
        },
      },
      { new: true, session },
    );

    if (!driver) {
      // The document either doesn't exist or available balance was insufficient.
      // Check if the driver exists at all to return the right error.
      const exists = await DriverModel.exists({
        _id: driverId,
        isDeleted: false,
      });
      if (!exists) {
        throw new NotFoundError(t("DRIVER_NOT_FOUND"));
      }
      throw new BadRequestError(t("INSUFFICIENT_FUNDS", "en"));
    }

    if (!driver.stripeAccountId) {
      throw new BadRequestError(t("SETUP_ACCOUNT_REQUIRED", driver.locale));
    }

    if (
      driver?.stripeConnectCapabilities?.transfers != "active" &&
      driver?.stripeConnectCapabilities?.payout != "active"
    ) {
      throw new BadRequestError(t("NOT_ELIGIBLE_WITHDRAWAL", driver.locale));
    }

    const commission = amount * 0.03;
    const amountToTransfer = amount - commission;

    const identifierKey = crypto.randomUUID();
    const amountInCents = Math.round(amountToTransfer * 100);

    const transaction = await TransactionModel.create(
      [
        {
          amount,
          type: "Debit",
          user: driverId,
          userType: "Driver",
          bank: bankId,
          status: "initiated",
          identifierKey,
          stripeFee: 5,
          ...transactionRewardFields(walletAllocation),
        },
      ],
      { session },
    );

    const transfer = await stripeService.transferToAccount({
      amount: amountInCents,
      currency: "usd",
      destinationAccountId: driver.stripeAccountId,
      metadata: { identifierKey, bankId },
    });

    transaction[0].stripeIds = { transfer: transfer.id };
    transaction[0].status = "initiated";
    transaction[0].metadata = {
      ...transaction[0].metadata,
      transfer,
    };
    await transaction[0].save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      message: t("WITHDRAWAL_INITIATED", driver.locale).replace(
        "${amount}",
        amount,
      ),
    };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    throw new BadRequestError(
      err.message || t("WITHDRAWAL_FAILED", driver?.locale ?? "en"),
    );
  }
};

const transactionHistory = async (query, driver) => {
  const { page = 1, limit = 10, type = "all", last4 } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const normalizedLast4 = String(last4 ?? "").trim();

  const matchStage = { user: new mongoose.Types.ObjectId(driver._id) };

  if (type === "Debit") matchStage.type = "Debit";
  else if (type === "Credit") matchStage.type = "Credit";

  const aggregatePipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "bankdetails",
        localField: "bank",
        foreignField: "_id",
        as: "bank",
        pipeline: [{ $project: { accountHolderName: 1, accountNumber: 1 } }],
      },
    },
    {
      $unwind: {
        path: "$bank",
        preserveNullAndEmptyArrays: true,
      },
    },
    ...(normalizedLast4
      ? [{ $match: { "bank.accountNumber": normalizedLast4 } }]
      : []),
    {
      $project: {
        type: 1,
        amount: 1,
        createdAt: 1,
        errorMessage: 1,
        identifierKey: 1,
        status: 1,
        bank: 1,
        rewardedAmount: { $ifNull: ["$rewardedAmount", 0] },
        isRewarded: { $ifNull: ["$isRewarded", false] },
        balanceSource: { $ifNull: ["$balanceSource", "regular"] },
      },
    },
  ];

  const { skip, pagination } = await aggregatePaginate(
    TransactionModel,
    aggregatePipeline,
    parsedPage,
    parsedLimit,
  );

  aggregatePipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  );

  const transactions = await TransactionModel.aggregate(aggregatePipeline);

  const pendingWithdrawalBalance = driver.pendingWithdrawalBalance || 0;
  const rewardedBalance = driver.rewardedBalance || 0;
  const pendingRewardedWithdrawalBalance =
    driver.pendingRewardedWithdrawalBalance || 0;

  return {
    data: {
      balance: driver.balance,
      rewardedBalance,
      totalBalance: driver.balance + rewardedBalance,
      pendingWithdrawalBalance,
      pendingRewardedWithdrawalBalance,
      availableBalance:
        driver.balance + rewardedBalance - pendingWithdrawalBalance,
      availableRewardedBalance:
        rewardedBalance - pendingRewardedWithdrawalBalance,
      availableRegularBalance:
        driver.balance -
        (pendingWithdrawalBalance - pendingRewardedWithdrawalBalance),
      isBankAccountAttached: !!(driver.stripeAccountId && driver.bank),
      stripeConnectCapabilities: driver.stripeConnectCapabilities,
      transactions,
    },
    pagination,
  };
};

const banksList = async (driverId) => {
  const banks = await BankModel.find({
    driver: driverId,
  });

  return {
    data: {
      banks,
    },
  };
};

const getMe = async (driverId) => {
  const driver = await DriverModel.findById(driverId).populate(
    "driverLicense vehicleRegistration insurance vehicleDetails subscription bank",
  );

  if (!driver) {
    throw new NotFoundError(t("DRIVER_NOT_FOUND"));
  }

  const onboarding = buildDriverAccountStatus(driver);

  return {
    data: {
      driver: {
        ...driver.toObject(),
        accountStatus: onboarding.accountStatus,
        pendingDocuments: onboarding.pendingDocuments,
        approvedDocuments: onboarding.approvedDocuments,
        rejectedDocuments: onboarding.rejectedDocuments,
        stepToComplete: onboarding.stepToComplete,
        isOnboarded: onboarding.isOnboarded,
      },
    },
  };
};

const editDriver = async (body, files, typeKey, driverId, locale) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let uploadedFiles = [];

    const types = {
      profile: "profile",
      "vehicle-registration": "vehicleRegistration",
      insurance: "insurance",
      "vehicle-details": "vehicleDetails",
      "driver-license": "driverLicense",
    };

    const type = types[typeKey];

    if (!type) {
      throw new BadRequestError(t("INVALID_DOCUMENT_TYPE", locale));
    }

    if (files?.length) {
      uploadedFiles = await Promise.all(
        files.map(async (file) => {
          const { location } = await storageService.upload(file);
          return location;
        }),
      );
    }

    if (type === "profile") {
      const {
        firstName,
        lastName,
        email,
        removePFP,
        ssn,
        address,
        state,
        city,
      } = body;
      const profilePicture = uploadedFiles[0];

      const updateData = {};
      if (firstName !== undefined) updateData.firstName = firstName;
      if (lastName !== undefined) updateData.lastName = lastName;
      if (email) updateData.email = email;
      if (removePFP === "true") updateData.profilePicture = null;
      if (profilePicture) updateData.profilePicture = profilePicture;
      if (ssn) updateData.ssn = ssn;
      if (address !== undefined) updateData.address = address;
      if (state !== undefined) updateData.state = state;
      if (city !== undefined) updateData.city = city;

      const driver = await DriverModel.findByIdAndUpdate(driverId, updateData, {
        new: true,
        session,
      });

      await session.commitTransaction();
      session.endSession();

      return driver;
    }

    const payload = {
      type,
      driver: driverId,
      status: "pending",
    };

    if (type === "insurance") {
      if (uploadedFiles.length < 2) {
        throw new BadRequestError(t("INSURANCE_IMAGE_REQUIRED", locale));
      }

      payload.frontImage = uploadedFiles[0];
      payload.backImage = uploadedFiles[1];
    }

    if (type === "driverLicense") {
      const { expiryDate, licenseNumber } = body;

      if (!expiryDate || !licenseNumber) {
        throw new BadRequestError(t("LICENSE_DETAILS_REQUIRED", locale));
      }

      if (!files || files.length < 2) {
        throw new BadRequestError(t("DRIVER_LICENSE_IMAGES_REQUIRED", locale));
      }

      const latestDoc = await DocumentsModel.findOne({
        driver: driverId,
        type,
      })
        .sort({ createdAt: -1 })
        .session(session);

      if (latestDoc?.status === "pending") {
        throw new BadRequestError(
          "Driver license is already submitted and pending approval.",
        );
      }

      // VERIFF DISABLED: Do not create a Veriff session, upload the profile or
      // license images, or submit the session. Documents remain stored locally.
      // const driver = await DriverModel.findById(driverId).select(
      //   "firstName lastName profilePicture",
      // );
      //
      // const veriffSessionId = await createVeriffSession(
      //   driver || {
      //     firstName: driver?.firstName,
      //     lastName: driver?.lastName,
      //   },
      // );
      //
      // if (!veriffSessionId) {
      //   throw new BadRequestError("Veriff session creation failed.");
      // }
      //
      // const profileImage = await uploadVeriffMedia(
      //   veriffSessionId,
      //   driver.profilePicture,
      //   "face",
      // );
      //
      // if (!profileImage) {
      //   throw new BadRequestError("Veriff profile image upload failed.");
      // }
      //
      // const frontResult = await uploadVeriffMedia(
      //   veriffSessionId,
      //   uploadedFiles[0],
      //   "document-front",
      // );
      //
      // if (!frontResult) {
      //   throw new BadRequestError("Veriff front image upload failed.");
      // }
      //
      // const backResult = await uploadVeriffMedia(
      //   veriffSessionId,
      //   uploadedFiles[1],
      //   "document-back",
      // );
      //
      // if (!backResult) {
      //   throw new BadRequestError("Veriff back image upload failed.");
      // }
      //
      // const submitResult = await submitVeriffSession(veriffSessionId);
      // if (!submitResult) {
      //   throw new BadRequestError("Veriff session submission failed.");
      // }
      //
      // const veriffPayload = {
      //   type,
      //   driver: driverId,
      //   status: "pending",
      //   frontImage: uploadedFiles[0],
      //   backImage: uploadedFiles[1],
      //   metadata: { expiryDate, licenseNumber },
      //   veriffSessionId,
      //   veriffLastSubmittedAt: new Date(),
      //   rejectReason: null,
      //   rejectionReason: null,
      // };
      //
      // if (latestDoc?.status === "approved") {
      //   await DocumentsModel.updateOne(
      //     { _id: latestDoc._id },
      //     {
      //       $set: {
      //         status: "old",
      //         replacedBySessionId: veriffSessionId,
      //       },
      //     },
      //     { session },
      //   );
      // }
      //
      // const documentRecord = await DocumentsModel.findOneAndUpdate(
      //   { driver: driverId, type, veriffSessionId },
      //   { $set: veriffPayload },
      //   { upsert: true, new: true, session },
      // );
      //
      // await DriverModel.findByIdAndUpdate(
      //   driverId,
      //   {
      //     veriffSessionId,
      //     driverLicense: documentRecord._id,
      //   },
      //   { session },
      // );
      //
      // await session.commitTransaction();
      // session.endSession();
      //
      // return {
      //   message: t("DRIVER_UPDATED_SUCCESS", locale).replace(
      //     "${type}",
      //     "Driver License",
      //   ),
      //   data: { driver: await DriverModel.findById(driverId) },
      // };

      payload.frontImage = uploadedFiles[0];
      payload.backImage = uploadedFiles[1];
      payload.metadata = { expiryDate, licenseNumber };
      payload.rejectReason = null;
      payload.rejectionReason = null;
    }

    if (type === "vehicleRegistration") {
      if (uploadedFiles.length < 1) {
        throw new BadRequestError(
          t("VEHICLE_REGISTRATION_IMAGES_REQUIRED", locale),
        );
      }

      payload.frontImage = uploadedFiles[0];
    }

    if (type === "vehicleDetails") {
      payload.metadata = body || {};

      const vehicle = await VehicleModel.findOne({
        driver: { $ne: driverId },
        status: "approved",
        isDeleted: false,
        vehicleIdentificationNumber:
          payload.metadata.vehicleIdentificationNumber,
      });

      if (vehicle) {
        throw new BadRequestError(t("INVALID_VIN_AND_REGISTRATION", locale));
      }
    }

    if (type === "vehicleDetails") {
      await VehicleModel.updateMany(
        { driver: driverId, status: "approved" },
        { status: "old" },
        { session },
      );
    } else {
      await DocumentsModel.updateMany(
        { driver: driverId, type, status: "approved" },
        { status: "old" },
        { session },
      );
    }

    let documentRecord;

    // VERIFF DISABLED: Keep the session-based upsert for possible future reuse,
    // but save driver licenses through the normal document path for now.
    // if (type === "driverLicense") {
    //   documentRecord = await DocumentsModel.findOneAndUpdate(
    //     { driver: driverId, type, veriffSessionId: payload.veriffSessionId },
    //     {
    //       $set: {
    //         ...payload,
    //         status: "pending",
    //         rejectReason: null,
    //         rejectionReason: null,
    //       },
    //     },
    //     { upsert: true, new: true, session },
    //   );
    // }

    if (type === "vehicleDetails") {
      documentRecord = await VehicleModel.create(
        [
          {
            ...payload.metadata,
            driver: driverId,
            status: "pending",
          },
        ],
        { session },
      );

      documentRecord = documentRecord[0];
    } else {
      documentRecord = await DocumentsModel.create([payload], { session });
      documentRecord = documentRecord[0];
    }

    let rideType = undefined;
    if (type === "vehicleDetails") {
      const model = documentRecord?.vehicleType;
      rideType = await VehicleTypeService.getVehicleTypeByMakeModel(model);
    }

    const driver = await DriverModel.findByIdAndUpdate(
      driverId,
      {
        [type]: documentRecord._id,
        ...(type === "vehicleDetails" && {
          vehicleType: rideType,
        }),
      },
      { new: true, session },
    );

    await session.commitTransaction();
    session.endSession();

    return {
      message: t("DRIVER_UPDATED_SUCCESS", locale).replace(
        "${type}",
        capitalize(type.replace("-", " ")),
      ),
      data: {
        driver,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const deleteAccount = async (driverId, phone, otp, locale) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const isNonProd = ["development", "staging"].includes(env.NODE_ENV);

    const isValid =
      (isNonProd && otp === env.TEST_OTP) ||
      (await verifyOTPControllerHelper(phone, otp));

    if (!isValid) {
      throw new BadRequestError(t("INVALID_OTP", locale));
    }

    const driver = await DriverModel.findOneAndUpdate(
      { _id: driverId, isDeleted: false },
      { isDeleted: true },
      { new: true, session },
    );

    if (!driver) {
      throw new NotFoundError(t("DRIVER_NOT_FOUND_OR_DELETED", locale));
    }

    if (driver.balance > 0 || driver.rewardedBalance > 0) {
      throw new BadRequestError(t("WITHDRAW_BALANCE_BEFORE_DELETION", locale));
    }

    if (driver.pendingWithdrawalBalance > 0) {
      throw new BadRequestError(
        t("PENDING_WITHDRAWAL_BEFORE_DELETION", locale) ||
          "You have a pending withdrawal in progress. Please wait for it to complete before deleting your account.",
      );
    }

    const subscription = await SubscriptionModel.findOne({
      driver: driverId,
    }).session(session);

    if (subscription?.stripeSubscriptionId) {
      await stripeService.cancelSubscription(
        subscription.stripeSubscriptionId,
        true,
      );
    }

    await Promise.all([
      BankModel.deleteMany({ driver: driverId }).session(session),
      LoggedDeviceModel.deleteMany({ driver: driverId }).session(session),
      DocumentsModel.updateMany(
        { driver: driverId },
        { isDeleted: true },
        { session },
      ),
      VehicleModel.updateMany(
        { driver: driverId },
        { isDeleted: true },
        { session },
      ),
      SignupModel.findOneAndUpdate(
        { _id: driver.signUpRecord },
        { isDeleted: true },
        { session },
      ),
    ]);

    await session.commitTransaction();
    session.endSession();

    return { message: t("ACCOUNT_DELETED_SUCCESS", locale) };
  } catch (error) {
    console.error(
      `[deleteAccount] Error deleting account for driver ${driverId}:`,
      error.message,
    );
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const changeLocale = async (driverId, locale) => {
  const driver = await DriverModel.findByIdAndUpdate(
    driverId,
    { locale },
    { new: true },
  );

  return {
    message: t("LOCALE_UPDATED_SUCCESS", locale),
    data: {
      driver,
    },
  };
};

const dashboard = async (driverId) => {
  const objectDriverId = new mongoose.Types.ObjectId(driverId);

  const [
    completedRides,
    cancelledRides,
    todayRides,
    driver,
    completedCarpools,
    cancelledCarpools,
    todayCarpools,
  ] = await Promise.all([
    RideModel.countDocuments({
      driver: driverId,
      rideStatus: "completed",
    }),
    RideModel.countDocuments({
      driver: driverId,
      rideStatus: "cancelled",
    }),
    RideModel.countDocuments({
      driver: driverId,
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lt: new Date(new Date().setHours(23, 59, 59, 999)),
      },
    }),
    DriverModel.findById(driverId)
      .select(
        "balance rewardedBalance pendingWithdrawalBalance pendingRewardedWithdrawalBalance firstName lastName profilePicture rating",
      )
      .populate({
        path: "vehicleDetails",
        select: "make model vehicleIdentificationNumber licensePlateNumber",
      })
      .lean(),
    CarpoolRouteModel.countDocuments({
      driver: objectDriverId,
      status: CARPOOL_STATUS_ENUM.COMPLETED,
    }),
    CarpoolRouteModel.countDocuments({
      driver: objectDriverId,
      status: CARPOOL_STATUS_ENUM.CANCELLED,
    }),
    CarpoolRouteModel.countDocuments({
      driver: objectDriverId,
      createdAt: {
        $gte: new Date(new Date().setHours(0, 0, 0, 0)),
        $lt: new Date(new Date().setHours(23, 59, 59, 999)),
      },
    }),
  ]);

  return {
    data: {
      completedRides: completedRides + completedCarpools,
      cancelledRides: cancelledRides + cancelledCarpools,
      todayRides: todayRides + todayCarpools,
      driver: {
        firstName: driver.firstName,
        lastName: driver.lastName,
        profilePicture: driver.profilePicture,
        balance: driver.balance,
        rewardedBalance: driver.rewardedBalance || 0,
        totalBalance: driver.balance + (driver.rewardedBalance || 0),
        pendingWithdrawalBalance: driver.pendingWithdrawalBalance || 0,
        pendingRewardedWithdrawalBalance:
          driver.pendingRewardedWithdrawalBalance || 0,
        availableBalance:
          driver.balance +
          (driver.rewardedBalance || 0) -
          (driver.pendingWithdrawalBalance || 0),
        availableRewardedBalance:
          (driver.rewardedBalance || 0) -
          (driver.pendingRewardedWithdrawalBalance || 0),
        availableRegularBalance:
          driver.balance -
          ((driver.pendingWithdrawalBalance || 0) -
            (driver.pendingRewardedWithdrawalBalance || 0)),
        rating: driver.rating,
        vehicleDetails: driver.vehicleDetails,
      },
    },
  };
};

const driverStats = async (driverId, query) => {
  const { page = 1, limit = 10 } = query || {};

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const reviewsAggregatePipeline = [
    {
      $match: {
        receiver: new mongoose.Types.ObjectId(driverId),
        receiverType: "Driver",
        isDeleted: false,
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "reviewer",
        foreignField: "_id",
        as: "reviewer",
        pipeline: [
          { $project: { firstName: 1, lastName: 1, profilePicture: 1 } },
        ],
      },
    },
    {
      $unwind: {
        path: "$reviewer",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $project: {
        stars: 1,
        description: 1,
        isAnonymous: 1,
        createdAt: 1,
        ride: 1,
        reviewer: {
          $cond: {
            if: { $eq: ["$isAnonymous", true] },
            then: null,
            else: "$reviewer",
          },
        },
      },
    },
  ];

  const [completedRides, completedCarpools, driver, { skip, pagination }] =
    await Promise.all([
      RideModel.countDocuments({
        driver: new mongoose.Types.ObjectId(driverId),
        rideStatus: "completed",
      }),
      CarpoolRouteModel.countDocuments({
        driver: new mongoose.Types.ObjectId(driverId),
        status: CARPOOL_STATUS_ENUM.COMPLETED,
      }),
      DriverModel.findById(driverId).select(
        "firstName lastName profilePicture rating",
      ),
      aggregatePaginate(
        ReviewModel,
        reviewsAggregatePipeline,
        parsedPage,
        parsedLimit,
      ),
    ]);

  reviewsAggregatePipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  );

  const reviews = await ReviewModel.aggregate(reviewsAggregatePipeline);
  const totalRides = completedRides + completedCarpools;

  return {
    data: {
      driver,
      completedRides: totalRides,
      reviews,
    },
    pagination,
  };
};

module.exports = {
  setDefaultBankAccount,
  setupConnectedAccout,
  attachBankAccount,
  deleteBankAccount,
  transactionHistory,
  deleteAccount,
  changeLocale,
  dashboard,
  banksList,
  editDriver,
  withdraw,
  driverStats,
  getMe,
};
