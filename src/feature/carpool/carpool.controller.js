const RideModel = require("../ride/model/ride.model");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const { RIDE_STATUS } = require("../../core/common/constants/ride-constants");
const CarpoolService = require("./carpool.services");

const redis = getRedisConnection();
const DRIVER_GEO_KEY = "drivers:geo";

const getPendingRidesController = async (req, res) => {
  try {
    const driverId = req.user._id.toString();

    /*
        1️⃣ Get driver location from Redis
    */
    const position = await redis.geopos(DRIVER_GEO_KEY, driverId);

    if (!position || !position[0]) {
      return res.status(400).json({
        success: false,
        message: "Driver location not found. Please update location first.",
      });
    }

    const [lng, lat] = position[0].map(Number);

    /*
        2️⃣ Fetch nearby requested rides using Mongo geo query
        (Automatically sorted by nearest)
    */
    const nearbyRides = await RideModel.find({
      rideStatus: RIDE_STATUS.REQUESTED,
      "pickupPoint.location": {
        $near: {
          $geometry: {
            type: "Point",
            coordinates: [lng, lat],
          },
          $maxDistance: 5000, // 5km in meters
        },
      },
    });

    return res.json({
      success: true,
      total: nearbyRides.length,
      data: nearbyRides,
    });
  } catch (error) {
    console.error("Get pending rides error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

const findMatchingCarpoolsController = async (req, res) => {
  const passengerId = req.user.id;
  const data = req.body;

  const result = await CarpoolService.incomingCarpoolMatches(passengerId, data);

  return result;
};

const carpoolPassengersController = async (req, res) => {
  const carpoolId = req.params.id;

  const passengers = await CarpoolService.carpoolPassengers(carpoolId);

  return passengers;
};

const carpoolHistoryController = async (req, res) => {
  const role = req.session.role;
  const id = req.user.id;
  const page = req.query.page;
  const limit = req.query.limit;

  const result = await CarpoolService.carpoolHistory(id, role, page, limit);

  return result;
};

const carpoolByIdController = async (req, res) => {
  const id = req.params.id;

  const result = await CarpoolService.getCarpoolById(id);

  return result;
};

const carpoolDetailsController = async (req, res) => {
  const id = req.params.id;
  const role = req.session.role;
  const userId = req.user.id;

  const result = await CarpoolService.carpoolDetails(id, userId, role);

  return result;
};

const viewCarpoolPassengersController = async (req, res) => {
  const carpoolId = req.params.id;
  const driverId = req.user.id;

  const passengers = await CarpoolService.viewCarpoolPassengers(
    carpoolId,
    driverId,
  );

  return passengers;
};

const generateSharedCarpoolLinkController = async (req, res) => {
  const carpoolId = req.params.id;
  const locale = req.user.locale;

  const result = await CarpoolService.generateSharedCarpoolLink(
    carpoolId,
    locale,
    req.user.id,
  );

  return result;
};

module.exports = {
  getPendingRidesController,
  findMatchingCarpoolsController,
  carpoolPassengersController,
  carpoolHistoryController,
  carpoolByIdController,
  carpoolDetailsController,
  viewCarpoolPassengersController,
  generateSharedCarpoolLinkController,
};
