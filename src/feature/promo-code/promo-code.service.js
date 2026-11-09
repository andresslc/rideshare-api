const PromoCode = require("./model/promo-code.model");
const PromoCodeCampaign = require("./model/promo-code-campaign.model");
const PromoCodeRedemption = require("./model/promo-code-redemption.model");
const UserModel = require("../user/models/user.model");
const { BadRequestError } = require("../../core/common/exceptions");
const { t } = require("../../core/common/helpers");
const { calculateCampaignDiscount } = require("./promo-code-discount.helper");

const calculateAge = (dob) => {
  const diffMs = Date.now() - new Date(dob).getTime();
  const ageDate = new Date(diffMs);
  return Math.abs(ageDate.getUTCFullYear() - 1970);
};

const redeemCode = async (payload) => {
  const { code, rideType, pickupCity, rideFare, userId } = payload;
  const normalizedCode = code.toUpperCase().trim();

  // Normalize fares (supports both number and array)
  const fares = Array.isArray(rideFare) ? rideFare : [rideFare];

  // 1. Find PromoCode
  const promoCode = await PromoCode.findOne({
    code: normalizedCode,
    isDeleted: false,
    isActive: true,
  }).populate("campaign");

  if (!promoCode || !promoCode.campaign) {
    throw new BadRequestError(t("PROMO_CODE_INVALID"));
  }

  const campaign = promoCode.campaign;

  // 2. Validate campaign is not deleted
  if (campaign.isDeleted) {
    throw new BadRequestError(t("PROMO_CODE_INVALID"));
  }

  // 3. Status active
  if (campaign.status !== "active") {
    throw new BadRequestError(t("PROMO_CODE_INACTIVE"));
  }

  const now = new Date();

  // 4. Start date
  if (new Date(campaign.startDate) > now) {
    throw new BadRequestError(t("PROMO_CODE_NOT_STARTED"));
  }

  // 5. Expiry date
  if (new Date(campaign.expiresAt) <= now) {
    throw new BadRequestError(t("PROMO_CODE_EXPIRED"));
  }

  // 6. Global limit
  if (campaign.totalRedemptions >= campaign.totalRedemptionLimit) {
    throw new BadRequestError(t("PROMO_CODE_LIMIT_REACHED"));
  }

  // 7. If unique code mode — check this specific code hasn't been used already
  if (campaign.codeMode === "unique") {
    const codeAlreadyUsed = await PromoCodeRedemption.exists({
      promoCode: promoCode._id,
    });

    if (codeAlreadyUsed) {
      throw new BadRequestError(t("PROMO_CODE_ALREADY_USED"));
    }
  }

  const { eligibility } = campaign;

  // 7. Ride types
  if (eligibility?.rideTypes?.length > 0) {
    if (!eligibility.rideTypes.includes(rideType)) {
      throw new BadRequestError(t("PROMO_CODE_INVALID_RIDE_TYPE"));
    }
  }

  // 8. Cities
  if (eligibility?.cities?.length > 0) {
    const normalizedPickupCity = pickupCity.toLowerCase();
    const cityMatches = eligibility.cities.some(
      (c) => c.toLowerCase() === normalizedPickupCity,
    );

    if (!cityMatches) {
      throw new BadRequestError(t("PROMO_CODE_INVALID_CITY"));
    }
  }

  // Fetch user for user-based eligibility
  const user = await UserModel.findById(userId).select("createdAt dob locale");

  // 9. User Type
  if (eligibility?.userType) {
    if (eligibility.userType === "new") {
      if (new Date(user.createdAt) <= new Date(campaign.createdAt)) {
        throw new BadRequestError(t("INELIGIBLE_FOR_REDEMPTION"));
      }
    } else if (eligibility.userType === "existing") {
      if (new Date(user.createdAt) > new Date(campaign.createdAt)) {
        throw new BadRequestError(t("INELIGIBLE_FOR_REDEMPTION"));
      }
    }
  }

  // 10. Min Age
  if (eligibility?.minAge !== null && eligibility?.minAge !== undefined) {
    if (!user.dob) {
      throw new BadRequestError(t("DOB_NOT_FOUND"));
    }

    const age = calculateAge(user.dob);

    if (age < eligibility.minAge) {
      throw new BadRequestError(t("INELIGIBLE_FOR_REDEMPTION"));
    }
  }

  // 11. Per-user limit
  const userRedemptions = await PromoCodeRedemption.countDocuments({
    user: userId,
    campaign: campaign._id,
  });

  if (userRedemptions >= campaign.maxUsesPerUser) {
    throw new BadRequestError(t("PROMO_CODE_REDEEMED"));
  }

  // 12. Calculate fare-wise discounts
  const fareBreakdown = fares.map((fare) =>
    calculateCampaignDiscount(campaign, fare),
  );

  // If no fare qualifies, reject the promo
  if (!fareBreakdown.some((fare) => fare.discountApplied)) {
    throw new BadRequestError(
      t("PROMO_CODE_MIN_AMOUNT").replace("${amount}", campaign.minRideAmount),
    );
  }

  // 13. Return result
  return {
    fares: fareBreakdown,
    codeId: promoCode._id,
    campaignId: campaign._id,
    discountType: campaign.discountType,
    discountValue: campaign.discountValue,
  };
};

module.exports = {
  redeemCode,
};
