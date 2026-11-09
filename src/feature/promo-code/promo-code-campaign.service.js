const PromoCodeCampaign = require("./model/promo-code-campaign.model");
const PromoCode = require("./model/promo-code.model");
const PromoCodeRedemption = require("./model/promo-code-redemption.model");
const mongoose = require("mongoose");
const logger = require("../../core/common/helpers").logger || console;
const {
  getRedemptionVisibilityFilter,
} = require("./promo-code-analytics.service");
const {
  BadRequestError,
  NotFoundError,
} = require("../../core/common/exceptions");

const createCampaign = async (payload) => {
  const {
    startDate,
    expiresAt,
    discountType,
    discountValue,
    maxDiscountCap,
    codeMode,
    code,
    prefix,
    quantity,
  } = payload;

  if (new Date(expiresAt) <= new Date(startDate)) {
    throw new BadRequestError(
      "Invalid date range: expiresAt must be after startDate",
    );
  }

  if (discountType === "percentage") {
    if (discountValue < 1 || discountValue > 100) {
      throw new BadRequestError(
        "Percentage discount must be between 1 and 100",
      );
    }
    if (!maxDiscountCap) {
      throw new BadRequestError(
        "Discount cap is required for percentage discounts",
      );
    }
  }

  let codesToCreate = [];

  if (codeMode === "public") {
    if (!code) throw new BadRequestError("Code is required for public mode");
    const normalizedCode = code.toUpperCase().trim();
    const existingCode = await PromoCode.findOne({
      code: normalizedCode,
      isDeleted: false,
    });
    if (existingCode) {
      throw new BadRequestError(
        "Campaign code already exists. Please choose a different code.",
      );
    }
    codesToCreate.push(normalizedCode);
  } else if (codeMode === "unique") {
    if (!prefix)
      throw new BadRequestError("Prefix is required for unique mode");
    if (!quantity || quantity > 500)
      throw new BadRequestError("Quantity must be between 1 and 500");

    const normalizedPrefix = prefix.toUpperCase().trim();
    for (let i = 1; i <= quantity; i++) {
      const paddedNum = i.toString().padStart(3, "0");
      codesToCreate.push(`${normalizedPrefix}${paddedNum}`);
    }

    const existingCodes = await PromoCode.find({
      code: { $in: codesToCreate },
      isDeleted: false,
    });

    if (existingCodes.length > 0) {
      throw new BadRequestError(
        "One or more generated codes already exist. Please choose a different prefix.",
      );
    }
  }

  const campaign = await PromoCodeCampaign.create(payload);

  const promoCodeDocs = codesToCreate.map((c) => ({
    code: c,
    campaign: campaign._id,
  }));

  await PromoCode.insertMany(promoCodeDocs);

  return {
    campaign,
    codes: promoCodeDocs.map((c) => c.code),
  };
};

const updateCampaign = async (campaignId, payload) => {
  const allowedUpdates = [
    "name",
    "description",
    "minRideAmount",
    "maxDiscountCap",
    "expiresAt",
    "eligibility",
  ];

  const updateData = {};
  for (const key of allowedUpdates) {
    if (payload[key] !== undefined) {
      updateData[key] = payload[key];
    }
  }

  const campaign = await PromoCodeCampaign.findOneAndUpdate(
    { _id: campaignId, isDeleted: false },
    { $set: updateData },
    { new: true, runValidators: true },
  );

  if (!campaign) {
    throw new NotFoundError("Campaign not found or has been deleted");
  }

  return campaign;
};

const updateCampaignStatus = async (campaignId, status) => {
  const campaign = await PromoCodeCampaign.findOneAndUpdate(
    { _id: campaignId, isDeleted: false },
    { $set: { status } },
    { new: true },
  );

  if (!campaign) {
    throw new NotFoundError("Campaign not found or has been deleted");
  }

  return campaign;
};

const deleteCampaign = async (campaignId) => {
  const campaign = await PromoCodeCampaign.findOneAndUpdate(
    { _id: campaignId, isDeleted: false },
    { $set: { isDeleted: true } },
    { new: true },
  );

  if (!campaign) {
    throw new NotFoundError("Campaign not found or has been deleted");
  }

  await PromoCode.updateMany(
    { campaign: campaignId },
    { $set: { isActive: false, isDeleted: true } },
  );

  return campaign;
};

const getAllCampaigns = async (
  { page = 1, limit = 10, status, search },
  adminUser,
) => {
  const matchStage = { isDeleted: false };

  if (status) {
    matchStage.status = status;
  }

  if (search) {
    matchStage.name = { $regex: search, $options: "i" };
  }

  const skip = (page - 1) * limit;
  const redemptionVisibilityFilter =
    await getRedemptionVisibilityFilter(adminUser);

  const pipeline = [
    { $match: matchStage },
    { $sort: { createdAt: -1 } },
    {
      $lookup: {
        from: "promocoderedemptions",
        localField: "_id",
        foreignField: "campaign",
        pipeline: [{ $match: redemptionVisibilityFilter }],
        as: "redemptions",
      },
    },
    {
      $addFields: {
        totalRedemptions: { $size: "$redemptions" },
      },
    },
    {
      $addFields: {
        totalDiscountGiven: {
          $round: [{ $sum: "$redemptions.discountApplied" }, 2],
        },
        uniqueUsersCount: {
          $size: {
            $reduce: {
              input: "$redemptions.user",
              initialValue: [],
              in: { $setUnion: ["$$value", ["$$this"]] },
            },
          },
        },
        redemptionRate: {
          $cond: {
            if: { $gt: ["$totalRedemptionLimit", 0] },
            then: {
              $round: [
                {
                  $multiply: [
                    { $divide: ["$totalRedemptions", "$totalRedemptionLimit"] },
                    100,
                  ],
                },
                2,
              ],
            },
            else: 0,
          },
        },
        budgetRemaining: {
          $cond: {
            if: { $eq: ["$discountType", "fixed"] },
            then: {
              $round: [
                {
                  $multiply: [
                    {
                      $max: [
                        0,
                        {
                          $subtract: [
                            "$totalRedemptionLimit",
                            "$totalRedemptions",
                          ],
                        },
                      ],
                    },
                    "$discountValue",
                  ],
                },
                2,
              ],
            },
            else: null,
          },
        },
      },
    },
    {
      $project: {
        redemptions: 0,
      },
    },
    {
      $facet: {
        metadata: [{ $count: "totalCount" }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ];

  const result = await PromoCodeCampaign.aggregate(pipeline);
  const totalCount = result[0]?.metadata[0]?.totalCount || 0;
  const campaigns = result[0]?.data || [];

  return {
    campaigns,
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
  };
};

const getCampaignById = async (campaignId, adminUser) => {
  const campaign = await PromoCodeCampaign.findOne({
    _id: campaignId,
    isDeleted: false,
  });

  if (!campaign) {
    throw new NotFoundError("Campaign not found or has been deleted");
  }

  const totalRedemptions = await PromoCodeRedemption.countDocuments({
    campaign: campaignId,
    ...(await getRedemptionVisibilityFilter(adminUser)),
  });

  return { ...campaign.toObject(), totalRedemptions };
};

const getCampaignCodes = async (campaignId, { page = 1, limit = 10 }) => {
  const skip = (page - 1) * limit;

  const codes = await PromoCode.find({
    campaign: campaignId,
    isDeleted: false,
  })
    .sort({ code: 1 })
    .skip(skip)
    .limit(limit);

  const totalCount = await PromoCode.countDocuments({
    campaign: campaignId,
    isDeleted: false,
  });

  return {
    codes,
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
  };
};

const applyCode = async ({
  promoCode,
  campaign,
  user,
  appliedTo,
  appliedToType,
  discountApplied,
}) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await PromoCodeRedemption.create(
      [
        {
          promoCode,
          campaign,
          user,
          appliedTo,
          appliedToType,
          discountApplied,
          redeemedAt: new Date(),
        },
      ],
      { session },
    );
    await PromoCodeCampaign.findByIdAndUpdate(
      campaign,
      { $inc: { totalRedemptions: 1 } },
      { session },
    );
    await session.commitTransaction();
    return true;
  } catch (err) {
    await session.abortTransaction();
    logger.error("[applyCode] Failed to record redemption", {
      promoCode,
      campaign,
      user,
      appliedTo,
      err: err.message,
    });
    return false;
  } finally {
    await session.endSession();
  }
};

module.exports = {
  createCampaign,
  updateCampaign,
  updateCampaignStatus,
  deleteCampaign,
  getAllCampaigns,
  getCampaignById,
  getCampaignCodes,
  applyCode,
};
