const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const geolib = require("geolib");
const jwt = require("jsonwebtoken");
const colors = require("colors");
const en = require("../locales/en.json");
const es = require("../locales/es.json");
const env = require("../../../../config/index");
const PeakWindowModel = require("../../../feature/ride/model/peak-window.model");
const { BadRequestError } = require("../exceptions");
const { CARPOOL_ERROR_KEYS } = require("../constants/carpool-constants");
const LoggedDeviceModel = require("../../../feature/auth/models/logged.device.model");
const { default: mongoose } = require("mongoose");
const { getRideDriverFare } = require("./driver-fare.helper");

const translations = {
  en,
  es,
};

const normalizeLocale = (locale, fallback = "en") => {
  if (!locale) return fallback;

  const normalized = String(locale)
    .trim()
    .split(",")[0]
    .split(/[-_]/)[0]
    .toLowerCase();

  return translations[normalized] ? normalized : fallback;
};

const getRequestLocale = (req, fallback = "en") =>
  normalizeLocale(
    req?.body?.locale ||
      req?.headers?.locale ||
      req?.headers?.language ||
      req?.headers?.["accept-language"],
    fallback,
  );

const routeAdder = (app, routesDir) => {
  console.log(colors.blue("\n🚀 Starting route registration...\n"));

  const loadRoutesRecursively = (dir) => {
    fs.readdirSync(dir).forEach((item) => {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      // If directory → go deeper
      if (stat.isDirectory()) {
        loadRoutesRecursively(fullPath);
        return;
      }

      // Only allow *.routes.js
      if (!item.endsWith(".routes.js")) {
        return;
      }

      try {
        const route = require(fullPath);

        if (!route?.path || !route?.router) {
          console.log(
            colors.red(
              `❌ Invalid route export in ${item} (missing path/router)`,
            ),
          );
          return;
        }

        app.use(`/api${route.path}`, route.router);

        console.log(colors.green(`✅ Route mounted: ${route.path} → ${item}`));
      } catch (error) {
        console.error(colors.red(`🔥 Failed to load route ${item}`), error);
      }
    });
  };

  loadRoutesRecursively(routesDir);

  console.log(colors.blue("\n✅ All routes registered\n"));
};

const makeDirectories = async () => {
  const parent = "./uploads";
  const dirnames = ["pictures", "videos"];
  try {
    fs.mkdir(parent, { recursive: true }, (err) => {
      if (err) throw err;
      for (const dirname of dirnames) {
        const dirPath = path.join(parent, dirname);
        fs.mkdir(dirPath, { recursive: true }, (err) => {
          if (err) throw err;
        });
      }
      console.log("All directories checked or created successfully.");
    });
  } catch (err) {
    console.error(err);
  }
};

const generateToken = (data, expiresIn) => {
  return jwt.sign(data, env.JWT_SECRET, {
    expiresIn: expiresIn ?? env.JWT_EXPIRES_IN,
  });
};

const calculateDistance = (coords1, coords2) => {
  const distanceInMeters = geolib.getDistance(
    { latitude: coords1[1], longitude: coords1[0] },
    { latitude: coords2[1], longitude: coords2[0] },
  );

  // Convert meters to miles
  const distanceInMiles = distanceInMeters / 1609.34;
  return distanceInMiles.toFixed(2);
};

const generateNumericOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const createMulter = (options = {}) => {
  const { maxSize = 50 * 1024 * 1024, allowVideos = true } = options;

  return multer({
    storage: multer.memoryStorage(),

    limits: {
      fileSize: maxSize,
    },

    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();

      const imageTypes = [".jpg", ".jpeg", ".png", ".webp"];
      const videoTypes = [".mp4", ".mov", ".avi", ".mkv"];

      if (imageTypes.includes(ext)) {
        req.uploadFolder = "images";
        return cb(null, true);
      }

      if (allowVideos && videoTypes.includes(ext)) {
        req.uploadFolder = "videos";
        return cb(null, true);
      }

      cb(new Error("Unsupported file type"), false);
    },
  });
};

const getTime = () => {
  return Math.floor(new Date().getTime() / 1000);
};

const delay = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const dollarToCents = (dollar) => {
  return dollar * 100;
};

const centsToDollars = (cents) => {
  return cents / 100;
};

const calculateStripeFees = (amountInDollars) => {
  return 0.3 + amountInDollars * 0.029;
};

const calculateApplicationFees = (amountInDollars) => {
  return (amountInDollars * env.STRIPE_TEST_APPLICATION_FEE) / 100;
};

const generateOrderCode = (prefixLength = 3, digitLength = 6) => {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const prefix = Array.from(
    { length: prefixLength },
    () => letters[Math.floor(Math.random() * letters.length)],
  ).join("");

  // Generate the digits part using map
  const digitsPart = Array.from(
    { length: digitLength },
    () => digits[Math.floor(Math.random() * digits.length)],
  ).join("");

  return `${prefix}-${digitsPart}`;
};

const paginate = async (model, query, page = 1, limit = 10) => {
  const currentPage = parseInt(page, 10);
  const itemsPerPage = parseInt(limit, 10);
  const skip = (currentPage - 1) * itemsPerPage;

  const totalCount = await model.countDocuments(query);
  const totalPages = Math.ceil(totalCount / itemsPerPage);

  return {
    skip,
    pagination: {
      itemsPerPage,
      currentPage,
      totalItems: totalCount,
      totalPages,
    },
  };
};

const aggregatePaginate = async (model, query, page = 1, limit = 10) => {
  const currentPage = parseInt(page, 10);
  const itemsPerPage = parseInt(limit, 10);
  const skip = (currentPage - 1) * itemsPerPage;

  const [result = {}] = await model.aggregate([
    ...query,
    { $count: "totalCount" },
  ]);

  const { totalCount = 0 } = result;
  const totalPages = Math.ceil(totalCount / itemsPerPage);
  return {
    skip,
    pagination: {
      page: itemsPerPage,
      currentPage,
      total: totalCount,
      totalPages,
    },
  };
};

const emitEventToRoom = (io, { room, event, payload = {} }) => {
  if (!io || !room || !event) return;

  io.to(room).emit(event, payload);
};

const emitEventToRoomExceptSender = (socket, { room, event, payload = {} }) => {
  if (!socket || !room || !event) {
    throw new Error("emitEventToRoomExceptSender: Missing required parameters");
  }

  socket.to(room).emit(event, payload);
};

const capitalize = (str) =>
  str
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

const t = (key, lang = "en") => {
  const locale = normalizeLocale(lang);
  return translations[locale]?.[key] || translations.en[key] || key;
};

function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _resolveStripeError(stripeError) {
  const code = stripeError.code;
  const declineCode = stripeError.decline_code;

  /* Decline codes — most specific, check first */
  const declineMap = {
    insufficient_funds: "CARD_INSUFFICIENT_FUNDS",
    lost_card: "CARD_LOST",
    stolen_card: "CARD_STOLEN",
    expired_card: "CARD_EXPIRED",
    incorrect_cvc: "CARD_INCORRECT_CVC",
    incorrect_number: "CARD_INCORRECT_NUMBER",
    do_not_honor: "CARD_DECLINED",
    generic_decline: "CARD_DECLINED",
    fraudulent: "CARD_DECLINED_FRAUD",
    card_velocity_exceeded: "CARD_LIMIT_EXCEEDED",
  };

  if (declineCode && declineMap[declineCode]) {
    return declineMap[declineCode];
  }

  /* Error codes — broader Stripe errors */
  const codeMap = {
    card_declined: "CARD_DECLINED",
    expired_card: "CARD_EXPIRED",
    incorrect_cvc: "CARD_INCORRECT_CVC",
    incorrect_number: "CARD_INCORRECT_NUMBER",
    invalid_expiry_month: "CARD_INVALID_EXPIRY",
    invalid_expiry_year: "CARD_INVALID_EXPIRY",
    invalid_cvc: "CARD_INCORRECT_CVC",
    invalid_number: "CARD_INCORRECT_NUMBER",
    processing_error: "CARD_PROCESSING_ERROR",
    rate_limit: "PAYMENT_RATE_LIMIT",
    authentication_required: "CARD_AUTHENTICATION_REQUIRED",
  };

  if (code && codeMap[code]) {
    return codeMap[code];
  }

  return "PAYMENT_FAILED";
}

const formatZodErrors = (error) => {
  const issues = error?.issues ?? error?.errors ?? [];

  if (!issues.length) {
    return { general: ["Validation failed"] };
  }

  const formattedErrors = {};

  for (const issue of issues) {
    const path = issue.path?.length ? issue.path.join(".") : "general";

    if (!formattedErrors[path]) {
      formattedErrors[path] = [];
    }

    formattedErrors[path].push(issue.message);
  }

  return formattedErrors;
};

function ok(callback, message, data = {}) {
  return callback({ success: true, message, data });
}

function fail(callback, message, code = null) {
  return callback({ success: false, message, ...(code ? { code } : {}) });
}

function validateOrFail(validator, payload, callback) {
  const parsed = validator.safeParse(payload);

  if (!parsed.success) {
    const errors = formatZodErrors(parsed.error);
    // Flatten all error messages into a single string
    const message = Object.values(errors).flat().join(", ");
    if (typeof callback === "function") {
      fail(callback, message);
    }
    return null;
  }

  return parsed.data;
}
function resolveErrorMessage(err, lang = "en") {
  const key = err.message;
  if (CARPOOL_ERROR_KEYS.includes(key)) {
    return t(key, lang);
  }
  return t("CARPOOL_UNEXPECTED_ERROR", lang);
}

async function isPeakTime(date = new Date()) {
  const floridaTime = new Date(
    date.toLocaleString("en-US", { timeZone: env.BUSINESS_TIME_ZONE }),
  );

  const hour = floridaTime.getHours();

  const windows = await PeakWindowModel.find({ isActive: true });

  return windows.some(
    ({ startHour, endHour }) => hour >= startHour && hour < endHour,
  );
}

function formatFullName(person) {
  if (!person) return "";
  const parts = [person.firstName, person.lastName].filter(
    (v) => v != null && String(v).trim() !== "",
  );
  return parts.join(" ").trim();
}

function secondsToWords(seconds, locale = "en") {
  const isSpanish = normalizeLocale(locale) === "es";

  if (!Number.isFinite(seconds) || seconds < 0) {
    return isSpanish
      ? "que un administrador la reactive"
      : "an administrator reactivates it";
  }

  if (seconds < 60) {
    return isSpanish
      ? `${seconds} segundo${seconds === 1 ? "" : "s"}`
      : `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return isSpanish
      ? `${minutes} minuto${minutes === 1 ? "" : "s"}`
      : `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(seconds / 3600);
  return isSpanish
    ? `${hours} hora${hours === 1 ? "" : "s"}`
    : `${hours} hour${hours === 1 ? "" : "s"}`;
}

// Parsers

/**
 * What the apps are told about a ride cancelled after Start Ride: the money
 * each side needs to show. The internals stay on the ride document.
 */
function toMidTripSummary(settlement) {
  if (!settlement?.status) return null;

  return {
    status: settlement.status,
    cancelledBy: settlement.cancelledBy ?? null,
    paymentMethod: settlement.paymentMethod ?? null,
    share: settlement.share ?? null,
    travelledMiles: settlement.travelledMiles ?? null,
    elapsedMinutes: settlement.elapsedMinutes ?? null,
    riderPaid: settlement.riderPaid ?? null,
    riderCharged: settlement.riderCharged ?? null,
    riderRefund: settlement.riderRefund ?? null,
    driverKept: settlement.driverKept ?? null,
    settledAt: settlement.settledAt ?? null,
  };
}

function parseRide(ride) {
  if (!ride) return null;

  const midTripCancellation = toMidTripSummary(ride.midTripCancellation);

  return {
    id: ride._id,
    status: ride.rideStatus,
    fare: ride.rideFare,
    // After a mid-trip cancellation the driver keeps only the delivered share.
    driverFare:
      midTripCancellation?.status === "completed"
        ? midTripCancellation.driverKept
        : getRideDriverFare(ride),
    distance: ride.rideDistance,
    duration: ride.averageTime,
    pickupPoint: ride.pickupPoint,
    dropOffPoint: ride.dropOffPointRequested,
    createdAt: ride.createdAt,
    paymentMethod: ride.paymentMethod,
    specialRequest: ride.specialRequest,
    midTripCancellation,

    user: ride.user
      ? {
          id: ride.user?._id,
          firstName: ride.user?.firstName,
          lastName: ride.user?.lastName,
          profilePicture: ride.user?.profilePicture,
          rating: ride.user?.rating,
          reviews: ride.user?.reviewsReceived,
        }
      : null,

    driver: ride.driver
      ? {
          id: ride.driver?._id,
          firstName: ride.driver?.firstName,
          lastName: ride.driver?.lastName,
          profilePicture: ride.driver?.profilePicture,
          rating: ride.driver?.rating,
          reviews: ride.driver?.reviewsReceived,
          phone: ride.driver?.phone,

          vehicle: ride.driver?.vehicleDetails
            ? {
                id: ride.driver?.vehicleDetails?._id,
                make: ride.driver?.vehicleDetails?.make,
                model: ride.driver?.vehicleDetails?.model,
                year: ride.driver?.vehicleDetails?.yearOfManufacture,
                color: ride.driver?.vehicleDetails?.color,
                plate: ride.driver?.vehicleDetails?.licensePlateNumber,
                vehicleType: ride.driver?.vehicleDetails?.vehicleType,
                // Kept for clients using the original response shape.
                type: ride.driver?.vehicleDetails?.vehicleType,
              }
            : null,
        }
      : null,
  };
}

const encodeSharedLink = (key, locale, queryParamName = "ride") => {
  const FRONTEND_URL = env.FRONTEND_URL;

  if (!FRONTEND_URL)
    throw new BadRequestError(t("FRONTEND_URL_NOT_CONFIGURED", locale));

  if (!key) throw new BadRequestError(t("REFERRAL_KEY_REQUIRED", locale));

  const encodedKey = Buffer.from(key, "utf-8").toString("base64");
  return `${FRONTEND_URL}/share?${queryParamName}=${encodedKey}`;
};

const decodeSharedKey = (encodedValue) => {
  const decodedKey = Buffer.from(encodedValue, "base64").toString("utf-8");
  return decodedKey;
};

const isUserOnAuthenticatedDevice = async (userId, loggedId) => {
  const record = await LoggedDeviceModel.findOne({
    _id: new mongoose.Types.ObjectId(loggedId),
    user: new mongoose.Types.ObjectId(userId),
  });

  return !!record;
};

const hashPassword = async (password) => {
  if (!password) return undefined;
  return bcrypt.hash(password, 12);
};

const comparePassword = async (plain, hashed) => {
  return bcrypt.compare(plain, hashed);
};

function getAgeFromTimestamp(timestamp) {
  const birthDate = new Date(timestamp);
  const today = new Date();

  let age = today.getFullYear() - birthDate.getFullYear();

  const hasHadBirthdayThisYear =
    today.getMonth() > birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() &&
      today.getDate() >= birthDate.getDate());

  if (!hasHadBirthdayThisYear) {
    age--;
  }

  return age;
}

module.exports = {
  makeDirectories,
  calculateDistance,
  generateNumericOTP,
  createMulter,
  getTime,
  generateToken,
  delay,
  dollarToCents,
  centsToDollars,
  calculateStripeFees,
  calculateApplicationFees,
  generateOrderCode,
  routeAdder,
  paginate,
  aggregatePaginate,
  emitEventToRoom,
  emitEventToRoomExceptSender,
  capitalize,
  t,
  normalizeLocale,
  getRequestLocale,
  getDistanceInMeters,
  formatZodErrors,
  ok,
  fail,
  validateOrFail,
  parseRide,
  toMidTripSummary,
  isUserOnAuthenticatedDevice,
  isPeakTime,
  encodeSharedLink,
  decodeSharedKey,
  secondsToWords,
  resolveErrorMessage,
  _resolveStripeError,
  hashPassword,
  comparePassword,
  getAgeFromTimestamp,
  formatFullName,
};
