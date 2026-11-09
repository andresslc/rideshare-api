const RideService = require("./ride.service");
const {
  previewReferralDiscount,
} = require("../driver-referral/driver-referral.service");

const getRidesForDriver = async (req, res) => {
  const driver = req.user;
  const status = req.query.status;
  const page = req.query.page || 1;
  const limit = req.query.limit || 10;

  const result = await RideService.getRidesForDriverService(
    driver,
    status,
    page,
    limit,
  );
  return result;
};

const getRideById = async (req, res) => {
  const rideId = req.params.id;
  const userLocale = req.user.locale;
  const ride = await RideService.getRideWithRelations(
    rideId,
    userLocale,
    "api",
  );

  return ride;
};

const rideFareCalculatorController = async (req, res) => {
  const { rideType, miles, pickupCity } = req.body;

  const fare = await RideService.rideFareCalculator(
    rideType,
    miles,
    pickupCity,
  );

  // Only a quote: the discount is claimed when the ride is requested. The app
  // still sends `totalFare` (the full price) on the request.
  if (req.session?.role === "user" && fare?.data) {
    const referral = await previewReferralDiscount(
      req.user._id,
      fare.data.totalFare,
    );

    fare.data.referralDiscount = referral
      ? {
          amount: referral.discountAmount,
          fareAfterDiscount: referral.rideFare,
        }
      : null;
  }

  return fare;
};

const rideHistoryController = async (req, res) => {
  const userId = req.user.id;
  const role = req.session.role;
  const page = req.query.page || 1;
  const limit = req.query.limit || 10;
  const status = req.query.status;
  const cancelledBy = req.query.cancelledBy;

  const result = await RideService.rideHistory(
    userId,
    role,
    page,
    limit,
    status,
    cancelledBy,
  );

  return result;
};

const generateSharedRideLinkController = async (req, res) => {
  const rideId = req.params.id;
  const locale = req.user.locale;

  const result = await RideService.generateSharedRideLink(rideId, locale);

  return result;
};

const iAmComingController = async (req, res) => {
  const rideId = req.params.id;
  const io = req?.app?.get("io");

  const result = await RideService.iAmComing(rideId, io, req.user.id);

  return result;
};

const getRideOffers = async (req, res) => {
  const rideId = req.params.id;
  const result = await RideService.getRideOffers(rideId);
  return {
    data: {
      offers: result,
    },
  };
};

module.exports = {
  getRidesForDriver,
  getRideById,
  rideFareCalculatorController,
  generateSharedRideLinkController,
  rideHistoryController,
  iAmComingController,
  getRideOffers,
};
