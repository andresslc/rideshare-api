const PromoCodeCampaign = require("./model/promo-code-campaign.model");
const PromoCodeRedemption = require("./model/promo-code-redemption.model");
const mongoose = require("mongoose");
const { NotFoundError } = require("../../core/common/exceptions");
const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const RideModel = require("../ride/model/ride.model");
const CarpoolBookingModel = require("../carpool/model/carpool-booking.model");
const {
  getInternalIdentityEmailFilter,
  shouldRestrictInternalData,
} = require("../admin/admin-data-visibility.helper");

const getRedemptionVisibilityFilter = async (adminUser) => {
  if (!shouldRestrictInternalData(adminUser)) return {};

  const emailFilter = getInternalIdentityEmailFilter();
  const [users, drivers] = await Promise.all([
    UserModel.find(emailFilter).select("_id").lean(),
    DriverModel.find(emailFilter).select("_id").lean(),
  ]);
  const userIds = users.map(({ _id }) => _id);
  const driverIds = drivers.map(({ _id }) => _id);
  const [rideIds, bookingIds] = await Promise.all([
    driverIds.length
      ? RideModel.distinct("_id", { driver: { $in: driverIds } })
      : [],
    driverIds.length
      ? CarpoolBookingModel.distinct("_id", { driver: { $in: driverIds } })
      : [],
  ]);
  const exclusions = [];
  if (userIds.length) exclusions.push({ user: { $in: userIds } });
  if (rideIds.length) {
    exclusions.push({ appliedToType: "Ride", appliedTo: { $in: rideIds } });
  }
  if (bookingIds.length) {
    exclusions.push({
      appliedToType: "CarpoolBooking",
      appliedTo: { $in: bookingIds },
    });
  }

  return exclusions.length ? { $nor: exclusions } : {};
};

const getCampaignStats = async (campaignId, adminUser) => {
  const campaign = await PromoCodeCampaign.findById(campaignId);
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND");
  }

  const redemptionVisibilityFilter =
    await getRedemptionVisibilityFilter(adminUser);
  const redemptionsData = await PromoCodeRedemption.aggregate([
    {
      $match: {
        campaign: new mongoose.Types.ObjectId(campaignId),
        ...redemptionVisibilityFilter,
      },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              totalDiscountGiven: { $sum: "$discountApplied" },
              uniqueUsers: { $addToSet: "$user" },
            },
          },
        ],
        byRideType: [
          {
            $group: {
              _id: "$appliedToType",
              count: { $sum: 1 },
              totalDiscount: { $sum: "$discountApplied" },
            },
          },
          {
            $project: {
              _id: 0,
              rideType: "$_id",
              count: 1,
              totalDiscount: 1,
            },
          },
        ],
        redemptionsByDay: [
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$redeemedAt" },
              },
              count: { $sum: 1 },
              totalDiscount: { $sum: "$discountApplied" },
            },
          },
          {
            $project: {
              _id: 0,
              date: "$_id",
              count: 1,
              totalDiscount: 1,
            },
          },
          { $sort: { date: 1 } },
        ],
      },
    },
  ]);

  const totals = redemptionsData[0]?.totals[0] || {
    totalDiscountGiven: 0,
    uniqueUsers: [],
  };

  const byRideType = redemptionsData[0]?.byRideType || [];
  const redemptionsByDay = redemptionsData[0]?.redemptionsByDay || [];

  const totalDiscountGiven = Math.round(totals.totalDiscountGiven * 100) / 100;
  const uniqueUsersCount = totals.uniqueUsers.length;
  const totalRedemptions =
    redemptionsData[0]?.byRideType?.reduce(
      (sum, item) => sum + item.count,
      0,
    ) || 0;
  const averageDiscountPerRide =
    totalRedemptions > 0
      ? Math.round((totalDiscountGiven / totalRedemptions) * 100) / 100
      : 0;

  const redemptionRate =
    campaign.totalRedemptionLimit > 0
      ? Math.round((totalRedemptions / campaign.totalRedemptionLimit) * 10000) /
        100
      : 0;

  let budgetRemaining = null;
  if (campaign.discountType === "fixed") {
    const remaining =
      (campaign.totalRedemptionLimit - totalRedemptions) *
      campaign.discountValue;
    budgetRemaining = Math.max(0, Math.round(remaining * 100) / 100);
  }

  return {
    campaignName: campaign.name,
    status: campaign.status,
    discountType: campaign.discountType,
    discountValue: campaign.discountValue,
    description: campaign.description,
    eligibility: campaign.eligibility,
    maxDiscountCap: campaign.maxDiscountCap,
    totalRedemptionLimit: campaign.totalRedemptionLimit,
    startDate: campaign.startDate,
    expiresAt: campaign.expiresAt,
    totalRedemptions,
    totalDiscountGiven,
    averageDiscountPerRide,
    redemptionRate,
    budgetRemaining,
    uniqueUsersCount,
    byRideType,
    redemptionsByDay,
  };
};

const getCampaignRedemptions = async (
  campaignId,
  { page = 1, limit = 20, search },
  adminUser,
) => {
  const skip = (page - 1) * limit;

  const matchStage = {
    campaign: new mongoose.Types.ObjectId(campaignId),
    ...(await getRedemptionVisibilityFilter(adminUser)),
  };

  const pipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    {
      $lookup: {
        from: "promocodes",
        localField: "promoCode",
        foreignField: "_id",
        as: "promoCode",
      },
    },
    { $unwind: { path: "$promoCode", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "rides",
        localField: "appliedTo",
        foreignField: "_id",
        as: "ride",
      },
    },
    { $unwind: { path: "$ride", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "carpoolbookings",
        localField: "appliedTo",
        foreignField: "_id",
        as: "carpoolBooking",
      },
    },
    { $unwind: { path: "$carpoolBooking", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        driverId: {
          $cond: {
            if: { $eq: ["$appliedToType", "Ride"] },
            then: "$ride.driver",
            else: "$carpoolBooking.driver",
          },
        },
      },
    },
    {
      $lookup: {
        from: "drivers",
        localField: "driverId",
        foreignField: "_id",
        as: "driver",
      },
    },
    { $unwind: { path: "$driver", preserveNullAndEmptyArrays: true } },
  ];

  if (search) {
    pipeline.push({
      $match: {
        $or: [
          { "user.firstName": { $regex: search, $options: "i" } },
          { "user.lastName": { $regex: search, $options: "i" } },
          { "user.email": { $regex: search, $options: "i" } },
          { "driver.firstName": { $regex: search, $options: "i" } },
          { "driver.lastName": { $regex: search, $options: "i" } },
          { "driver.email": { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  pipeline.push(
    { $sort: { redeemedAt: -1 } },
    {
      $facet: {
        metadata: [{ $count: "totalCount" }],
        data: [
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 1,
              "user._id": 1,
              "user.firstName": 1,
              "user.lastName": 1,
              "user.email": 1,
              "user.phoneNumber": 1,
              "driver._id": 1,
              "driver.firstName": 1,
              "driver.lastName": 1,
              "driver.email": 1,
              "driver.phoneNumber": 1,
              "promoCode.code": 1,
              appliedToType: 1,
              appliedTo: 1,
              discountApplied: 1,
              redeemedAt: 1,
            },
          },
        ],
      },
    },
  );

  const result = await PromoCodeRedemption.aggregate(pipeline);
  const totalCount = result[0]?.metadata[0]?.totalCount || 0;
  const redemptions = result[0]?.data || [];

  return {
    redemptions: redemptions.map((r) => {
      const riderName =
        `${r.user?.firstName || ""}${r.user?.lastName ? " " + r.user.lastName : ""}`.trim();
      const driverName = r.driver
        ? `${r.driver.firstName || ""}${r.driver.lastName ? " " + r.driver.lastName : ""}`.trim()
        : "";

      return {
        ...r,
        riderName,
        driverName,
        user: {
          _id: r.user?._id,
          name: riderName,
          email: r.user?.email,
          phone: r.user?.phoneNumber,
        },
        driver: r.driver
          ? {
              _id: r.driver._id,
              name: driverName,
              email: r.driver.email,
              phone: r.driver.phoneNumber,
            }
          : null,
      };
    }),
    totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit),
  };
};

const getUserRedemptionHistory = async (campaignId, userId, adminUser) => {
  const campaign = await PromoCodeCampaign.findById(campaignId);
  if (!campaign) {
    throw new NotFoundError("CAMPAIGN_NOT_FOUND");
  }

  const visibleUser = await UserModel.exists({
    _id: userId,
    ...(shouldRestrictInternalData(adminUser)
      ? { email: { $not: getInternalIdentityEmailFilter().email } }
      : {}),
  });
  if (!visibleUser) {
    throw new NotFoundError("USER_REDEMPTION_NOT_FOUND");
  }

  const redemptions = await PromoCodeRedemption.find({
    campaign: campaignId,
    user: userId,
    ...(await getRedemptionVisibilityFilter(adminUser)),
  })
    .populate("user", "firstName lastName email")
    .populate("promoCode", "code")
    .sort({ redeemedAt: -1 });

  if (redemptions.length === 0) {
    throw new NotFoundError("USER_REDEMPTION_NOT_FOUND");
  }

  const user = redemptions[0].user;
  const totalUsed = redemptions.length;
  const maxUsesPerUser = campaign.maxUsesPerUser;
  const remainingUses = Math.max(0, maxUsesPerUser - totalUsed);

  return {
    user: {
      _id: user._id,
      name: `${user.firstName || ""} ${user.lastName || ""}`.trim(),
      email: user.email,
    },
    campaign: {
      _id: campaign._id,
      name: campaign.name,
      discountType: campaign.discountType,
      discountValue: campaign.discountValue,
    },
    totalUsed,
    maxUsesPerUser,
    remainingUses,
    redemptions: redemptions.map((r) => ({
      promoCode: { code: r.promoCode?.code },
      appliedToType: r.appliedToType,
      appliedTo: r.appliedTo,
      discountApplied: r.discountApplied,
      redeemedAt: r.redeemedAt,
    })),
  };
};

module.exports = {
  getRedemptionVisibilityFilter,
  getCampaignStats,
  getCampaignRedemptions,
  getUserRedemptionHistory,
};
