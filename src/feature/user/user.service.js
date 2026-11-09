const UserModel = require("./models/user.model");
const CardModel = require("../card/models/card.model");
const storageService = require("../../core/services/storage/storage.service");
const {
  BadRequestError,
  NotFoundError,
} = require("../../core/common/exceptions");
const stripeService = require("../../core/services/stripe/stripe.service");
const TransactionModel = require("../transactions/model/transaction.model");
const { default: mongoose } = require("mongoose");
const LocationModel = require("./models/location.model");
const SignupModel = require("../auth/models/signup.model");
const RideModel = require("../ride/model/ride.model");
const CarpoolBookingModel = require("../carpool/model/carpool-booking.model");
const LoggedDeviceModel = require("../auth/models/logged.device.model");
const { verifyOTPControllerHelper } = require("../auth/auth.service");
const env = require("../../../config/index");
const { t, aggregatePaginate } = require("../../core/common/helpers");

const getUserProfile = async (userId) => {
  const user = await UserModel.findById(userId).lean();
  const [completedRides, cancelledRides, completedCarpools, cancelledCarpools] =
    await Promise.all([
      RideModel.find({
        user: user._id,
        rideStatus: "completed",
      }),
      RideModel.find({
        user: user._id,
        rideStatus: "cancelled",
        driver: { $ne: null },
      }),
      CarpoolBookingModel.countDocuments({
        passenger: user._id,
        status: "completed",
      }),
      CarpoolBookingModel.countDocuments({
        passenger: user._id,
        status: "cancelled",
      }),
    ]);
  return {
    data: {
      user: {
        ...user,
        completedRides: completedRides.length + completedCarpools,
        cancelledRides: cancelledRides.length + cancelledCarpools,
      },
    },
  };
};

const editUserProfile = async (body, file, userId) => {
  const { firstName, lastName, email, removePFP, dob, address, state, city } =
    body;

  const existingUser = await UserModel.findById(userId);

  if (file) {
    const uploaded = await storageService.upload(file);
    existingUser.profilePicture = uploaded.location;
  }

  if (firstName !== undefined) existingUser.firstName = firstName;
  if (lastName !== undefined) existingUser.lastName = lastName;
  if (email !== undefined) existingUser.email = email;
  if (removePFP === "true") existingUser.profilePicture = null;
  if (dob !== undefined) existingUser.dob = dob;
  if (address !== undefined) existingUser.address = address;
  if (state !== undefined) existingUser.state = state;
  if (city !== undefined) existingUser.city = city;

  await existingUser.save();

  return {
    data: {
      message: t("PROFILE_UPDATED", existingUser.locale),
      user: existingUser,
    },
  };
};

const attachCard = async (userId, pmId) => {
  const user = await UserModel.findById(userId);

  if (!user) {
    throw new BadRequestError(t("NO_USER_FOUND_WITH_ID"));
  }

  if (!user.stripeCustomerId) {
    throw new BadRequestError(t("STRIPE_CUSTOMER_NOT_FOUND", user.locale));
  }

  const paymentMethod = await stripeService.attachCard({
    customerId: user.stripeCustomerId,
    paymentMethodId: pmId,
  });

  if (!paymentMethod || paymentMethod.type !== "card") {
    throw new BadRequestError(t("INVALID_CARD_PAYMENT_METHOD", user.locale));
  }

  const { brand, last4, exp_month, exp_year } = paymentMethod.card;

  const existingCard = await CardModel.findOne({
    user: userId,
    paymentMethodId: pmId,
    status: { $ne: "deleted" },
  });

  if (existingCard) {
    return existingCard;
  }

  const hasActiveCard = await CardModel.exists({
    user: userId,
    status: "active",
  });

  const isDefault = !hasActiveCard;

  const card = await CardModel.create({
    user: userId,
    brand,
    last4,
    expMonth: exp_month,
    expYear: exp_year,
    paymentMethodId: pmId,
    default: isDefault,
  });

  return {
    data: {
      card,
    },
  };
};

const topupWallet = async (body) => {
  const { amount, cardId, userId } = body;
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const user = await UserModel.findById(userId).session(session);
    if (!user) throw new NotFoundError(t("USER_NOT_FOUND"));

    const card = await CardModel.findOne({ _id: cardId, user: userId }).session(
      session,
    );
    if (!card) throw new NotFoundError(t("CARD_NOT_FOUND", user.locale));

    const identifierKey = crypto.randomUUID();
    const amountInCents = Math.round(amount * 100);

    await TransactionModel.create(
      [
        {
          amount,
          type: "Credit",
          user: userId,
          userType: "User",
          card: card._id,
          status: "initiated",
          identifierKey,
        },
      ],
      { session },
    );

    const paymentIntent = await stripeService.createPaymentIntent({
      amount: amountInCents,
      currency: "usd",
      customerId: user.stripeCustomerId,
      paymentMethodId: card.paymentMethodId,
      metadata: { identifierKey, pmId: card.paymentMethodId },
    });

    const requiresAction = paymentIntent.status === "requires_action";
    const clientSecret = requiresAction ? paymentIntent.client_secret : null;

    await session.commitTransaction();
    session.endSession();

    return {
      data: {
        message: requiresAction
          ? t("VERIFY_IDENTITY", user.locale)
          : t("TOPUP_INITIATED", user.locale),
        ...(requiresAction && {
          requiresAction,
          clientSecret,
        }),
      },
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const transactionHistory = async (query, user) => {
  const { page = 1, limit = 10, type = "all", last4 } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const normalizedLast4 = String(last4 ?? "").trim();

  const matchStage = { user: new mongoose.Types.ObjectId(user._id) };

  if (type === "Debit") matchStage.type = "Debit";
  else if (type === "Credit") matchStage.type = "Credit";

  const aggregatePipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "cards",
        localField: "card",
        foreignField: "_id",
        as: "cardDetails",
        pipeline: [{ $project: { bank: 1, last4: 1 } }],
      },
    },
    {
      $unwind: {
        path: "$cardDetails",
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $set: {
        card: {
          $cond: [
            { $ne: [{ $ifNull: ["$card", null] }, null] },
            { $ifNull: ["$cardDetails", { last4: "Card removed" }] },
            null,
          ],
        },
      },
    },
    ...(normalizedLast4
      ? [{ $match: { "card.last4": normalizedLast4 } }]
      : []),
    {
      $project: {
        type: 1,
        amount: 1,
        createdAt: 1,
        errorMessage: 1,
        identifierKey: 1,
        status: 1,
        card: 1,
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

  return {
    data: {
      balance: user.balance,
      rewardedBalance: user.rewardedBalance || 0,
      totalBalance: user.balance + (user.rewardedBalance || 0),
      transactions,
    },
    pagination,
  };
};

const cardsList = async (userId) => {
  const cards = await CardModel.find({
    user: userId,
  });

  return {
    data: {
      cards,
    },
  };
};

const setCardAsDefault = async (userId, cardId, locale) => {
  await CardModel.updateMany(
    { user: userId, default: true },
    { $set: { default: false } },
  );

  const card = await CardModel.findOneAndUpdate(
    { _id: cardId, user: userId },
    { $set: { default: true } },
    { new: true },
  );

  if (!card) {
    throw new NotFoundError(t("CARD_NOT_FOUND", locale));
  }

  return { data: { card } };
};

const removeCard = async (userId, cardId, locale) => {
  const card = await CardModel.findOne({
    user: userId,
    _id: cardId,
  });

  if (!card) {
    throw new NotFoundError(t("CARD_NOT_FOUND", locale));
  }

  if (card.default) {
    throw new BadRequestError(t("CARD_DEFAULT_SELECTED", locale));
  }

  await stripeService.detachCard(card.paymentMethodId);

  await CardModel.findByIdAndDelete(card.id);

  return {
    success: true,
    message: t("CARD_DELETED_SUCCESS", locale),
    data: null,
  };
};

const saveLocation = async (body, userId, locale) => {
  const { coordinates } = body;

  const lastLocation = await LocationModel.findOne({
    user: userId,
    isDeleted: false,
  }).sort({ order: -1 });

  const nextOrder = lastLocation ? lastLocation.order + 1 : 1;

  const location = await LocationModel.create({
    ...body,
    coordinates: {
      type: "Point",
      coordinates: [coordinates.lng, coordinates.lat],
    },
    order: nextOrder,
    user: userId,
  });

  return {
    success: true,
    message: t("LOCATION_ADDED_SUCCESS", locale),
    data: {
      location,
    },
  };
};

const myLocations = async (query, userId) => {
  const { page = 1, limit = 10 } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const aggregatePipeline = [
    { $match: { user: new mongoose.Types.ObjectId(userId) } },
    { $sort: { order: 1 } },
  ];

  const { skip, pagination } = await aggregatePaginate(
    LocationModel,
    aggregatePipeline,
    parsedPage,
    parsedLimit,
  );

  aggregatePipeline.push({ $skip: skip }, { $limit: parsedLimit });

  const locations = await LocationModel.aggregate(aggregatePipeline);

  return {
    data: { locations },
    pagination,
  };
};

const editLocation = async (locationId, body, userId, locale) => {
  const { coordinates, ...rest } = body;

  const location = await LocationModel.findOne({
    _id: locationId,
    user: userId,
    isDeleted: false,
  });

  if (!location) {
    throw new NotFoundError(t("LOCATION_NOT_FOUND", locale));
  }

  const updatePayload = {
    ...rest,
  };

  if (coordinates) {
    updatePayload.coordinates = {
      type: "Point",
      coordinates: [coordinates.lng, coordinates.lat],
    };
  }

  const updatedLocation = await LocationModel.findByIdAndUpdate(
    locationId,
    updatePayload,
    { new: true },
  );

  return {
    success: true,
    message: t("LOCATION_UPDATED_SUCCESS", locale),
    data: {
      location: updatedLocation,
    },
  };
};

const deleteLocation = async (locationId, userId, locale) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const location = await LocationModel.findOneAndDelete(
      {
        _id: locationId,
        user: userId,
        isDeleted: false,
      },
      { new: true, session },
    );

    if (!location) {
      throw new NotFoundError(t("LOCATION_NOT_FOUND", locale));
    }

    await LocationModel.updateMany(
      {
        user: userId,
        isDeleted: false,
        order: { $gt: location.order },
      },
      {
        $inc: { order: -1 },
      },
      { session },
    );

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      message: t("LOCATION_DELETED_SUCCESS", locale),
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const updateLocationOrder = async (userId, locationIds, locale) => {
  const bulkOps = locationIds.map((id, index) => ({
    updateOne: {
      filter: { _id: id, user: userId },
      update: { order: index + 1 },
    },
  }));

  await LocationModel.bulkWrite(bulkOps);

  return {
    message: t("LOCATION_ORDER_UPDATED_SUCCESS", locale),
  };
};

const deleteAccount = async (userId, phone, otp, locale) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const isNonProd = ["development", "staging"].includes(env.NODE_ENV);

    const isValid =
      (isNonProd && otp === env.TEST_OTP) ||
      (await verifyOTPControllerHelper(phone, otp));

    if (!isValid) throw new BadRequestError(t("INVALID_OTP", locale));

    const user = await UserModel.findOneAndUpdate(
      { _id: userId, isDeleted: false },
      { isDeleted: true },
      { new: true, session },
    );

    if (!user) {
      throw new NotFoundError(t("USER_NOT_FOUND_OR_DELETED", locale));
    }

    if (user.balance > 0 || user.rewardedBalance > 0) {
      throw new BadRequestError(t("WITHDRAW_BALANCE_BEFORE_DELETION", locale));
    }

    await Promise.all([
      CardModel.deleteMany({ user: userId }).session(session),
      LocationModel.deleteMany({ user: userId }).session(session),
      LoggedDeviceModel.deleteMany({ user: userId }),
      SignupModel.findOneAndUpdate(
        { _id: user.signUpRecord },
        { isDeleted: true },
        { session },
      ),
    ]);

    await session.commitTransaction();
    session.endSession();

    return { message: t("ACCOUNT_DELETED_SUCCESS", locale) };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

const changeLocale = async (userId, locale) => {
  const user = await UserModel.findByIdAndUpdate(
    userId,
    { locale },
    { new: true },
  );

  return {
    message: t("LOCALE_UPDATED_SUCCESS", locale),
    data: {
      user,
    },
  };
};

module.exports = {
  getUserProfile,
  editUserProfile,
  transactionHistory,
  attachCard,
  topupWallet,
  cardsList,
  removeCard,
  setCardAsDefault,
  saveLocation,
  myLocations,
  deleteAccount,
  updateLocationOrder,
  editLocation,
  deleteLocation,
  changeLocale,
};
