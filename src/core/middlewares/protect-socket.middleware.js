const jwt = require("jsonwebtoken");
const env = require("../../../config");
const UserModel = require("../../feature/user/models/user.model");
const DriverModel = require("../../feature/driver/models/driver.model");
const LoggedDeviceModel = require("../../feature/auth/models/logged.device.model");
const { UnauthorizedError } = require("../common/exceptions");

module.exports = async function socketAuthMiddleware(socket, next) {
  try {
    const token = socket.handshake.headers.token;
    const origin = socket.handshake.query.origin || "app";
    const rideId = socket.handshake.query.rideId ?? socket.handshake.query.ride;
    const carpoolId =
      socket.handshake.query.carpoolId ?? socket.handshake.query.carpool;

    if (origin == "web") {
      socket.metadata = { rideId, carpoolId, role: "guest" };
      return next();
    }

    if (!token) {
      return next(new Error("Authentication token missing or malformed"));
    }

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch (err) {
      console.log(err);
      return next(new Error("Unauthorized - Invalid or expired token"));
    }

    const roleModelMap = {
      user: UserModel,
      driver: DriverModel,
    };

    const Model = roleModelMap[decoded.role];
    if (!Model) {
      return next(new Error("Unauthorized - Invalid role"));
    }

    const loggedDeviceRecord = await LoggedDeviceModel.findById(
      decoded.loggedId,
    );

    if (!loggedDeviceRecord) {
      throw new UnauthorizedError("Please re-login.");
    }

    const user = await Model.findOne({
      _id: decoded.id,
      isDeleted: false,
    }).select("_id firstName lastName email vehicleType locale");

    if (!user) {
      return next(new Error("Unauthorized - User not found"));
    }

    user.role = decoded.role;
    socket.user = user;
    socket.loggedId = decoded.loggedId;
    next();
  } catch (error) {
    next(error);
  }
};
