/**
 * What a campaign takes off one fare. Shared by the quote the rider sees when
 * applying a code and by the category upgrade, which prices the same code
 * against a new fare — two copies of this would drift apart.
 */
function calculateCampaignDiscount(campaign, fare) {
  const amount = Number(fare);
  const originalFare = Number.isFinite(amount) ? amount : 0;

  const eligible =
    campaign?.minRideAmount === null ||
    campaign?.minRideAmount === undefined ||
    originalFare >= campaign.minRideAmount;

  if (!campaign || !eligible) {
    return {
      originalFare,
      discountApplied: false,
      discountAmount: 0,
      finalFare: originalFare,
    };
  }

  let discountAmount = 0;

  if (campaign.discountType === "fixed") {
    discountAmount = Math.min(campaign.discountValue, originalFare);
  } else if (campaign.discountType === "percentage") {
    const rawDiscount = originalFare * (campaign.discountValue / 100);
    discountAmount = Math.min(
      rawDiscount,
      campaign.maxDiscountCap || rawDiscount,
    );
  }

  discountAmount = Math.round(discountAmount * 100) / 100;

  return {
    originalFare,
    discountApplied: true,
    discountAmount,
    finalFare: Math.round((originalFare - discountAmount) * 100) / 100,
  };
}

module.exports = { calculateCampaignDiscount };
