async function acceptPendingOffer(RideOfferModel, offerId, now = new Date()) {
  return RideOfferModel.findOneAndUpdate(
    {
      _id: offerId,
      status: "pending",
      expiresAt: { $gt: now },
    },
    { $set: { status: "accepted" } },
    { new: true },
  );
}

async function cancelPendingOffersForDriver(RideOfferModel, driverId) {
  return RideOfferModel.updateMany(
    { driver: driverId, status: "pending" },
    { $set: { status: "canceled" } },
  );
}

async function rejectPendingOffer(RideOfferModel, offerId) {
  return RideOfferModel.findOneAndUpdate(
    { _id: offerId, status: "pending" },
    { $set: { status: "rejected" } },
    { new: true },
  );
}

module.exports = {
  acceptPendingOffer,
  cancelPendingOffersForDriver,
  rejectPendingOffer,
};
