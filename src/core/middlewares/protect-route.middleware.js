const jwt = require("jsonwebtoken");

const UserModel = require("../../feature/user/models/user.model.js");
const DriverModel = require("../../feature/driver/models/driver.model.js");
const {
  UnauthorizedError,
  AppError,
  BadRequestError,
} = require("../common/exceptions.js");

const env = require("../../../config/index.js");
const LoggedDeviceModel = require("../../feature/auth/models/logged.device.model.js");
const AdminModel = require("../../feature/admin/model/admin.model.js");
const { ADMIN_ROLES } = require("../common/constants/index.js");

const protectRouteMiddleware = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      throw new UnauthorizedError("Unauthorized - No token provided");
    }

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
    } catch (error) {
      throw new UnauthorizedError("Please re-login to access this resource");
    }

    if (!Object.values(ADMIN_ROLES).includes(decoded.role)) {
      // We only check in LoggedDeviceModel for non admin roles
      const loggedDeviceRecord = await LoggedDeviceModel.findById(
        decoded.loggedId,
      );

      if (!loggedDeviceRecord) {
        throw new UnauthorizedError("Please re-login.");
      }

      const user =
        decoded.role === "user"
          ? await UserModel.findOne({
              _id: decoded.id,
              isDeleted: false,
              isDeactivatedByAdmin: false,
            })
          : await DriverModel.findOne({
              _id: decoded.id,
              isDeleted: false,
              isDeactivatedByAdmin: false,
            }).populate("subscription");

      if (!user) {
        throw new UnauthorizedError("No such user found - Access denied");
      }

      if (
        decoded.role === "driver" &&
        !req.originalUrl.includes("/subscription/purchase") &&
        !req.originalUrl.includes("/auth/account-status")
      ) {
        if (!user.subscription || user.subscription.status !== "active") {
          throw new BadRequestError(
            "Your subscription is not active - Access denied",
          );
        }
      }

      req.user = user;
      req.session = {
        id: loggedDeviceRecord.id,
        role: decoded.role,
      };
    } else {
      const admin = await AdminModel.findById(decoded.id).lean();

      if (!admin) {
        throw new UnauthorizedError("No such admin found - Access denied");
      }

      req.user = { ...admin, role: admin.role };
    }
    next();
  } catch (error) {
    console.log(error);
    next(
      error instanceof AppError
        ? error
        : new AppError("Authentication failed", 401),
    );
  }
};

module.exports = protectRouteMiddleware;
