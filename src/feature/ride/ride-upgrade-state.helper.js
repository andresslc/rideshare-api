/**
 * Every state change an upgrade offer can go through, as a conditional update.
 *
 * The ride stays `requested` for the whole offer, so nothing about the ride
 * status tells two callers apart. What does is `upgradeOffer.status`: each
 * transition filters on the value it believes the offer is in, so the rider's
 * accept, the timeout job, and a driver accepting the ride race against the
 * same field of the same document and exactly one of them wins.
 *
 * The Model is injected rather than required, which is what lets the race tests
 * drive these with a fake model and no database.
 */

const OFFER_STATUS = {
  OFFERED: "offered",
  ACCEPTING: "accepting",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TIMED_OUT: "timed_out",
  PAYMENT_FAILED: "payment_failed",
  SUPERSEDED: "superseded",
};

/**
 * Put the question to the rider. Conditional on no offer existing yet, so a
 * retried job cannot ask twice, and on the ride still being `requested` in the
 * category the search ran in.
 */
async function openUpgradeOffer(
  RideModel,
  rideId,
  {
    fromRideType,
    toRideType,
    quotedFare,
    promoCodeDropped = false,
    fullFare = null,
    offeredAt = new Date(),
    expiresAt,
  },
) {
  return RideModel.findOneAndUpdate(
    {
      _id: rideId,
      rideStatus: "requested",
      rideType: fromRideType,
      "upgradeOffer.status": null,
    },
    {
      $set: {
        "upgradeOffer.status": OFFER_STATUS.OFFERED,
        "upgradeOffer.fromRideType": fromRideType,
        "upgradeOffer.toRideType": toRideType,
        "upgradeOffer.quotedFare": quotedFare,
        "upgradeOffer.promoCodeDropped": promoCodeDropped,
        "upgradeOffer.fullFare": fullFare,
        "upgradeOffer.offeredAt": offeredAt,
        "upgradeOffer.expiresAt": expiresAt,
        "upgradeOffer.decidedAt": null,
      },
    },
    { new: true },
  );
}

/**
 * Take the offer off the table before anything slow happens.
 *
 * The payment re-check needs a database read of its own, and the timeout job
 * may fire while it runs. Moving to `accepting` first is what stops the window
 * from closing underneath an acceptance that is already in flight.
 *
 * Ownership is part of the filter rather than a separate read — the same shape
 * `cancelRidePendingRequest` uses.
 */
async function claimUpgradeOffer(RideModel, rideId, userId) {
  return RideModel.findOneAndUpdate(
    {
      _id: rideId,
      user: userId,
      rideStatus: "requested",
      "upgradeOffer.status": OFFER_STATUS.OFFERED,
    },
    { $set: { "upgradeOffer.status": OFFER_STATUS.ACCEPTING } },
    { new: true },
  );
}

/**
 * Change the ride's category and start its next search generation.
 *
 * Still conditional on `requested`: a driver who accepted while the card was
 * being checked wins, and this returns null rather than moving an assigned ride
 * into a category its driver cannot serve.
 */
async function commitUpgradeAccepted(
  RideModel,
  rideId,
  {
    toRideType,
    rideFare,
    decidedAt = new Date(),
    dropPromoCode = false,
    fullFare = null,
  },
) {
  const update = {
    $set: {
      rideType: toRideType,
      rideFare,
      "upgradeOffer.status": OFFER_STATUS.ACCEPTED,
      "upgradeOffer.decidedAt": decidedAt,
    },
    $inc: { searchAttempt: 1 },
  };

  // A code that is not valid in the new category cannot travel with the ride,
  // or the charge would apply a discount the campaign never allowed here.
  if (dropPromoCode) {
    update.$unset = {
      codeId: "",
      campaignId: "",
      discountAmount: "",
      originalRideFare: "",
    };
  }

  // The fare fields are rewritten for the new category, never left over from
  // the old one: the driver is paid `originalRideFare`, so an economy price
  // left there would underpay a luxury driver.
  //
  // A discount that travels with the ride (a kept promo code, or a driver
  // referral) arrives as `fullFare`: `rideFare` is the discounted quote the
  // rider agreed to, and the driver is paid the full price behind it. Without
  // one, the rider pays the full price and there is no discount left to record.
  if (!dropPromoCode) {
    const full = Number(fullFare);

    if (Number.isFinite(full) && full > 0) {
      update.$set.originalRideFare = full;
      update.$set.discountAmount = Math.max(
        Number((full - rideFare).toFixed(2)),
        0,
      );
    } else {
      update.$set.originalRideFare = rideFare;
      update.$set.discountAmount = 0;
    }
  }

  return RideModel.findOneAndUpdate(
    {
      _id: rideId,
      rideStatus: "requested",
      "upgradeOffer.status": OFFER_STATUS.ACCEPTING,
    },
    update,
    { new: true },
  );
}

/**
 * Close an offer that was not accepted. `from` is the status the caller
 * believes the offer is in, so two settlers cannot both succeed.
 */
async function settleUpgradeOffer(
  RideModel,
  rideId,
  { from, to, decidedAt = new Date() },
) {
  return RideModel.findOneAndUpdate(
    { _id: rideId, "upgradeOffer.status": from },
    {
      $set: {
        "upgradeOffer.status": to,
        "upgradeOffer.decidedAt": decidedAt,
      },
    },
    { new: true },
  );
}

module.exports = {
  OFFER_STATUS,
  claimUpgradeOffer,
  commitUpgradeAccepted,
  openUpgradeOffer,
  settleUpgradeOffer,
};
