const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const AdminModel = require("./model/admin.model");
const DocumentModel = require("../driver/models/documents.model");
const VehicleModel = require("../driver/models/vehicle.model");
const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const SignupModel = require("../auth/models/signup.model");
const RideModel = require("../ride/model/ride.model");
const RideOfferModel = require("../ride/model/ride-offer.model");
const {
  getRideHistoryVisibilityFilter,
} = require("../ride/ride-history.helper");
require("../promo-code/model/promo-code.model");
require("../promo-code/model/promo-code-campaign.model");
const RideRateModel = require("../ride/model/ride-rate.model");
const CityRideRateModel = require("../ride/model/city-ride-rate.model");
const { normalizeCity, sortBrackets } = require("../ride/fare-pricing.helper");
const PeakWindowModel = require("../ride/model/peak-window.model");
const TransactionModel = require("../transactions/model/transaction.model");
const { BALANCE_SOURCES, normalizeMoney } = require("../wallet/wallet.service");
const LoggedDeviceModel = require("../auth/models/logged.device.model");
const ReviewModel = require("../reviews/models/review.model");
const SubscriptionModel = require("../subscription/models/subscription.model");
const ReportModel = require("../reports/models/report.model");
const CarpoolRouteModel = require("../carpool/model/carpool-route.model");
const CarpoolBookingModel = require("../carpool/model/carpool-booking.model");
const { rideHistory } = require("../ride/ride.service");
const { carpoolHistory } = require("../carpool/carpool.services");
const {
  UnauthorizedError,
  BadRequestError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} = require("../../core/common/exceptions");

const env = require("../../../config/index");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const ScheduledNotificationModel = require("../notification/models/scheduled-notification.model");
const NotificationModel = require("../notification/models/notification.model");
const NotificationContentModel = require("../notification/models/notification_content.model");
const {
  NODEMAILER,
  TEST_OTP,
  OTP_EXP_MINUTES,
} = require("../../../config/index");
const {
  generateNumericOTP,
  aggregatePaginate,
  generateToken,
  comparePassword,
  hashPassword,
  t,
} = require("../../core/common/helpers/index");

const { maskSsn } = require("../../core/common/helpers/ssn.helper");
const otpEmailTemplate = require("../../core/services/email/templates/send-otp.template");
const { sendEmail } = require("../../core/services/email/email.service");
const {
  buildDriverVerificationEmail,
} = require("../../core/services/email/driver-verification-email.helper");
const AdminOTPModel = require("./model/admin.otp.model");
const CardModel = require("../card/models/card.model");
const BankModel = require("../bank/models/bank.model");
const {
  getVisibleIdentityEmailFilter,
  getInternalIdentityEmailFilter,
  INTERNAL_IDENTITY_EMAIL_PATTERN,
  isInternalIdentityEmail,
  shouldRestrictInternalData,
  combineMongoFilters,
  getRideIdentityFilter,
  getCarpoolRouteIdentityFilter,
  getCarpoolBookingIdentityFilter,
  getTransactionIdentityFilter,
  getReportIdentityFilter,
  getReviewIdentityFilter,
} = require("./admin-data-visibility.helper");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  DRIVER_SOCKET_EVENTS,
  DRIVER,
  RIDE,
  ACTIVE,
  USER,
  CANCELLATIONS,
} = require("../../core/common/constants/ride-constants");
const { ADMIN_ROLES } = require("../../core/common/constants");
const RideConfigurationService = require("../config/ride-configuration.service");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");

const redis = getRedisConnection();

const getRestrictedIdentityIds = async (adminUser) => {
  if (!shouldRestrictInternalData(adminUser)) {
    return {
      userIds: [],
      driverIds: [],
      adminIds: [],
      documentIds: [],
      vehicleIds: [],
    };
  }

  const internalEmailFilter = getInternalIdentityEmailFilter();
  const [users, drivers, admins] = await Promise.all([
    UserModel.find(internalEmailFilter).select("_id").lean(),
    DriverModel.find(internalEmailFilter)
      .select("_id driverLicense vehicleRegistration insurance vehicleDetails")
      .lean(),
    AdminModel.find(internalEmailFilter).select("_id").lean(),
  ]);

  return {
    userIds: users.map((user) => user._id),
    driverIds: drivers.map((driver) => driver._id),
    adminIds: admins.map((admin) => admin._id),
    documentIds: drivers.flatMap((driver) =>
      [
        driver.driverLicense,
        driver.vehicleRegistration,
        driver.insurance,
      ].filter(Boolean),
    ),
    vehicleIds: drivers.map((driver) => driver.vehicleDetails).filter(Boolean),
  };
};

const assertVisibleIdentity = async (Model, id, adminUser, label = "User") => {
  if (!shouldRestrictInternalData(adminUser)) return;

  const isVisible = await Model.exists(
    combineMongoFilters({ _id: id }, getVisibleIdentityEmailFilter(adminUser)),
  );

  if (!isVisible) throw new NotFoundError(`${label} not found`);
};

const login = async (email, password) => {
  const admin = await AdminModel.findOne({ email }).select("+password");

  if (!admin) {
    throw new UnauthorizedError("Invalid email or password");
  }

  if (!admin.isActive) {
    throw new UnauthorizedError("Account is deactivated");
  }

  const isMatch = await admin.comparePassword(password);

  if (!isMatch) {
    throw new UnauthorizedError("Invalid email or password");
  }

  admin.lastLogin = new Date();
  await admin.save();

  const token = jwt.sign(
    {
      id: admin._id,
      role: admin.role,
    },
    env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  return {
    data: {
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    },
  };
};

const forgotPasswordAdmin = async (email) => {
  const admin = await AdminModel.findOne({
    email: String(email).toLowerCase(),
    isActive: true,
  });

  if (!admin) {
    throw new BadRequestError("No Admin Found with the provided email");
  }

  const otp = NODEMAILER.IS_ENABLED ? generateNumericOTP() : TEST_OTP;
  const expiresAt = new Date(Date.now() + OTP_EXP_MINUTES * 60 * 1000);

  const otpRes = await AdminOTPModel.create({
    email: admin.email,
    otp: otp,
  });

  // send email logic

  const template = otpEmailTemplate(otp);

  const sendEmail = async () => {
    await sendEmail({
      message: template,
      recipient: email,
      subject: "OTP verification",
    });
  };

  if (sendEmail) {
    console.log("OTP sent to email successfully");
  }
  return true;
};

const verifyOtp = async ({ otp, email }) => {
  const admin = await AdminModel.findOne({
    email: String(email).toLowerCase(),
    isActive: true,
  });

  if (!admin) {
    throw new BadRequestError("No User Found");
  }

  const getOtpRecord = await AdminOTPModel.findOne({
    email: admin.email,
    otp,
  });

  if (!getOtpRecord) {
    throw new BadRequestError("Invalid or Expire Otp");
  }

  await AdminOTPModel.deleteMany({
    email: admin.email,
  });

  const loggedDevice = await LoggedDeviceModel.create({
    user: admin._id,
    userType: "Admin",
  });

  console.log(loggedDevice);
  const token = generateToken(
    {
      id: admin._id,
      role: "admin",
      loggedId: loggedDevice._id,
    },

    "5m",
  );

  return {
    data: {
      token,
    },
  };
};

const resetPasswordAdmin = async (user, payload) => {
  const { newPassword } = payload;
  const hashPass = await hashPassword(newPassword);
  const updateRec = await AdminModel.findOneAndUpdate(
    {
      _id: user._id,
    },
    {
      password: hashPass,
    },
  );

  return true;
};

const updatePassword = async (user, payload) => {
  const { currentPassword, newPassword } = payload;

  const admin = await AdminModel.findById(user._id).select("+password");
  if (!admin) {
    throw new NotFoundError("Admin not found");
  }
  const isMatch = await comparePassword(currentPassword, admin.password);

  if (!isMatch) {
    throw new BadRequestError("Current password is incorrect");
  }

  const hashPass = await hashPassword(newPassword);

  const updatedAdmin = await AdminModel.findByIdAndUpdate(
    user._id,
    { password: hashPass },
    { new: true },
  );
  return updatedAdmin;
};
const getDrivers = async (query, adminUser) => {
  const {
    page = 1,
    limit = 10,
    status,
    from,
    to,
    driverId,
    search,
    order,
  } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const matchStage = {
    isDeleted: false,
    ...getVisibleIdentityEmailFilter(adminUser),
  };

  if (driverId) matchStage._id = new mongoose.Types.ObjectId(driverId);

  if (search) {
    const parts = search.trim().split(/\s+/);
    const nameQueries = parts.map((part) => ({
      $or: [
        { firstName: { $regex: part, $options: "i" } },
        { lastName: { $regex: part, $options: "i" } },
      ],
    }));

    matchStage.$or = [
      { $and: nameQueries },
      { email: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
    ];
  }

  if (from || to) {
    matchStage.createdAt = {};
    if (from) matchStage.createdAt.$gte = new Date(from);
    if (to) matchStage.createdAt.$lte = new Date(to);
  }

  // Enrich only the requested page, after status eligibility is established.
  const enrichmentPipeline = [
    {
      $lookup: {
        from: "documents",
        localField: "_id",
        foreignField: "driver",
        let: { driverId: "$_id" },
        pipeline: [
          { $match: { status: { $eq: "pending" } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: "$type",
              latestDoc: { $first: "$$ROOT" },
            },
          },
          { $replaceRoot: { newRoot: "$latestDoc" } },
          { $project: { type: 1, status: 1 } },
        ],
        as: "pendingDocuments",
      },
    },
    {
      $lookup: {
        from: "vehicles",
        localField: "_id",
        foreignField: "driver",
        pipeline: [
          { $match: { isDeleted: false } },
          { $project: { status: 1 } },
        ],
        as: "vehiclesInfo",
      },
    },
    {
      $addFields: {
        vehicleCount: { $size: "$vehiclesInfo" },
        hasPendingVehicles: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: "$vehiclesInfo",
                  as: "v",
                  cond: { $in: ["$$v.status", ["pending", "rejected"]] },
                },
              },
            },
            0,
          ],
        },
        requiresApproval: {
          $or: [
            { $gt: [{ $size: "$pendingDocuments" }, 0] },
            {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: "$vehiclesInfo",
                      as: "v",
                      cond: { $eq: ["$$v.status", "pending"] },
                    },
                  },
                },
                0,
              ],
            },
          ],
        },
      },
    },
    {
      $project: {
        firstName: 1,
        lastName: 1,
        email: 1,
        phone: 1,
        ssn: 1,
        createdAt: 1,
        pendingDocuments: 1,
        vehicleCount: 1,
        hasPendingVehicles: 1,
        requiresApproval: 1,
        isDeactivatedByAdmin: 1,
      },
    },
  ];

  const skip = (parsedPage - 1) * parsedLimit;

  const pagePipeline = [
    { $sort: { createdAt: order === "asc" ? 1 : -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
    ...enrichmentPipeline,
  ];

  let drivers;
  let totalCount;

  if (status) {
    // Start with eligible child records instead of inspecting every driver.
    // The original document lookup includes only pending documents, including
    // soft-deleted ones; retain that behavior when matching a status.
    const eligibilityPipeline = [
      {
        $match: {
          status,
          isDeleted: false,
          ...(driverId && { driver: matchStage._id }),
        },
      },
      { $group: { _id: "$driver" } },
      ...(status === "pending"
        ? [
            {
              $unionWith: {
                coll: DocumentModel.collection.name,
                pipeline: [
                  {
                    $match: {
                      status: "pending",
                      ...(driverId && { driver: matchStage._id }),
                    },
                  },
                  { $group: { _id: "$driver" } },
                ],
              },
            },
            { $group: { _id: "$_id" } },
          ]
        : []),
      {
        $lookup: {
          from: DriverModel.collection.name,
          localField: "_id",
          foreignField: "_id",
          as: "driver",
        },
      },
      { $unwind: "$driver" },
      { $replaceRoot: { newRoot: "$driver" } },
      { $match: matchStage },
      {
        $facet: {
          data: pagePipeline,
          metadata: [{ $count: "totalCount" }],
        },
      },
    ];

    const [result = {}] = await VehicleModel.aggregate(eligibilityPipeline);
    drivers = result.data || [];
    totalCount = result.metadata?.[0]?.totalCount || 0;
  } else {
    [drivers, totalCount] = await Promise.all([
      DriverModel.aggregate([{ $match: matchStage }, ...pagePipeline]),
      DriverModel.countDocuments(matchStage),
    ]);
  }
  const pagination = {
    page: parsedLimit,
    currentPage: parsedPage,
    total: totalCount,
    totalPages: Math.ceil(totalCount / parsedLimit),
  };

  return {
    data: drivers.map((driver) => ({
      ...driver,
      ssn: maskSsn(driver.ssn),
      hasSsn: Boolean(driver.ssn),
    })),
    pagination,
  };
};

const getDocuments = async (query, adminUser) => {
  const { page = 1, limit = 10, status, from, to, type, driverId } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const { driverIds, documentIds } = await getRestrictedIdentityIds(adminUser);
  const matchStage = {
    ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
    ...(documentIds.length > 0 && { _id: { $nin: documentIds } }),
  };

  if (status) matchStage.status = status;
  if (type) matchStage.type = type;
  if (driverId) {
    await assertVisibleIdentity(DriverModel, driverId, adminUser, "Driver");
    matchStage.driver = new mongoose.Types.ObjectId(driverId);
  }

  if (from || to) {
    matchStage.createdAt = {};
    if (from) matchStage.createdAt.$gte = new Date(from);
    if (to) matchStage.createdAt.$lte = new Date(to);
  }

  const documentsPipeline = [
    { $match: matchStage },
    {
      $project: {
        frontImage: 1,
        backImage: 1,
        metadata: 1,
        status: 1,
        rejectReason: 1,
        type: 1,
        veriffSessionId: 1,
        driver: 1,
        createdAt: 1,
      },
    },
  ];

  const { skip, pagination } = await aggregatePaginate(
    DocumentModel,
    documentsPipeline,
    parsedPage,
    parsedLimit,
  );

  documentsPipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  );

  const documents = await DocumentModel.aggregate(documentsPipeline);

  return {
    data: documents,
    pagination,
  };
};

const getVehicles = async (query, adminUser) => {
  const { page = 1, limit = 10, search, status, from, to, driverId } = query;
  const filter = {};
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const { driverIds, vehicleIds } = await getRestrictedIdentityIds(adminUser);
  const matchStage = {
    isDeleted: false,
    ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
    ...(vehicleIds.length > 0 && { _id: { $nin: vehicleIds } }),
  };

  if (status) matchStage.status = status;
  if (driverId) {
    await assertVisibleIdentity(DriverModel, driverId, adminUser, "Driver");
    matchStage.driver = new mongoose.Types.ObjectId(driverId);
  }
  if (search) {
    filter.model = { $regex: search, $options: "i" };
  }
  if (from || to) {
    matchStage.createdAt = {};
    if (from) matchStage.createdAt.$gte = new Date(from);
    if (to) matchStage.createdAt.$lte = new Date(to);
  }

  const vehiclesPipeline = [
    { $match: matchStage },
    { $match: filter },
    {
      $project: {
        model: 1,
        yearOfManufacture: 1,
        color: 1,
        vehicleIdentificationNumber: 1,
        licensePlateNumber: 1,
        // registrationNumber: 1,
        regionOfRegistration: 1,
        expiryDate: 1,
        vehicleType: 1,
        status: 1,
        rejectReason: 1,
        driver: 1,
        createdAt: 1,
      },
    },
  ];

  const { skip, pagination } = await aggregatePaginate(
    VehicleModel,
    vehiclesPipeline,
    parsedPage,
    parsedLimit,
  );

  vehiclesPipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  );

  const vehicles = await VehicleModel.aggregate(vehiclesPipeline);

  return {
    data: vehicles,
    pagination,
  };
};

const respondToDocs = async (documents, adminUser) => {
  if (shouldRestrictInternalData(adminUser)) {
    const ids = documents.map((document) => document.id);
    const [restrictedIdentities, documentOwners, vehicleOwners] =
      await Promise.all([
        getRestrictedIdentityIds(adminUser),
        DocumentModel.find({ _id: { $in: ids } })
          .select("driver")
          .lean(),
        VehicleModel.find({ _id: { $in: ids } })
          .select("driver")
          .lean(),
      ]);
    const restrictedDrivers = new Set(
      restrictedIdentities.driverIds.map(String),
    );
    const restrictedRecords = new Set(
      [
        ...restrictedIdentities.documentIds,
        ...restrictedIdentities.vehicleIds,
      ].map(String),
    );
    const includesRestrictedDriver = [...documentOwners, ...vehicleOwners].some(
      (record) =>
        restrictedDrivers.has(record.driver?.toString()) ||
        restrictedRecords.has(record._id.toString()),
    );

    if (includesRestrictedDriver) {
      throw new NotFoundError("Documents not found");
    }
  }

  const vehicleApprovals = documents.filter(
    (doc) =>
      doc.status === "approved" && doc.metadata?.vehicleIdentificationNumber,
  );

  if (vehicleApprovals.length > 0) {
    const duplicateChecks = vehicleApprovals.map((doc) =>
      VehicleModel.findOne({
        driver: { $ne: doc.driver },
        status: "approved",
        vehicleIdentificationNumber: doc.metadata.vehicleIdentificationNumber,
      }),
    );

    const results = await Promise.all(duplicateChecks);
    const hasDuplicate = results.some((vehicle) => vehicle !== null);

    if (hasDuplicate) {
      throw new BadRequestError(
        "A vehicle with the same VIN or registration number has already been approved.",
      );
    }
  }

  // Same bulk operations are used because:
  // - For normal documents, doc.id = DocumentModel._id
  // - For vehicle, doc.id = VehicleModel._id
  const bulkOps = documents.map((doc) => ({
    updateOne: {
      filter: { _id: doc.id },
      update: {
        status: doc.status,
        rejectReason: doc.status === "rejected" ? doc.rejectReason : null,
      },
    },
  }));

  // Update both documents and vehicles
  await Promise.all([
    DocumentModel.bulkWrite(bulkOps),
    VehicleModel.bulkWrite(bulkOps),
  ]);

  const ids = documents.map((doc) => doc.id);

  // Fetch both documents and vehicles because doc.id
  // can belong to either collection
  const [docRecords, vehicleRecords] = await Promise.all([
    DocumentModel.find({
      _id: { $in: ids },
    }).select("_id type driver"),

    VehicleModel.find({
      _id: { $in: ids },
    }).select("_id driver"),
  ]);

  // Map document types
  const docTypeMap = new Map(
    docRecords.map((doc) => [doc._id.toString(), doc.type]),
  );

  // Keep track of vehicle IDs
  const vehicleIds = new Set(
    vehicleRecords.map((vehicle) => vehicle._id.toString()),
  );

  // All items in a request belong to the same driver. Fetch the driver's four
  // current onboarding records after the updates so approval progress reflects
  // the new state, rather than the state before this request.
  const driverId = [...docRecords, ...vehicleRecords].find(
    (record) => record.driver,
  )?.driver;

  const driver = driverId
    ? await DriverModel.findById(driverId)
        .select(
          "email driverLicense vehicleRegistration insurance vehicleDetails",
        )
        .populate([
          { path: "driverLicense", select: "status" },
          { path: "vehicleRegistration", select: "status" },
          { path: "insurance", select: "status" },
          { path: "vehicleDetails", select: "status" },
        ])
    : null;

  const email = driver?.email;

  if (!email) {
    throw new BadRequestError("Driver email not found.");
  }

  const reviewedItems = documents.map((doc) => {
    const isVehicle = vehicleIds.has(doc.id.toString());

    const rawType = isVehicle
      ? "vehicle"
      : (docTypeMap.get(doc.id.toString()) ?? "document");

    return {
      label: rawType
        .replace(/([A-Z])/g, " $1")
        .replace(/^./, (c) => c.toUpperCase())
        .trim(),
      rejectReason: doc.rejectReason || "No reason was provided.",
    };
  });

  const responseStatus = documents[0]?.status;
  const approvedCount = [
    driver.driverLicense,
    driver.vehicleRegistration,
    driver.insurance,
    driver.vehicleDetails,
  ].filter((record) => record?.status === "approved").length;
  const verificationEmail = buildDriverVerificationEmail({
    status: responseStatus,
    reviewedItems,
    approvedCount,
    frontendUrl: env.FRONTEND_URL,
  });

  if (verificationEmail) {
    await sendEmail(
      verificationEmail.subject,
      verificationEmail.message,
      email,
    );
  }

  return {
    message: "Documents have been processed successfully.",
  };
};

async function getRides(query, adminUser) {
  const {
    page = 1,
    limit = 10,
    search,
    rideStatus = "cancelled",
    paymentStatus,
    rideType,
    startDate,
    endDate,
    sort = "desc",
  } = query;

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const matchStage = {
    ...getRideHistoryVisibilityFilter("admin"),
    ...getRideIdentityFilter(restrictedIdentityIds),
  };

  // filters
  if (rideStatus) {
    matchStage.rideStatus = rideStatus;
  }

  if (paymentStatus) {
    matchStage.paymentStatus = paymentStatus;
  }

  if (rideType) {
    matchStage.rideType = rideType;
  }

  // date filters
  if (startDate || endDate) {
    matchStage.createdAt = {};

    if (startDate) {
      matchStage.createdAt.$gte = new Date(startDate);
    }

    if (endDate) {
      matchStage.createdAt.$lte = new Date(endDate);
    }
  }

  const sortDirection = sort === "asc" ? 1 : -1;

  const detailsPipeline = [
    // user info
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "userInfo",
      },
    },

    {
      $unwind: {
        path: "$userInfo",
        preserveNullAndEmptyArrays: true,
      },
    },

    // driver info
    {
      $lookup: {
        from: "drivers",
        localField: "driver",
        foreignField: "_id",
        as: "driverInfo",
      },
    },

    {
      $unwind: {
        path: "$driverInfo",
        preserveNullAndEmptyArrays: true,
      },
    },
  ];

  // Search needs joined names; other requests only join the requested page.
  const pipeline = [{ $match: matchStage }, ...(search ? detailsPipeline : [])];

  // search
  if (search) {
    const parts = search.trim().split(/\s+/);
    const userQueries = parts.map((part) => ({
      $or: [
        { "userInfo.firstName": { $regex: part, $options: "i" } },
        { "userInfo.lastName": { $regex: part, $options: "i" } },
      ],
    }));
    const driverQueries = parts.map((part) => ({
      $or: [
        { "driverInfo.firstName": { $regex: part, $options: "i" } },
        { "driverInfo.lastName": { $regex: part, $options: "i" } },
      ],
    }));

    pipeline.push({
      $match: {
        $or: [
          { $and: userQueries },
          { $and: driverQueries },
          { "userInfo.email": { $regex: search, $options: "i" } },
          { "driverInfo.email": { $regex: search, $options: "i" } },
          { "pickupPoint.placeName": { $regex: search, $options: "i" } },
          { "dropOffPoint.placeName": { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  const statsPipeline = [
    ...pipeline,

    {
      $group: {
        _id: null,

        totalRides: {
          $sum: 1,
        },

        totalCompletedRides: {
          $sum: {
            $cond: [
              {
                $eq: ["$rideStatus", "completed"],
              },
              1,
              0,
            ],
          },
        },

        totalCancelledRides: {
          $sum: {
            $cond: [
              {
                $in: ["$rideStatus", ["cancelled", "canceled"]],
              },
              1,
              0,
            ],
          },
        },

        totalRevenue: {
          $sum: {
            $cond: [
              {
                $eq: ["$paymentStatus", "completed"],
              },
              "$rideFare",
              0,
            ],
          },
        },
      },
    },
  ];

  const resultsPipeline = [
    ...pipeline,

    {
      $sort: {
        createdAt: sortDirection,
      },
    },

    {
      $skip: (parseInt(page) - 1) * parseInt(limit),
    },

    {
      $limit: parseInt(limit),
    },

    ...(!search ? detailsPipeline : []),

    {
      $project: {
        _id: 1,

        rideStatus: 1,
        paymentStatus: 1,
        paymentMethod: 1,
        rideType: 1,

        rideFare: 1,
        rideDistance: 1,

        averageTime: 1,

        pickupPoint: {
          $cond: [
            { $eq: ["$rideStatus", "completed"] },
            "$pickupPoint",
            "$pickupPoint.placeName",
          ],
        },

        dropOffPoint: {
          $cond: [
            { $eq: ["$rideStatus", "completed"] },
            "$dropOffPointRequested",
            "$dropOffPointRequested.placeName",
          ],
        },

        rideDate: 1,
        startTime: 1,
        endTime: 1,

        createdAt: 1,

        user: {
          id: "$userInfo._id",
          firstName: "$userInfo.firstName",
          lastName: "$userInfo.lastName",
          email: "$userInfo.email",
          phone: "$userInfo.phone",
        },

        driver: {
          id: "$driverInfo._id",
          firstName: "$driverInfo.firstName",
          lastName: "$driverInfo.lastName",
          email: "$driverInfo.email",
          phone: "$driverInfo.phone",
        },

        cancelledBy: 1,
        cancellationReason: 1,
      },
    },
  ];

  const [statsResults, results] = await Promise.all([
    RideModel.aggregate(statsPipeline),
    RideModel.aggregate(resultsPipeline),
  ]);

  const stats = statsResults[0] || {
    totalRides: 0,
    totalCompletedRides: 0,
    totalCancelledRides: 0,
    totalRevenue: 0,
  };

  delete stats._id;

  const totalCount = stats.totalRides;

  const totalPages = Math.ceil(totalCount / limit);

  return {
    data: {
      results,
      stats,
    },

    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      totalPages,
    },
  };
}

async function getRideById(rideId, adminUser) {
  if (!mongoose.Types.ObjectId.isValid(rideId)) {
    throw new BadRequestError("Invalid ride ID");
  }

  const rideObjectId = new mongoose.Types.ObjectId(rideId);
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);

  const ride = await RideModel.findOne({
    _id: rideObjectId,
    ...getRideIdentityFilter(restrictedIdentityIds),
  })
    .populate({
      path: "user",
      select:
        "firstName lastName email phone profilePicture rating reviewsReceived address city state isDeactivatedByAdmin isDeleted createdAt",
    })
    .populate({
      path: "driver",
      select:
        "firstName lastName email phone profilePicture rating reviewsReceived address city state vehicleType vehicleDetails isDeactivatedByAdmin isDeleted createdAt",
      populate: {
        path: "vehicleDetails",
        select:
          "make model yearOfManufacture color licensePlateNumber regionOfRegistration expiryDate vehicleType status",
      },
    })
    .populate({
      path: "selectedOffer",
      select:
        "driver rideType offeredFare status expiresAt createdAt updatedAt",
      populate: {
        path: "driver",
        select:
          "firstName lastName email phone profilePicture rating reviewsReceived vehicleType vehicleDetails",
        populate: {
          path: "vehicleDetails",
          select:
            "make model yearOfManufacture color licensePlateNumber vehicleType status",
        },
      },
    })
    .populate({
      path: "codeId",
      select: "code campaign isActive isDeleted createdAt",
      populate: {
        path: "campaign",
        select:
          "name description discountType discountValue maxDiscountCap minRideAmount startDate expiresAt status",
      },
    })
    .populate({
      path: "campaignId",
      select:
        "name description discountType discountValue maxDiscountCap minRideAmount startDate expiresAt status",
    })
    .lean();

  if (!ride) {
    throw new NotFoundError("Ride not found");
  }

  const restrictedDrivers = new Set(
    restrictedIdentityIds.driverIds.map(String),
  );
  const selectedOfferDriverId =
    ride.selectedOffer?.driver?._id || ride.selectedOffer?.driver;
  if (
    selectedOfferDriverId &&
    restrictedDrivers.has(selectedOfferDriverId.toString())
  ) {
    ride.selectedOffer = null;
  }

  const [offers, transactions, reviews] = await Promise.all([
    RideOfferModel.find({
      ride: rideObjectId,
      ...(restrictedIdentityIds.driverIds.length > 0 && {
        driver: { $nin: restrictedIdentityIds.driverIds },
      }),
    })
      .select(
        "driver rideType offeredFare status expiresAt createdAt updatedAt",
      )
      .populate({
        path: "driver",
        select:
          "firstName lastName email phone profilePicture rating reviewsReceived vehicleType vehicleDetails",
        populate: {
          path: "vehicleDetails",
          select:
            "make model yearOfManufacture color licensePlateNumber vehicleType status",
        },
      })
      .sort({ createdAt: -1 })
      .lean(),
    TransactionModel.find({
      "metadata.rideId": { $in: [rideObjectId, rideId] },
    })
      .select(
        "amount type rewardedAmount isRewarded balanceSource user userType card status purpose metadata createdAt updatedAt",
      )
      .populate("card", "brand last4 expMonth expYear")
      .sort({ createdAt: -1 })
      .lean(),
    ReviewModel.find({
      ride: rideObjectId,
      ...getReviewIdentityFilter(restrictedIdentityIds),
    })
      .populate(
        "reviewer",
        "firstName lastName email phone profilePicture rating",
      )
      .populate(
        "receiver",
        "firstName lastName email phone profilePicture rating",
      )
      .sort({ createdAt: -1 })
      .lean(),
  ]);

  return {
    data: {
      rideDetails: {
        ...ride,
        driverFare: getRideDriverFare(ride),
      },
      offers,
      transactions,
      reviews,
    },
  };
}

async function getCarpoolRides(query, adminUser) {
  const {
    page = 1,
    limit = 10,
    search,
    status = "cancelled",
    startDate,
    endDate,
    sort = "desc",
  } = query;

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const matchStage = getCarpoolRouteIdentityFilter(restrictedIdentityIds);

  // status filter
  if (status) {
    matchStage.status = status;
  }

  // date filters
  if (startDate || endDate) {
    matchStage.createdAt = {};

    if (startDate) {
      matchStage.createdAt.$gte = new Date(startDate);
    }

    if (endDate) {
      matchStage.createdAt.$lte = new Date(endDate);
    }
  }

  const sortDirection = sort === "asc" ? 1 : -1;

  const detailsPipeline = [
    // driver info
    {
      $lookup: {
        from: "drivers",
        localField: "driver",
        foreignField: "_id",
        as: "driverInfo",
      },
    },

    {
      $unwind: {
        path: "$driverInfo",
        preserveNullAndEmptyArrays: true,
      },
    },
  ];

  // Search needs joined names; other requests only join the requested page.
  const pipeline = [{ $match: matchStage }, ...(search ? detailsPipeline : [])];

  // search by driver name/email or place names
  if (search) {
    const parts = search.trim().split(/\s+/);
    const driverQueries = parts.map((part) => ({
      $or: [
        { "driverInfo.firstName": { $regex: part, $options: "i" } },
        { "driverInfo.lastName": { $regex: part, $options: "i" } },
      ],
    }));

    pipeline.push({
      $match: {
        $or: [
          { $and: driverQueries },
          { "driverInfo.email": { $regex: search, $options: "i" } },
          { "startingPoint.placeName": { $regex: search, $options: "i" } },
          { "destination.placeName": { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  const statsPipeline = [
    ...pipeline,

    // Use an indexed equality join instead of a subquery for every route.
    {
      $lookup: {
        from: "carpoolbookings",
        localField: "_id",
        foreignField: "carpool",
        pipeline: [
          { $match: getCarpoolBookingIdentityFilter(restrictedIdentityIds) },
        ],
        as: "revenueInfo",
      },
    },

    {
      $group: {
        _id: null,

        totalRides: { $sum: 1 },

        totalCompletedRides: {
          $sum: {
            $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
          },
        },

        totalCancelledRides: {
          $sum: {
            $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0],
          },
        },

        totalRevenue: {
          $sum: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: "$revenueInfo",
                    as: "booking",
                    cond: {
                      $and: [
                        { $eq: ["$$booking.carpool", "$_id"] },
                        { $eq: ["$$booking.paymentStatus", "completed"] },
                      ],
                    },
                  },
                },
                as: "booking",
                in: "$$booking.fareCharged",
              },
            },
          },
        },
      },
    },
  ];

  const resultsPipeline = [
    ...pipeline,

    {
      $sort: {
        createdAt: sortDirection,
      },
    },

    {
      $skip: (parseInt(page) - 1) * parseInt(limit),
    },

    {
      $limit: parseInt(limit),
    },

    ...(!search ? detailsPipeline : []),

    {
      $project: {
        _id: 1,

        status: 1,

        distance: 1,
        avgTime: 1,
        maxPassengers: 1,
        availableSeats: 1,

        startingPoint: "$startingPoint.placeName",
        destination: "$destination.placeName",

        graceTime: 1,
        createdAt: 1,

        driver: {
          id: "$driverInfo._id",
          firstName: "$driverInfo.firstName",
          lastName: "$driverInfo.lastName",
          email: "$driverInfo.email",
          phone: "$driverInfo.phone",
        },
      },
    },
  ];

  const [statsResults, results] = await Promise.all([
    CarpoolRouteModel.aggregate(statsPipeline),
    CarpoolRouteModel.aggregate(resultsPipeline),
  ]);

  const stats = statsResults[0] || {
    totalRides: 0,
    totalCompletedRides: 0,
    totalCancelledRides: 0,
    totalRevenue: 0,
  };

  delete stats._id;

  const totalCount = stats.totalRides;
  const totalPages = Math.ceil(totalCount / limit);

  return {
    data: {
      results,
      stats,
    },

    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      totalPages,
    },
  };
}

async function getCarpoolDetails(carpoolId, adminUser) {
  if (!mongoose.Types.ObjectId.isValid(carpoolId)) {
    throw new BadRequestError("Invalid carpool ID");
  }

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const carpool = await CarpoolRouteModel.findOne({
    _id: carpoolId,
    ...getCarpoolRouteIdentityFilter(restrictedIdentityIds),
  })
    .select("-passengers")
    .populate({
      path: "driver",
      select:
        "firstName lastName email phone profilePicture rating vehicleType vehicleDetails",
      populate: {
        path: "vehicleDetails",
        select:
          "make model yearOfManufacture color licensePlateNumber vehicleType",
      },
    })
    .lean();

  if (!carpool) {
    throw new NotFoundError("Carpool not found");
  }

  const carpoolBookingDetails = await CarpoolBookingModel.find({
    carpool: carpoolId,
    ...getCarpoolBookingIdentityFilter(restrictedIdentityIds),
  })
    .populate({
      path: "passenger",
      select: "firstName lastName email phone profilePicture rating",
    })
    .populate({
      path: "codeId",
      select: "code discountType discountValue",
    })
    .populate({
      path: "campaignId",
      select: "name code discountType discountValue",
    })
    .sort({ createdAt: -1 })
    .lean();

  return {
    data: {
      carpoolDetails: carpool,
      carpoolBookingDetails,
    },
  };
}

async function deleteUser(userId, type, adminUser) {
  if (type === "rider") {
    await assertVisibleIdentity(UserModel, userId, adminUser, "User");
    const user = await UserModel.findOneAndDelete({ _id: userId });
    await CardModel.deleteMany({ user: userId });
    await ReviewModel.deleteMany({ user: userId });
    await ReportModel.deleteMany({ reporter: userId });
    await SignupModel.findOneAndDelete({ _id: user.signUpRecord });
  } else if (type === "driver") {
    await assertVisibleIdentity(DriverModel, userId, adminUser, "Driver");
    const user = await DriverModel.findOneAndDelete({ _id: userId });
    await VehicleModel.deleteMany({ driver: userId });
    await DocumentModel.deleteMany({ driver: userId });
    await BankModel.deleteMany({ driver: userId });
    await SignupModel.findOneAndDelete({ _id: user.signUpRecord });
  }
}

async function getSubscriptionRevenue(query, adminUser) {
  const {
    page = 1,
    limit = 10,
    search,
    subscriptionStatus,
    startDate,
    endDate,
    dateField = "createdAt",
    sortBy = "purchaseDate",
    order = "desc",
  } = query;

  const now = new Date();
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);

  const sortMap = {
    purchaseDate: "createdAt",
    expiryDate: "currentPeriodEnd",
  };

  const sortField = sortMap[sortBy] || "createdAt";
  const sortDirection = order === "asc" ? 1 : -1;
  const subscriptionStatusExpression = {
    $cond: {
      if: { $gte: ["$currentPeriodEnd", now] },
      then: "active",
      else: "expired",
    },
  };

  // subscription filters
  const subscriptionMatchStage = {
    ...(restrictedIdentityIds.driverIds.length > 0 && {
      driver: { $nin: restrictedIdentityIds.driverIds },
    }),
  };

  if (startDate || endDate) {
    subscriptionMatchStage[dateField] = {};

    if (startDate) {
      subscriptionMatchStage[dateField].$gte = new Date(startDate);
    }

    if (endDate) {
      subscriptionMatchStage[dateField].$lte = new Date(endDate);
    }
  }

  if (subscriptionStatus) {
    // Use the same expression as the response, including null/missing expiry.
    subscriptionMatchStage.$expr = {
      $eq: [subscriptionStatusExpression, subscriptionStatus],
    };
  }

  const pipeline = [
    {
      $match: subscriptionMatchStage,
    },
    {
      $lookup: {
        from: "drivers",
        localField: "driver",
        foreignField: "_id",
        pipeline: [
          { $project: { firstName: 1, lastName: 1, email: 1, phone: 1 } },
        ],
        as: "driverInfo",
      },
    },

    {
      $unwind: "$driverInfo",
    },
    { $set: { subscriptionStatus: subscriptionStatusExpression } },
  ];

  // Revenue enrichment is needed only for the page, never for the counts.
  const revenuePipeline = [
    {
      $lookup: {
        from: "transactions",
        let: {
          driverId: "$driver",
        },
        pipeline: [
          {
            $match: {
              purpose: "subscription_charged",
              status: "success",
              userType: "Driver",
              $expr: {
                $eq: ["$user", "$$driverId"],
              },
            },
          },
          {
            $group: {
              _id: null,
              revenue: {
                $sum: "$amount",
              },
            },
          },
        ],
        as: "revenueInfo",
      },
    },

    {
      $unwind: {
        path: "$revenueInfo",
        preserveNullAndEmptyArrays: true,
      },
    },

    {
      $project: {
        driverFirstName: "$driverInfo.firstName",
        driverLastName: "$driverInfo.lastName",
        email: "$driverInfo.email",
        phone: "$driverInfo.phone",

        purchaseDate: "$createdAt",

        expiryDate: "$currentPeriodEnd",

        amount: {
          $ifNull: ["$amount", 0],
        },

        revenue: {
          $ifNull: ["$revenueInfo.revenue", 0],
        },

        driverId: "$driver",

        subscriptionStatus: 1,
      },
    },
  ];

  if (search) {
    const parts = search.trim().split(/\s+/);
    const driverQueries = parts.map((part) => ({
      $or: [
        { "driverInfo.firstName": { $regex: part, $options: "i" } },
        { "driverInfo.lastName": { $regex: part, $options: "i" } },
      ],
    }));

    pipeline.push({
      $match: {
        $or: [
          { $and: driverQueries },
          { "driverInfo.email": { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  // revenue stats from transactions
  const revenueStatsPipeline = [
    {
      $match: {
        purpose: "subscription_charged",
        status: "success",
        userType: "Driver",
        ...getTransactionIdentityFilter(restrictedIdentityIds),
      },
    },

    ...(startDate || endDate
      ? [
          {
            $match: {
              [dateField]: {
                ...(startDate && {
                  $gte: new Date(startDate),
                }),
                ...(endDate && {
                  $lte: new Date(endDate),
                }),
              },
            },
          },
        ]
      : []),

    {
      $group: {
        _id: null,

        totalRevenue: {
          $sum: "$amount",
        },
      },
    },
  ];

  const statsPipeline = [
    ...pipeline,
    {
      $group: {
        _id: null,

        totalSubscriptionsPurchased: {
          $sum: 1,
        },

        totalActiveSubscriptions: {
          $sum: {
            $cond: [
              {
                $eq: ["$subscriptionStatus", "active"],
              },
              1,
              0,
            ],
          },
        },

        totalExpiredSubscriptions: {
          $sum: {
            $cond: [
              {
                $eq: ["$subscriptionStatus", "expired"],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ];

  // Sort before joins to use the date index; keep results in a cursor so large
  // page requests are not constrained by a single $facet document's size.
  const resultsPipeline = [
    pipeline[0],
    { $sort: { [sortField]: sortDirection } },
    ...pipeline.slice(1),
    {
      $skip: (parseInt(page) - 1) * parseInt(limit),
    },

    {
      $limit: parseInt(limit),
    },
    ...revenuePipeline,
  ];

  const [statsResults, revenueResults, results] = await Promise.all([
    SubscriptionModel.aggregate(statsPipeline),
    TransactionModel.aggregate(revenueStatsPipeline),
    SubscriptionModel.aggregate(resultsPipeline),
  ]);

  const stats = statsResults[0] || {
    totalSubscriptionsPurchased: 0,
    totalActiveSubscriptions: 0,
    totalExpiredSubscriptions: 0,
  };

  stats.totalRevenue = revenueResults?.[0]?.totalRevenue || 0;

  delete stats._id;

  const totalCount = stats.totalSubscriptionsPurchased;

  const totalPages = Math.ceil(totalCount / limit);

  return {
    data: {
      results,
      stats,
    },
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: totalCount,
      totalPages,
    },
  };
}

async function getDriverSubscriptionTransactions(
  driverId,
  page = 1,
  limit = 10,
  adminUser,
) {
  await assertVisibleIdentity(DriverModel, driverId, adminUser, "Driver");
  page = Number(page) || 1;
  limit = Number(limit) || 10;

  const skip = (page - 1) * limit;

  const query = {
    user: new mongoose.Types.ObjectId(driverId),
    userType: "Driver",
    purpose: "subscription_charged",
    status: "success",
  };

  const [transactions, totalTransactions] = await Promise.all([
    TransactionModel.find(query)
      .sort({ createdAt: 1 }) // oldest first to preserve activation transaction logic
      .skip(skip)
      .limit(limit)
      .lean(),

    TransactionModel.countDocuments(query),
  ]);

  const formattedTransactions = transactions.map((transaction, index) => ({
    id: transaction._id,
    amount: transaction.amount,
    status: transaction.status,
    purpose: transaction.purpose,
    paymentIntent: transaction.stripeIds?.paymentIntent || null,
    invoiceId: transaction.metadata?.invoiceId || null,
    subscriptionId: transaction.metadata?.subscriptionId || null,
    createdAt: transaction.createdAt,

    isActivationTransaction: skip + index === 0,
  }));

  return {
    data: {
      totalTransactions,
      transactions: formattedTransactions,
      pagination: {
        limit,
        currentPage: page,
        totalCounts: totalTransactions,
        totalPages: Math.ceil(totalTransactions / limit),
      },
    },
  };
}

async function getWithdrawalCommission(query, adminUser) {
  const {
    page = 1,
    limit = 10,
    search,
    startDate,
    endDate,
    sortBy = "date",
    order = "desc",
  } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);
  const sortMap = {
    date: "createdAt",
    withdrawalAmount: "amount",
  };
  const sortField = sortMap[sortBy] || "createdAt";
  const sortDirection = order === "asc" ? 1 : -1;

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const matchStage = {
    userType: "Driver",
    bank: { $exists: true, $ne: null },
    status: "success",
    amount: { $gt: 0 },
    ...getTransactionIdentityFilter(restrictedIdentityIds),
  };

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const detailsPipeline = [
    {
      $lookup: {
        from: "drivers",
        localField: "user",
        foreignField: "_id",
        as: "driverInfo",
        pipeline: [{ $project: { firstName: 1, lastName: 1 } }],
      },
    },
    { $unwind: { path: "$driverInfo", preserveNullAndEmptyArrays: true } },
  ];

  const pipeline = [
    { $match: matchStage },
    ...(search ? detailsPipeline : []),
    {
      $project: {
        driverFirstName: "$driverInfo.firstName",
        driverLastName: "$driverInfo.lastName",
        withdrawalAmount: "$amount",
        date: "$createdAt",
        adminCommission: {
          $round: [{ $multiply: ["$amount", 0.03] }, 2],
        },
        driverId: "$user",
        withdrawalId: "$_id",
      },
    },
  ];

  if (search) {
    const parts = search.trim().split(/\s+/);
    const driverQueries = parts.map((part) => ({
      $or: [
        { driverFirstName: { $regex: part, $options: "i" } },
        { driverLastName: { $regex: part, $options: "i" } },
      ],
    }));

    pipeline.push({
      $match: {
        $and: driverQueries,
      },
    });
  }

  const statsPipeline = [
    ...pipeline,
    {
      $group: {
        _id: null,
        totalWithdrawalsProcessed: { $count: {} },
        totalCommissionRevenue: { $sum: "$adminCommission" },
      },
    },
  ];

  const resultsPipeline = [
    ...pipeline,
    // Preserve the existing sort after projection, including its field names.
    { $sort: { [sortField]: sortDirection } },
    { $skip: (parsedPage - 1) * parsedLimit },
    { $limit: parsedLimit },
    ...(!search
      ? [
          {
            $lookup: {
              ...detailsPipeline[0].$lookup,
              localField: "driverId",
            },
          },
          detailsPipeline[1],
          {
            $set: {
              driverFirstName: "$driverInfo.firstName",
              driverLastName: "$driverInfo.lastName",
            },
          },
          { $unset: "driverInfo" },
        ]
      : []),
  ];

  const [statsResults, results] = await Promise.all([
    TransactionModel.aggregate(statsPipeline),
    TransactionModel.aggregate(resultsPipeline),
  ]);

  const stats = statsResults[0] || {
    totalWithdrawalsProcessed: 0,
    totalCommissionRevenue: 0,
  };

  const totalCount = stats.totalWithdrawalsProcessed || 0;
  const totalPages = Math.ceil(totalCount / parsedLimit);

  return {
    data: {
      results,
      stats,
    },
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total: totalCount,
      totalPages,
    },
  };
}

async function getEligibleDriverIds(
  matchStage,
  { readAllReviewedReferences = false } = {},
) {
  const reviewedStatuses = ["approved", "rejected"];

  // Read only references for eligibility, not full documents once per driver.
  const candidatesQuery = DriverModel.aggregate([
    { $match: matchStage },
    {
      $project: {
        driverLicense: 1,
        vehicleRegistration: 1,
        insurance: 1,
        vehicleDetails: 1,
      },
    },
  ]);

  const documentFields = ["driverLicense", "vehicleRegistration", "insurance"];
  // Keep BSON ObjectIds distinct from legacy string references. Missing
  // references behave like null in the original MongoDB equality lookups.
  const referenceKey = (value) =>
    value == null ? "null" : `${value._bsontype || typeof value}:${value}`;
  const readReviewedIds = (Model, ids) =>
    Model.aggregate([
      {
        $match: {
          ...(ids && { _id: { $in: ids } }),
          status: { $in: reviewedStatuses },
        },
      },
      { $project: { _id: 1 } },
    ]);

  let candidates, reviewedDocuments, reviewedVehicles;
  if (readAllReviewedReferences) {
    // The dashboard evaluates the whole driver population. Read covered status
    // indexes in parallel instead of sending thousands of reference IDs back
    // to MongoDB. Eligibility below still requires each driver's exact IDs.
    [candidates, reviewedDocuments, reviewedVehicles] = await Promise.all([
      candidatesQuery,
      readReviewedIds(DocumentModel),
      readReviewedIds(VehicleModel),
    ]);
  } else {
    candidates = await candidatesQuery;
    const documentIds = new Map();
    const vehicleIds = new Map();
    for (const driver of candidates) {
      for (const field of documentFields) {
        documentIds.set(referenceKey(driver[field]), driver[field] ?? null);
      }
      vehicleIds.set(
        referenceKey(driver.vehicleDetails),
        driver.vehicleDetails ?? null,
      );
    }
    [reviewedDocuments, reviewedVehicles] = await Promise.all([
      readReviewedIds(DocumentModel, [...documentIds.values()]),
      readReviewedIds(VehicleModel, [...vehicleIds.values()]),
    ]);
  }
  // Preserve approved/rejected references, including soft-deleted or shared
  // documents, as the existing API does.
  const reviewedDocumentIds = new Set(
    reviewedDocuments.map((document) => referenceKey(document._id)),
  );
  const reviewedVehicleIds = new Set(
    reviewedVehicles.map((vehicle) => referenceKey(vehicle._id)),
  );
  const eligibleDriverIds = candidates
    .filter(
      (driver) =>
        documentFields.every((field) =>
          reviewedDocumentIds.has(referenceKey(driver[field])),
        ) && reviewedVehicleIds.has(referenceKey(driver.vehicleDetails)),
    )
    .map((driver) => driver._id);

  return eligibleDriverIds;
}

async function getUsers(query, adminUser) {
  const {
    type,
    page = 1,
    limit = 10,
    search,
    startDate,
    endDate,
    sort = "desc",
  } = query;

  const isDriver = type === "driver";
  const Model = isDriver ? DriverModel : UserModel;

  const matchStage = {
    isDeleted: false,
    ...getVisibleIdentityEmailFilter(adminUser),
  };

  if (search) {
    const parts = search.trim().split(/\s+/);
    const nameQueries = parts.map((part) => {
      const partRegex = new RegExp(part, "i");
      return {
        $or: [{ firstName: partRegex }, { lastName: partRegex }],
      };
    });

    const searchRegex = new RegExp(search, "i");
    matchStage.$or = [
      { $and: nameQueries },
      { email: searchRegex },
      { phone: searchRegex },
    ];
  }

  if (startDate || endDate) {
    matchStage.createdAt = {};

    if (startDate) {
      matchStage.createdAt.$gte = new Date(startDate);
    }

    if (endDate) {
      matchStage.createdAt.$lte = new Date(endDate);
    }
  }

  const sortDirection = sort === "asc" ? 1 : -1;

  let users;
  let pagination;

  if (isDriver) {
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const reviewedStatuses = ["approved", "rejected"];

    // Read only references for eligibility, not full documents once per driver.
    const candidates = await Model.aggregate([
      { $match: matchStage },
      {
        $project: {
          driverLicense: 1,
          vehicleRegistration: 1,
          insurance: 1,
          vehicleDetails: 1,
        },
      },
    ]);

    const documentFields = [
      "driverLicense",
      "vehicleRegistration",
      "insurance",
    ];
    // Keep BSON ObjectIds distinct from legacy string references. Missing
    // references behave like null in the original MongoDB equality lookups.
    const referenceKey = (value) =>
      value == null ? "null" : `${value._bsontype || typeof value}:${value}`;
    const documentIds = new Map();
    const vehicleIds = new Map();
    for (const driver of candidates) {
      for (const field of documentFields) {
        documentIds.set(referenceKey(driver[field]), driver[field] ?? null);
      }
      vehicleIds.set(
        referenceKey(driver.vehicleDetails),
        driver.vehicleDetails ?? null,
      );
    }

    // Match the exact referenced IDs and retain approved/rejected statuses,
    // including soft-deleted or shared documents, as the existing API does.
    const [reviewedDocuments, reviewedVehicles] = await Promise.all([
      DocumentModel.aggregate([
        {
          $match: {
            _id: { $in: [...documentIds.values()] },
            status: { $in: reviewedStatuses },
          },
        },
        { $project: { _id: 1 } },
      ]),
      VehicleModel.aggregate([
        {
          $match: {
            _id: { $in: [...vehicleIds.values()] },
            status: { $in: reviewedStatuses },
          },
        },
        { $project: { _id: 1 } },
      ]),
    ]);
    const reviewedDocumentIds = new Set(
      reviewedDocuments.map((document) => referenceKey(document._id)),
    );
    const reviewedVehicleIds = new Set(
      reviewedVehicles.map((vehicle) => referenceKey(vehicle._id)),
    );
    const eligibleDriverIds = candidates
      .filter(
        (driver) =>
          documentFields.every((field) =>
            reviewedDocumentIds.has(referenceKey(driver[field])),
          ) && reviewedVehicleIds.has(referenceKey(driver.vehicleDetails)),
      )
      .map((driver) => driver._id);

    const pagePipeline = [
      { $match: { ...matchStage, _id: { $in: eligibleDriverIds } } },
      { $sort: { createdAt: sortDirection } },
      { $skip: (parsedPage - 1) * parsedLimit },
      { $limit: parsedLimit },
      {
        $lookup: {
          from: "subscriptions",
          localField: "subscription",
          foreignField: "_id",
          as: "subscription",
        },
      },
      { $unwind: { path: "$subscription", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          firstName: 1,
          lastName: 1,
          email: 1,
          phone: 1,
          address: 1,
          state: 1,
          city: 1,
          isDeactivatedByAdmin: 1,
          createdAt: 1,
          "subscription.status": 1,
        },
      },
    ];

    users = await Model.aggregate(pagePipeline);
    const total = eligibleDriverIds.length;
    pagination = {
      page: parsedLimit,
      currentPage: parsedPage,
      total,
      totalPages: Math.ceil(total / parsedLimit),
    };
  } else {
    const pipeline = [
      { $match: matchStage },
      { $sort: { createdAt: sortDirection } },
    ];
    const paginated = await aggregatePaginate(Model, pipeline, page, limit);
    pagination = paginated.pagination;
    pipeline.push({ $skip: paginated.skip }, { $limit: parseInt(limit, 10) });
    users = await Model.aggregate(pipeline);
  }

  const formattedUsers = users.map((user) => ({
    id: user._id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phone,
    address: user.address,
    state: user.state,
    city: user.city,
    status: user.isDeactivatedByAdmin ? "Deactivated" : "Active",
    createdAt: user.createdAt,

    ...(isDriver && {
      subscriptionStatus: user.subscription?.status || null,
    }),
  }));

  return {
    data: formattedUsers,
    pagination,
  };
}

async function updateUserOrDriver(id, payload, adminUser = null) {
  const { type, subscriptionStatus, ...updateData } = payload;

  const Model = type === "driver" ? DriverModel : UserModel;
  await assertVisibleIdentity(
    Model,
    id,
    adminUser,
    type === "driver" ? "Driver" : "User",
  );
  const sanitizedUpdateData = { ...updateData };

  // prevent updating restricted fields
  delete sanitizedUpdateData._id;
  delete sanitizedUpdateData.password;
  delete sanitizedUpdateData.isDeleted;
  delete sanitizedUpdateData.createdAt;
  delete sanitizedUpdateData.updatedAt;
  delete sanitizedUpdateData.rewardedBalance;
  delete sanitizedUpdateData.pendingWithdrawalBalance;
  delete sanitizedUpdateData.pendingRewardedWithdrawalBalance;

  if (
    shouldRestrictInternalData(adminUser) &&
    sanitizedUpdateData.email &&
    isInternalIdentityEmail(sanitizedUpdateData.email)
  ) {
    throw new ForbiddenError("Cannot assign an internal email domain");
  }

  const session = await mongoose.startSession();
  let userId;

  let rewardAmountAwarded = 0;
  let userLocale = "en";

  try {
    await session.withTransaction(async () => {
      const user = await Model.findOne({
        _id: id,
        isDeleted: false,
      }).session(session);

      if (!user) {
        throw new NotFoundError(
          `${type === "driver" ? "Driver" : "User"} not found`,
        );
      }

      if (
        Object.prototype.hasOwnProperty.call(sanitizedUpdateData, "balance")
      ) {
        const rewardAmount = normalizeMoney(sanitizedUpdateData.balance);

        if (
          !Number.isFinite(Number(sanitizedUpdateData.balance)) ||
          rewardAmount < 0
        ) {
          throw new BadRequestError(
            "Wallet reward must be a valid non-negative number",
          );
        }

        if (rewardAmount > 0) {
          user.rewardedBalance = normalizeMoney(
            (user.rewardedBalance || 0) + rewardAmount,
          );

          const reason =
            sanitizedUpdateData.reason ||
            sanitizedUpdateData.description ||
            null;

          await TransactionModel.create(
            [
              {
                amount: rewardAmount,
                rewardedAmount: rewardAmount,
                isRewarded: true,
                balanceSource: BALANCE_SOURCES.REWARDED,
                type: "Credit",
                user: user._id,
                userType: type === "driver" ? "Driver" : "User",
                status: "success",
                purpose: "admin_reward",
                metadata: {
                  description: reason || "Wallet reward from admin/platform",
                  reason: reason,
                  rewardedByAdmin: true,
                  adminId: adminUser?._id || adminUser?.id || null,
                  adminName: adminUser?.name || null,
                  adminEmail: adminUser?.email || null,
                },
              },
            ],
            { session },
          );

          rewardAmountAwarded = rewardAmount;
        }
      }

      /* Phone is also the login identity (Signup), so both must change together */
      if (
        sanitizedUpdateData.phone &&
        sanitizedUpdateData.phone !== user.phone
      ) {
        const phoneInUse = await SignupModel.exists({
          phone: sanitizedUpdateData.phone,
          role: type === "driver" ? "driver" : "user",
          isDeleted: false,
          _id: { $ne: user.signUpRecord },
        }).session(session);

        if (phoneInUse) {
          throw new ConflictError(
            "Phone number is already in use by another account",
          );
        }

        if (user.signUpRecord) {
          await SignupModel.updateOne(
            { _id: user.signUpRecord },
            { phone: sanitizedUpdateData.phone },
            { session },
          );
        }
      }

      const profileUpdateData = { ...sanitizedUpdateData };
      delete profileUpdateData.balance;
      delete profileUpdateData.reason;
      delete profileUpdateData.description;
      Object.assign(user, profileUpdateData);
      await user.save({ session });
      userId = user._id;
      userLocale = user.locale || "en";

      // update subscription status only for driver
      if (type === "driver" && subscriptionStatus && user.subscription) {
        await SubscriptionModel.findByIdAndUpdate(
          user.subscription,
          { status: subscriptionStatus },
          { new: true, session },
        );
      }
    });
  } finally {
    await session.endSession();
  }

  /* Send reward notification after the transaction commits */
  if (rewardAmountAwarded > 0) {
    const formattedRewardAmount = rewardAmountAwarded.toFixed(2);
    sendNotificationToSpecificUser({
      title: t("ADMIN_REWARD_TITLE", userLocale).replace(
        "${amount}",
        formattedRewardAmount,
      ),
      description: t("ADMIN_REWARD_DESC", userLocale).replace(
        "${amount}",
        formattedRewardAmount,
      ),
      userIds: [userId],
      role: type === "driver" ? "driver" : "user",
      skipSave: false,
      metadata: {
        type: "ADMIN_REWARD",
        amount: rewardAmountAwarded,
      },
    });

    console.log(
      `[updateUserOrDriver] Reward notification sent to ${type} ${userId} for $${rewardAmountAwarded.toFixed(2)}`,
    );
  }

  const updatedUser = await Model.findById(userId).populate(
    type === "driver" ? "subscription" : "",
  );

  return {
    data: {
      id: updatedUser._id,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      email: updatedUser.email,
      phone: updatedUser.phone,
      phoneNumber: updatedUser.phone,
      address: updatedUser.address,
      state: updatedUser.state,
      city: updatedUser.city,
      status: updatedUser.isDeactivatedByAdmin ? "Deactivated" : "Active",
      balance: updatedUser.balance || 0,
      rewardedBalance: updatedUser.rewardedBalance || 0,
      totalBalance:
        (updatedUser.balance || 0) + (updatedUser.rewardedBalance || 0),

      ...(type === "driver" && {
        vehicleType: updatedUser.vehicleType,
        subscriptionStatus: updatedUser.subscription?.status || null,
        ssn: maskSsn(updatedUser.ssn),
        hasSsn: Boolean(updatedUser.ssn),
      }),
    },
  };
}

async function getRewardedBalanceHistory(query = {}, adminUser) {
  const {
    page = 1,
    limit = 10,
    search,
    userType,
    startDate,
    endDate,
    sortBy = "createdAt",
    order = "desc",
  } = query;

  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 10;
  const sortDirection = order === "asc" ? 1 : -1;

  const sortMap = {
    date: "createdAt",
    createdAt: "createdAt",
    amount: "amount",
  };
  const sortField = sortMap[sortBy] || "createdAt";

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const transactionIdentityFilter = getTransactionIdentityFilter(
    restrictedIdentityIds,
  );
  const matchStage = {
    purpose: "admin_reward",
    status: "success",
    ...transactionIdentityFilter,
  };

  if (userType === "rider" || userType === "user") {
    matchStage.userType = "User";
  } else if (userType === "driver") {
    matchStage.userType = "Driver";
  }

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const detailsPipeline = [
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "userInfo",
        pipeline: [
          {
            $project: {
              firstName: 1,
              lastName: 1,
              email: 1,
              phone: 1,
              profilePicture: 1,
              balance: 1,
              rewardedBalance: 1,
            },
          },
        ],
      },
    },
    {
      $lookup: {
        from: "drivers",
        localField: "user",
        foreignField: "_id",
        as: "driverInfo",
        pipeline: [
          {
            $project: {
              firstName: 1,
              lastName: 1,
              email: 1,
              phone: 1,
              profilePicture: 1,
              balance: 1,
              rewardedBalance: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        recipient: {
          $cond: [
            { $eq: ["$userType", "Driver"] },
            { $arrayElemAt: ["$driverInfo", 0] },
            { $arrayElemAt: ["$userInfo", 0] },
          ],
        },
      },
    },
  ];

  const basePipeline = [
    { $match: matchStage },
    ...(search ? detailsPipeline : []),
  ];

  if (search) {
    const parts = search.trim().split(/\s+/);
    const nameQueries = parts.map((part) => ({
      $or: [
        { "recipient.firstName": { $regex: part, $options: "i" } },
        { "recipient.lastName": { $regex: part, $options: "i" } },
      ],
    }));

    basePipeline.push({
      $match: {
        $or: [
          { $and: nameQueries },
          { "recipient.email": { $regex: search, $options: "i" } },
          { "recipient.phone": { $regex: search, $options: "i" } },
          { "metadata.adminName": { $regex: search, $options: "i" } },
          { "metadata.adminEmail": { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  const statsPipeline = [
    ...basePipeline,
    {
      $group: {
        _id: null,
        totalRewardsGiven: { $sum: 1 },
        totalRewardedBalance: { $sum: "$amount" },
        totalRiderRewardedBalance: {
          $sum: {
            $cond: [{ $eq: ["$userType", "User"] }, "$amount", 0],
          },
        },
        totalDriverRewardedBalance: {
          $sum: {
            $cond: [{ $eq: ["$userType", "Driver"] }, "$amount", 0],
          },
        },
      },
    },
  ];

  const overallStatsPipeline = [
    {
      $match: {
        purpose: "admin_reward",
        status: "success",
        ...transactionIdentityFilter,
      },
    },
    {
      $group: {
        _id: null,
        allTimeRewardedBalance: { $sum: "$amount" },
        allTimeRewardsCount: { $sum: 1 },
        allTimeRiderRewardedBalance: {
          $sum: {
            $cond: [{ $eq: ["$userType", "User"] }, "$amount", 0],
          },
        },
        allTimeDriverRewardedBalance: {
          $sum: {
            $cond: [{ $eq: ["$userType", "Driver"] }, "$amount", 0],
          },
        },
      },
    },
  ];

  const resultsPipeline = [
    ...basePipeline,
    { $sort: { [sortField]: sortDirection } },
    { $skip: (parsedPage - 1) * parsedLimit },
    { $limit: parsedLimit },
    ...(!search ? detailsPipeline : []),
    {
      $project: {
        _id: 1,
        id: "$_id",
        amount: 1,
        rewardedAmount: { $ifNull: ["$rewardedAmount", "$amount"] },
        type: 1,
        userType: 1,
        status: 1,
        purpose: 1,
        balanceSource: 1,
        description: {
          $ifNull: [
            "$metadata.description",
            "Wallet reward from admin/platform",
          ],
        },
        reason: "$metadata.reason",
        admin: {
          id: "$metadata.adminId",
          name: "$metadata.adminName",
          email: "$metadata.adminEmail",
        },
        user: {
          _id: "$recipient._id",
          id: "$recipient._id",
          firstName: "$recipient.firstName",
          lastName: "$recipient.lastName",
          email: "$recipient.email",
          phone: "$recipient.phone",
          profilePicture: "$recipient.profilePicture",
          balance: { $ifNull: ["$recipient.balance", 0] },
          rewardedBalance: { $ifNull: ["$recipient.rewardedBalance", 0] },
          totalBalance: {
            $add: [
              { $ifNull: ["$recipient.balance", 0] },
              { $ifNull: ["$recipient.rewardedBalance", 0] },
            ],
          },
        },
        createdAt: 1,
        updatedAt: 1,
      },
    },
  ];

  const [statsResults, overallStatsResults, results] = await Promise.all([
    TransactionModel.aggregate(statsPipeline),
    TransactionModel.aggregate(overallStatsPipeline),
    TransactionModel.aggregate(resultsPipeline),
  ]);

  const stats = statsResults[0] || {
    totalRewardsGiven: 0,
    totalRewardedBalance: 0,
    totalRiderRewardedBalance: 0,
    totalDriverRewardedBalance: 0,
  };

  const overallStats = overallStatsResults[0] || {
    allTimeRewardedBalance: 0,
    allTimeRewardsCount: 0,
    allTimeRiderRewardedBalance: 0,
    allTimeDriverRewardedBalance: 0,
  };

  const totalCount = stats.totalRewardsGiven || 0;
  const totalPages = Math.ceil(totalCount / parsedLimit);

  return {
    data: {
      results,
      stats: {
        totalRewardedBalance: normalizeMoney(stats.totalRewardedBalance || 0),
        totalRewardsGiven: stats.totalRewardsGiven || 0,
        totalRiderRewardedBalance: normalizeMoney(
          stats.totalRiderRewardedBalance || 0,
        ),
        totalDriverRewardedBalance: normalizeMoney(
          stats.totalDriverRewardedBalance || 0,
        ),
        allTimeRewardedBalance: normalizeMoney(
          overallStats.allTimeRewardedBalance || 0,
        ),
        allTimeRewardsCount: overallStats.allTimeRewardsCount || 0,
        allTimeRiderRewardedBalance: normalizeMoney(
          overallStats.allTimeRiderRewardedBalance || 0,
        ),
        allTimeDriverRewardedBalance: normalizeMoney(
          overallStats.allTimeDriverRewardedBalance || 0,
        ),
      },
    },
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total: totalCount,
      totalPages,
    },
  };
}

async function getProfileRideStats(Model, match, statusField) {
  const results = await Model.aggregate([
    {
      $match: { ...match, [statusField]: { $in: ["completed", "cancelled"] } },
    },
    {
      $group: {
        _id: `$${statusField}`,
        count: { $sum: 1 },
        lastCreatedAt: { $max: "$createdAt" },
      },
    },
  ]);
  const completed = results.find((result) => result._id === "completed");
  const cancelled = results.find((result) => result._id === "cancelled");
  // Keep the date casting used by the previous findOne result.
  const lastCompletedAt = completed
    ? Model.hydrate({ createdAt: completed.lastCreatedAt }).createdAt
    : null;
  return {
    completed: completed?.count || 0,
    cancelled: cancelled?.count || 0,
    lastCompletedAt: lastCompletedAt || null,
  };
}

async function getUserById(id, type, adminUser) {
  const Model = type === "driver" ? DriverModel : UserModel;

  await assertVisibleIdentity(
    Model,
    id,
    adminUser,
    type === "driver" ? "Driver" : "User",
  );
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);

  let query = Model.findById(id).populate("signUpRecord");

  if (type === "driver") {
    query = query
      .populate("vehicleDetails")
      .populate("driverLicense")
      .populate("vehicleRegistration")
      .populate("insurance");
  }

  const user = await query;

  if (!user || user.isDeleted) {
    throw new NotFoundError("User not found");
  }

  const userId = user._id;

  if (type === "rider") {
    const [
      {
        completed: ridesCompleted,
        cancelled: ridesCancelled,
        lastCompletedAt: lastRideDate,
      },
      {
        completed: carpoolsCompleted,
        cancelled: carpoolsCancelled,
        lastCompletedAt: lastCarpoolDate,
      },
      rideHistoryData,
      carpoolHistoryData,
      transactionHistory,
      lastLoginDevice,
    ] = await Promise.all([
      getProfileRideStats(
        RideModel,
        {
          user: userId,
          ...(restrictedIdentityIds.driverIds.length > 0 && {
            driver: { $nin: restrictedIdentityIds.driverIds },
          }),
        },
        "rideStatus",
      ),
      getProfileRideStats(
        CarpoolBookingModel,
        {
          passenger: userId,
          ...getCarpoolBookingIdentityFilter(restrictedIdentityIds),
        },
        "status",
      ),
      rideHistory(userId, "user", 1, 10, undefined, undefined, {
        dataOnly: true,
        additionalMatch: {
          ...(restrictedIdentityIds.driverIds.length > 0 && {
            driver: { $nin: restrictedIdentityIds.driverIds },
          }),
        },
      }),
      carpoolHistory(userId, "user", 1, 10, undefined, {
        dataOnly: true,
        additionalMatch: getCarpoolRouteIdentityFilter(restrictedIdentityIds),
        bookingMatch: getCarpoolBookingIdentityFilter(restrictedIdentityIds),
      }),
      TransactionModel.find({ user: userId, userType: "User" })
        .select(
          "createdAt metadata type amount status rewardedAmount isRewarded balanceSource",
        )
        .sort({ createdAt: -1 })
        .limit(10),
      LoggedDeviceModel.findOne({ user: userId, userType: "User" })
        .select("updatedAt")
        .sort({ updatedAt: -1 }),
    ]);

    const formattedCarpools = (carpoolHistoryData?.data || []).map((cp) => ({
      _id: cp._id,
      bookingId: cp.booking?._id,
      rideType: "carpool",
      rideStatus: cp.booking?.status || cp.status,
      rideFare: cp.fareCharged,
      rideDistance: cp.distance,
      averageTime: cp.avgTime,
      pickupPoint: cp.booking?.pickupStop
        ? {
            placeName: cp.booking.pickupStop.placeName,
            location: cp.booking.pickupStop.location,
          }
        : cp.startingPoint,
      dropOffPoint: cp.booking?.dropOffStop
        ? {
            placeName: cp.booking.dropOffStop.placeName,
            location: cp.booking.dropOffStop.location,
          }
        : cp.destination,
      driver: cp.driver,
      paymentMethod: cp.booking?.paymentMethod,
      paymentStatus: cp.booking?.paymentStatus,
      requiredSeats: cp.requiredSeats || 1,
      createdAt: cp.createdAt,
    }));

    const combinedRecentRides = [
      ...(rideHistoryData?.data || []),
      ...formattedCarpools,
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10);

    const lastRideTakenDate =
      [lastRideDate, lastCarpoolDate]
        .filter(Boolean)
        .sort((a, b) => new Date(b) - new Date(a))[0] || null;

    return {
      data: {
        personalInfo: {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phone: user.phone,
          phoneNumber: user.phone,
          address: user.address,
          state: user.state,
          city: user.city,
          profilePicture: user.profilePicture,
        },
        averageRating: user.rating || 0,
        rideStats: {
          totalCompleted: ridesCompleted + carpoolsCompleted,
          totalCancelled: ridesCancelled + carpoolsCancelled,
          regularRidesCompleted: ridesCompleted,
          regularRidesCancelled: ridesCancelled,
          carpoolsCompleted,
          carpoolsCancelled,
        },
        rideHistory: combinedRecentRides,
        carpoolHistory: carpoolHistoryData?.data || [],
        walletBalance: user.balance || 0,
        rewardedBalance: user.rewardedBalance || 0,
        totalBalance: (user.balance || 0) + (user.rewardedBalance || 0),
        transactionHistory: transactionHistory.map((t) => ({
          date: t.createdAt,
          description:
            t.metadata?.description ||
            `Ride ${t.type === "Debit" ? "Payment" : "Credit"}`,
          amount: t.amount,
          type: t.type,
          status: t.status,
          rewardedAmount: t.rewardedAmount || 0,
          isRewarded: t.isRewarded || false,
          balanceSource: t.balanceSource || "regular",
        })),
        activityLogs: {
          lastLogin: lastLoginDevice?.updatedAt || null,
          lastRideTaken: lastRideTakenDate,
          accountCreationDate: user.createdAt,
        },
        fullDetails: user,
      },
    };
  }

  // Driver Details View
  const [
    {
      completed: ridesCompleted,
      cancelled: ridesCancelled,
      lastCompletedAt: lastRideDate,
    },
    {
      completed: carpoolsCompleted,
      cancelled: carpoolsCancelled,
      lastCompletedAt: lastCarpoolDate,
    },
    rideHistoryData,
    carpoolHistoryData,
    transactionHistory,
    lastLoginDevice,
    subscription,
    reviews,
    withdrawalTransactions,
    referrals,
  ] = await Promise.all([
    getProfileRideStats(
      RideModel,
      {
        driver: userId,
        ...(restrictedIdentityIds.userIds.length > 0 && {
          user: { $nin: restrictedIdentityIds.userIds },
        }),
      },
      "rideStatus",
    ),
    getProfileRideStats(CarpoolRouteModel, { driver: userId }, "status"),
    rideHistory(userId, "driver", 1, 10, undefined, undefined, {
      dataOnly: true,
      additionalMatch: {
        ...(restrictedIdentityIds.userIds.length > 0 && {
          user: { $nin: restrictedIdentityIds.userIds },
        }),
      },
    }),
    carpoolHistory(userId, "driver", 1, 10, undefined, {
      dataOnly: true,
      bookingMatch: getCarpoolBookingIdentityFilter(restrictedIdentityIds),
    }),
    TransactionModel.find({
      user: userId,
      userType: "Driver",
      purpose: { $ne: "subscription_charged" },
    })
      .select(
        "createdAt metadata type amount status rewardedAmount isRewarded balanceSource bank",
      )
      .sort({ createdAt: -1 })
      .limit(10),
    LoggedDeviceModel.findOne({ user: userId, userType: "Driver" })
      .select("updatedAt")
      .sort({ updatedAt: -1 }),
    SubscriptionModel.findOne({ driver: userId })
      .select("status currentPeriodEnd")
      .sort({ createdAt: -1 }),
    ReviewModel.find({
      receiver: userId,
      ...getReviewIdentityFilter(restrictedIdentityIds),
    })
      .sort({ createdAt: -1 })
      .limit(10),
    TransactionModel.find({
      user: userId,
      userType: "Driver",
      bank: { $exists: true },
      status: "success",
    }).select("amount"),
    DriverModel.find({
      referredBy: userId,
      ...getVisibleIdentityEmailFilter(adminUser),
    }).select("firstName lastName createdAt _id"),
  ]);

  const totalAdminRevenue = withdrawalTransactions.reduce(
    (acc, curr) => acc + curr.amount * 0.03,
    0,
  );

  let subscriptionStatus = "Expired";
  if (subscription && subscription.status === "active") {
    const expiry = subscription.currentPeriodEnd
      ? subscription.currentPeriodEnd.toDateString()
      : "N/A";
    subscriptionStatus = `Active (Expires: ${expiry})`;
  } else if (subscription && subscription.status !== "canceled") {
    subscriptionStatus = subscription.status;
  }

  const formattedDriverCarpools = (carpoolHistoryData?.data || []).map(
    (cp) => ({
      _id: cp._id,
      rideType: "carpool",
      rideStatus: cp.status,
      rideFare: cp.fareCharged,
      rideDistance: cp.distance,
      averageTime: cp.avgTime,
      pickupPoint: cp.startingPoint,
      dropOffPoint: cp.destination,
      routes: cp.routes,
      bookingsSummary: cp.bookingsSummary,
      availableSeats: cp.availableSeats,
      maxPassengers: cp.maxPassengers,
      createdAt: cp.createdAt,
    }),
  );

  const combinedDriverRecentRides = [
    ...(rideHistoryData?.data || []),
    ...formattedDriverCarpools,
  ]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);

  const lastDriverRideDate =
    [lastRideDate, lastCarpoolDate]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;

  return {
    data: {
      personalInfo: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phone: user.phone,
        phoneNumber: user.phone,
        address: user.address,
        state: user.state,
        city: user.city,
        profilePicture: user.profilePicture,
        ssn: maskSsn(user.ssn),
        hasSsn: Boolean(user.ssn),
      },
      vehicleDetails: user.vehicleDetails,
      approvedDocuments: {
        license: user.driverLicense,
        registration: user.vehicleRegistration,
        insurance: user.insurance,
      },
      referralInfo: {
        totalReferrals: referrals.length,
        referrals: referrals.map((r) => ({
          id: r._id,
          firstName: r.firstName,
          lastName: r.lastName,
          date: r.createdAt,
        })),
      },
      ratingAndFeedback: {
        rating: user.rating || 0,
        reviewsCount: user.reviewsReceived || 0,
        recentReviews: reviews,
      },
      rideStats: {
        totalCompleted: ridesCompleted + carpoolsCompleted,
        totalCancelled: ridesCancelled + carpoolsCancelled,
        regularRidesCompleted: ridesCompleted,
        regularRidesCancelled: ridesCancelled,
        carpoolsCompleted,
        carpoolsCancelled,
      },
      rideHistory: combinedDriverRecentRides,
      carpoolHistory: carpoolHistoryData?.data || [],
      subscriptionStatus,
      walletBalance: user.balance || 0,
      rewardedBalance: user.rewardedBalance || 0,
      totalBalance: (user.balance || 0) + (user.rewardedBalance || 0),
      transactionHistory: transactionHistory.map((t) => ({
        date: t.createdAt,
        description:
          t.metadata?.description ||
          (t.bank
            ? "Withdrawal to Bank"
            : `Ride ${t.type === "Debit" ? "Payment" : "Credit"} (${t.metadata?.rideId || "N/A"})`),
        amount: t.amount,
        type: t.type,
        status: t.status,
        rewardedAmount: t.rewardedAmount || 0,
        isRewarded: t.isRewarded || false,
        balanceSource: t.balanceSource || "regular",
      })),
      revenue: {
        adminCommission: totalAdminRevenue.toFixed(2),
      },
      activityLogs: {
        lastLogin: lastLoginDevice?.updatedAt || null,
        lastRideTaken: lastDriverRideDate,
        accountCreationDate: user.createdAt,
      },
      fullDetails: user,
    },
  };
}

async function updateUserStatus(id, type, status, adminUser) {
  const Model = type === "driver" ? DriverModel : UserModel;
  await assertVisibleIdentity(
    Model,
    id,
    adminUser,
    type === "driver" ? "Driver" : "User",
  );
  const isDeactivatedByAdmin = status === "deactivated";

  const user = await Model.findByIdAndUpdate(
    id,
    { isDeactivatedByAdmin },
    { new: true },
  );

  if (!user) {
    throw new NotFoundError("User not found");
  }

  // Also update Signup record if it exists
  if (user.signUpRecord) {
    await SignupModel.findByIdAndUpdate(user.signUpRecord, {
      isDeactivatedByAdmin,
    });
  }

  return {
    message: `User ${status === "deactivated" ? "deactivated" : "activated"} successfully`,
    data: {
      id: user._id,
      status: user.isDeactivatedByAdmin ? "deactivated" : "active",
    },
  };
}

async function getReports(query, adminUser) {
  const { page = 1, limit = 10, status, order } = query;
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const reportIdentityFilter = getReportIdentityFilter(restrictedIdentityIds);
  const match = { isDeleted: false, ...reportIdentityFilter };
  if (status) match.status = status;

  const detailsPipeline = [
    {
      $lookup: {
        from: "users",
        let: { reporterId: "$reporter", reporterType: "$reporterType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$reporterId"] },
                  { $eq: ["$$reporterType", "User"] },
                ],
              },
            },
          },
          { $project: { firstName: 1, lastName: 1, isDeactivatedByAdmin: 1 } },
        ],
        as: "reporterUser",
      },
    },
    {
      $lookup: {
        from: "drivers",
        let: { reporterId: "$reporter", reporterType: "$reporterType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$reporterId"] },
                  { $eq: ["$$reporterType", "Driver"] },
                ],
              },
            },
          },
          { $project: { firstName: 1, lastName: 1, isDeactivatedByAdmin: 1 } },
        ],
        as: "reporterDriver",
      },
    },
    {
      $lookup: {
        from: "users",
        let: { entityId: "$entityId", entityType: "$entityType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$entityId"] },
                  { $eq: ["$$entityType", "User"] },
                ],
              },
            },
          },
          { $project: { firstName: 1, lastName: 1, isDeactivatedByAdmin: 1 } },
        ],
        as: "entityUser",
      },
    },
    {
      $lookup: {
        from: "drivers",
        let: { entityId: "$entityId", entityType: "$entityType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$entityId"] },
                  { $eq: ["$$entityType", "Driver"] },
                ],
              },
            },
          },
          { $project: { firstName: 1, lastName: 1, isDeactivatedByAdmin: 1 } },
        ],
        as: "entityDriver",
      },
    },
    {
      $addFields: {
        reporterInfo: {
          $ifNull: [
            { $arrayElemAt: ["$reporterUser", 0] },
            { $arrayElemAt: ["$reporterDriver", 0] },
          ],
        },
        reportedEntityInfo: {
          $ifNull: [
            { $arrayElemAt: ["$entityUser", 0] },
            { $arrayElemAt: ["$entityDriver", 0] },
          ],
        },
      },
    },
    {
      $project: {
        reportId: "$_id",
        reporterFirstName: "$reporterInfo.firstName",
        reporterLastName: "$reporterInfo.lastName",
        reporterType: "$reporterType",
        isReporterDeactivatedByAdmin: "$reporterInfo.isDeactivatedByAdmin",
        reportedPersonFirstName: "$reportedEntityInfo.firstName",
        reportedPersonLastName: "$reportedEntityInfo.lastName",
        reportedPersonType: "$entityType",
        isReportedPersonDeactivatedByAdmin:
          "$reportedEntityInfo.isDeactivatedByAdmin",
        reportReason: "$reason",
        date: "$createdAt",
        status: "$status",
      },
    },
  ];

  const statsPipeline = [
    { $match: { isDeleted: false, ...reportIdentityFilter } },
    {
      $group: {
        _id: null,
        totalReportsReceived: { $sum: 1 },
        pendingReports: {
          $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
        },
        resolvedReports: {
          $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] },
        },
        rejectedReports: {
          $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
        },
      },
    },
  ];

  const mostReportedPipeline = [
    { $match: match },
    {
      $group: {
        _id: { id: "$entityId", type: "$entityType" },
        reportCount: { $sum: 1 },
      },
    },
    { $sort: { reportCount: -1 } },
    { $limit: 10 },
    {
      $facet: {
        users: [
          { $match: { "_id.type": "User" } },
          {
            $lookup: {
              from: "users",
              localField: "_id.id",
              foreignField: "_id",
              as: "info",
            },
          },
          { $unwind: "$info" },
          {
            $project: {
              entityId: "$_id.id",
              firstName: "$info.firstName",
              lastName: "$info.lastName",
              type: { $toLower: "$_id.type" },
              isDeactivatedByAdmin: "$info.isDeactivatedByAdmin",
              reportCount: 1,
            },
          },
        ],
        drivers: [
          { $match: { "_id.type": "Driver" } },
          {
            $lookup: {
              from: "drivers",
              localField: "_id.id",
              foreignField: "_id",
              as: "info",
            },
          },
          { $unwind: "$info" },
          {
            $project: {
              entityId: "$_id.id",
              firstName: "$info.firstName",
              lastName: "$info.lastName",
              type: { $toLower: "$_id.type" },
              isDeactivatedByAdmin: "$info.isDeactivatedByAdmin",
              reportCount: 1,
            },
          },
        ],
      },
    },
    {
      $project: {
        results: { $concatArrays: ["$users", "$drivers"] },
      },
    },
    { $unwind: "$results" },
    { $replaceRoot: { newRoot: "$results" } },
    { $sort: { reportCount: -1 } },
  ];

  const skip = (parsedPage - 1) * parsedLimit;

  const resultsPipeline = [
    { $match: match },
    { $sort: { createdAt: order === "asc" ? 1 : -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
    ...detailsPipeline,
  ];

  const [totalCount, statsResults, mostReportedEntities, reports] =
    await Promise.all([
      ReportModel.countDocuments(match),
      ReportModel.aggregate(statsPipeline),
      ReportModel.aggregate(mostReportedPipeline),
      ReportModel.aggregate(resultsPipeline),
    ]);

  // Preserve the pagination fields returned by aggregatePaginate.
  const pagination = {
    page: parsedLimit,
    currentPage: parsedPage,
    total: totalCount,
    totalPages: Math.ceil(totalCount / parsedLimit),
  };

  const stats = statsResults[0] || {
    totalReportsReceived: 0,
    pendingReports: 0,
    resolvedReports: 0,
    rejectedReports: 0,
  };
  delete stats._id;

  return {
    data: {
      results: reports,
      stats: {
        ...stats,
        mostReportedEntities,
      },
    },
    pagination,
  };
}

async function getReportById(id, adminUser) {
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const report = await ReportModel.findOne({
    _id: id,
    ...getReportIdentityFilter(restrictedIdentityIds),
  })
    .populate("reporter", "firstName lastName email phone isDeactivatedByAdmin")
    .populate("entityId", "firstName lastName email phone isDeactivatedByAdmin")
    .lean();

  if (!report) throw new NotFoundError("Report not found");

  let relatedDetails = null;
  if (report.supportingEntityType === "Ride") {
    const relatedRide = await RideModel.findOne({
      _id: report.supportingEntityId,
      ...getRideIdentityFilter(restrictedIdentityIds),
    }).lean();
    if (!relatedRide) throw new NotFoundError("Report not found");
    relatedDetails = {
      type: "ride",
      ...relatedRide,
    };
  } else if (report.supportingEntityType === "CarpoolRoute") {
    const relatedCarpool = await CarpoolRouteModel.findOne({
      _id: report.supportingEntityId,
      ...getCarpoolRouteIdentityFilter(restrictedIdentityIds),
    }).lean();
    if (!relatedCarpool) throw new NotFoundError("Report not found");
    const restrictedPassengers = new Set(
      restrictedIdentityIds.userIds.map(String),
    );
    relatedDetails = {
      type: "carpool",
      ...relatedCarpool,
      passengers: (relatedCarpool.passengers || []).filter(
        (passenger) => !restrictedPassengers.has(passenger.user?.toString()),
      ),
    };
  }

  return {
    data: {
      reportId: report._id,
      reporterInfo: {
        id: report.reporter?._id,
        firstName: report.reporter?.firstName,
        lastName: report.reporter?.lastName,
        email: report.reporter?.email,
        phone: report.reporter?.phone,
        type: report.reporterType?.toLowerCase(),
        isDeactivatedByAdmin: report.reporter?.isDeactivatedByAdmin || false,
      },
      reportedPersonInfo: {
        id: report.entityId?._id,
        firstName: report.entityId?.firstName,
        lastName: report.entityId?.lastName,
        email: report.entityId?.email,
        phone: report.entityId?.phone,
        type: report.entityType?.toLowerCase(),
        isDeactivatedByAdmin: report.entityId?.isDeactivatedByAdmin || false,
      },
      reportReason: report.reason,
      description: report.description,
      status: report.status,
      relatedDetails,
      createdAt: report.createdAt,
      resolvedAt: report.resolvedAt,
      adminNotes: report.adminNotes,
    },
  };
}

async function resolveReport(id, adminId, notes, status, adminUser) {
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const report = await ReportModel.findOneAndUpdate(
    {
      _id: id,
      ...getReportIdentityFilter(restrictedIdentityIds),
    },
    {
      status,
      resolvedBy: adminId,
      resolvedAt: new Date(),
      adminNotes: notes,
    },
    { new: true },
  );

  if (!report) throw new NotFoundError("Report not found");

  return {
    data: report,
  };
}

async function sendAdminNotification(
  { recipientType, recipientId, title, message, scheduledFor },
  adminUser,
  { includeInternalData } = {},
) {
  const restrictInternalRecipients =
    env.NODE_ENV === "production" &&
    (includeInternalData === undefined
      ? shouldRestrictInternalData(adminUser)
      : !includeInternalData);
  const recipientVisibilityFilter = restrictInternalRecipients
    ? { email: { $not: INTERNAL_IDENTITY_EMAIL_PATTERN } }
    : {};

  if (scheduledFor) {
    const scheduledDate = new Date(scheduledFor);
    if (scheduledDate > new Date()) {
      await ScheduledNotificationModel.create({
        title,
        message,
        recipientType,
        recipientId: recipientId || null,
        includeInternalRecipients: !restrictInternalRecipients,
        scheduledFor: scheduledDate,
      });

      return {
        message: "Notification scheduled successfully",
      };
    }
  }

  const userIds = [];

  if (recipientType === "rider" || recipientType === "driver") {
    const user =
      recipientType === "rider"
        ? await UserModel.findOne({
            _id: recipientId,
            ...recipientVisibilityFilter,
          })
        : await DriverModel.findOne({
            _id: recipientId,
            ...recipientVisibilityFilter,
          });

    if (user) userIds.push(user._id.toString());
  }

  if (recipientType === "riders" || recipientType === "both") {
    const riders = await UserModel.find({
      isDeactivatedByAdmin: false,
      isDeleted: false,
      ...recipientVisibilityFilter,
    })
      .select("_id")
      .lean();
    console.log("🚀 ~ sendAdminNotification ~ riders:", riders);

    userIds.push(...riders.map((r) => r._id.toString()));
  }

  if (recipientType === "drivers" || recipientType === "both") {
    const drivers = await DriverModel.find({
      isDeactivatedByAdmin: false,
      isDeleted: false,
      ...recipientVisibilityFilter,
    })
      .select("_id")
      .lean();
    console.log("🚀 ~ sendAdminNotification ~ drivers:", drivers);

    userIds.push(...drivers.map((d) => d._id.toString()));
  }

  if (userIds.length === 0) {
    throw new BadRequestError("No valid recipients found");
  }

  sendNotificationToSpecificUser({
    title,
    description: message,
    userIds,
    skipSave: false,
  });

  await ScheduledNotificationModel.create({
    title,
    message,
    recipientType,
    recipientId: recipientId || null,
    includeInternalRecipients: !restrictInternalRecipients,
    scheduledFor: new Date(),
    status: "sent",
  });

  return {
    message: "Admin notification process completed",
  };
}

async function getAdminNotifications(query, adminUser) {
  const {
    page = 1,
    limit = 10,
    search,
    sort = "desc",
    startDate,
    endDate,
  } = query;

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const restrictedRecipientIds = [
    ...restrictedIdentityIds.userIds,
    ...restrictedIdentityIds.driverIds,
  ];
  const matchStage = {
    ...(restrictedRecipientIds.length > 0 && {
      recipientId: { $nin: restrictedRecipientIds },
    }),
  };

  if (search) {
    const searchRegex = new RegExp(search, "i");
    matchStage.$or = [{ title: searchRegex }];

    // Also try to match exact dates if search term looks like a date
    const searchDate = new Date(search);
    if (!isNaN(searchDate.getTime())) {
      const nextDay = new Date(searchDate);
      nextDay.setDate(searchDate.getDate() + 1);
      matchStage.$or.push({
        scheduledFor: {
          $gte: searchDate,
          $lt: nextDay,
        },
      });
    }
  }

  if (startDate || endDate) {
    matchStage.scheduledFor = {};
    if (startDate) matchStage.scheduledFor.$gte = new Date(startDate);
    if (endDate) matchStage.scheduledFor.$lte = new Date(endDate);
  }

  const sortDirection = sort === "asc" ? 1 : -1;

  const pipeline = [
    { $match: matchStage },
    { $sort: { scheduledFor: sortDirection } },
  ];

  const { skip, pagination } = await aggregatePaginate(
    ScheduledNotificationModel,
    pipeline,
    page,
    limit,
  );

  pipeline.push({ $skip: skip }, { $limit: parseInt(limit, 10) });

  const notifications = await ScheduledNotificationModel.aggregate(pipeline);

  const formattedNotifications = notifications.map((notif) => ({
    id: notif._id,
    title: notif.title,
    messagePreview:
      notif.message.length > 50
        ? notif.message.substring(0, 50) + "..."
        : notif.message,
    recipientType:
      notif.recipientType.charAt(0).toUpperCase() +
      notif.recipientType.slice(1),
    dateAndTime: notif.scheduledFor,
    status:
      notif.status === "pending"
        ? "Scheduled"
        : notif.status.charAt(0).toUpperCase() + notif.status.slice(1),
  }));

  return {
    data: {
      notifications: formattedNotifications,
      pagination,
    },
  };
}

async function getAllAdminNotifications(query, adminUser) {
  const { page = 1, limit = 10 } = query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const restrictedActorIds = [
    ...restrictedIdentityIds.userIds,
    ...restrictedIdentityIds.driverIds,
  ];
  const restrictedContentIds =
    restrictedActorIds.length === 0
      ? []
      : await NotificationContentModel.find({
          "metaData.id": {
            $in: [...restrictedActorIds, ...restrictedActorIds.map(String)],
          },
        }).distinct("_id");
  const notificationFilter = {
    userType: "Admin",
    ...(restrictedIdentityIds.adminIds.length > 0 && {
      user: { $nin: restrictedIdentityIds.adminIds },
    }),
    ...(restrictedContentIds.length > 0 && {
      notificationContent: { $nin: restrictedContentIds },
    }),
  };

  const [notifications, total] = await Promise.all([
    NotificationModel.find(notificationFilter)
      .populate("notificationContent", "title description metaData")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean(),

    NotificationModel.countDocuments(notificationFilter),
  ]);

  return {
    data: notifications,

    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      totalPages: Math.ceil(total / parseInt(limit)),
    },
  };
}

async function getDashboardStats(query, adminUser) {
  const { startDate, endDate } = query;
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);

  const now = new Date();

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - todayStart.getDay());

  const monthStart = new Date(
    todayStart.getFullYear(),
    todayStart.getMonth(),
    1,
  );

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const customDateRange = {};
  if (startDate || endDate) {
    if (startDate) customDateRange.$gte = new Date(startDate);
    if (endDate) customDateRange.$lte = new Date(endDate);
  }
  const hasCustomRange = Object.keys(customDateRange).length > 0;
  if (hasCustomRange) {
    // Preserve the date-casting errors produced by the previous count queries.
    UserModel.find({ createdAt: customDateRange }).cast(UserModel);
  }

  const countMetrics = async (Model, match, filters) => {
    const projection = { _id: 0 };
    const facets = {};
    for (const [name, filter] of Object.entries(filters)) {
      for (const field of Object.keys(filter)) projection[field] = 1;
      facets[name] = [{ $match: filter }, { $count: "count" }];
    }
    const [result = {}] = await Model.aggregate([
      { $match: match },
      { $project: projection },
      { $facet: facets },
    ]);
    return Object.fromEntries(
      Object.keys(filters).map((name) => [name, result[name]?.[0]?.count || 0]),
    );
  };

  // 1. User Metrics
  const riderMetricsQuery = countMetrics(
    UserModel,
    { isDeleted: false, ...getVisibleIdentityEmailFilter(adminUser) },
    {
      totalRiders: { isDeactivatedByAdmin: false },
      newRiderReg7: { createdAt: { $gte: sevenDaysAgo } },
      newRiderReg30: { createdAt: { $gte: thirtyDaysAgo } },
      ...(hasCustomRange && {
        newRiderRegCustom: { createdAt: customDateRange },
      }),
    },
  );

  const activeRidersQuery = RideModel.distinct(
    "user",
    combineMongoFilters(
      {
        user: { $exists: true, $ne: null },
        rideStatus: "completed",
        createdAt: { $gte: thirtyDaysAgo },
      },
      getRideIdentityFilter(restrictedIdentityIds),
    ),
  ).then((userIds) => userIds.length);

  const activeDriversQuery = RideModel.distinct(
    "driver",
    combineMongoFilters(
      {
        driver: { $exists: true, $ne: null },
        rideStatus: "completed",
        createdAt: { $gte: thirtyDaysAgo },
      },
      getRideIdentityFilter(restrictedIdentityIds),
    ),
  ).then((driverIds) => driverIds.length);

  const driverMetricsQuery = countMetrics(
    DriverModel,
    { isDeleted: false, ...getVisibleIdentityEmailFilter(adminUser) },
    {
      totalDrivers: {},
      newDriverReg7: { createdAt: { $gte: sevenDaysAgo } },
      newDriverReg30: { createdAt: { $gte: thirtyDaysAgo } },
      ...(hasCustomRange && {
        newDriverRegCustom: { createdAt: customDateRange },
      }),
    },
  );

  // 2. Ride Metrics
  const earliestWindow = new Date(Math.min(todayStart, weekStart, monthStart));
  const rideDateFilter = hasCustomRange
    ? {
        $or: [
          { createdAt: { $gte: earliestWindow } },
          { createdAt: customDateRange },
        ],
      }
    : { createdAt: { $gte: earliestWindow } };
  const rideMetricsQuery = countMetrics(
    RideModel,
    {
      rideStatus: { $in: ["completed", "cancelled"] },
      ...getRideIdentityFilter(restrictedIdentityIds),
      ...rideDateFilter,
    },
    {
      ridesCompletedToday: {
        rideStatus: "completed",
        createdAt: { $gte: todayStart },
      },
      ridesCompletedWeek: {
        rideStatus: "completed",
        createdAt: { $gte: weekStart },
      },
      ridesCompletedMonth: {
        rideStatus: "completed",
        createdAt: { $gte: monthStart },
      },
      ridesCancelledToday: {
        rideStatus: "cancelled",
        createdAt: { $gte: todayStart },
      },
      ridesCancelledWeek: {
        rideStatus: "cancelled",
        createdAt: { $gte: weekStart },
      },
      ridesCancelledMonth: {
        rideStatus: "cancelled",
        createdAt: { $gte: monthStart },
      },
      ...(hasCustomRange && {
        ridesCompletedCustom: {
          rideStatus: "completed",
          createdAt: customDateRange,
        },
        ridesCancelledCustom: {
          rideStatus: "cancelled",
          createdAt: customDateRange,
        },
      }),
    },
  );

  // 3. Revenue Metrics
  const subRevenuePipeline = [
    {
      $match: {
        ...(restrictedIdentityIds.driverIds.length > 0 && {
          driver: { $nin: restrictedIdentityIds.driverIds },
        }),
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ];

  if (Object.keys(customDateRange).length) {
    subRevenuePipeline[0].$match.createdAt = customDateRange;
  }

  const subscriptionAggQuery = SubscriptionModel.aggregate(subRevenuePipeline);

  const withdrawalMatch = {
    userType: "Driver",
    bank: { $exists: true, $ne: null },
    status: "success",
    amount: { $gt: 0 },
    ...getTransactionIdentityFilter(restrictedIdentityIds),
  };

  if (Object.keys(customDateRange).length) {
    withdrawalMatch.createdAt = customDateRange;
  }

  const withdrawalCommissionAggQuery = TransactionModel.aggregate([
    { $match: withdrawalMatch },
    {
      $group: {
        _id: null,
        totalCommission: { $sum: { $multiply: ["$amount", 0.03] } },
      },
    },
  ]);

  const pendingDocDriversQuery = DocumentModel.distinct("driver", {
    status: "pending",
    isDeleted: false,
    ...(restrictedIdentityIds.driverIds.length > 0 && {
      driver: { $nin: restrictedIdentityIds.driverIds },
    }),
    ...(restrictedIdentityIds.documentIds.length > 0 && {
      _id: { $nin: restrictedIdentityIds.documentIds },
    }),
  });

  const pendingVehicleDriversQuery = VehicleModel.distinct("driver", {
    status: "pending",
    isDeleted: false,
    ...(restrictedIdentityIds.driverIds.length > 0 && {
      driver: { $nin: restrictedIdentityIds.driverIds },
    }),
    ...(restrictedIdentityIds.vehicleIds.length > 0 && {
      _id: { $nin: restrictedIdentityIds.vehicleIds },
    }),
  });

  const pendingReportsQuery = ReportModel.countDocuments({
    status: "pending",
    isDeleted: false,
    ...getReportIdentityFilter(restrictedIdentityIds),
  });

  const [
    { totalRiders, newRiderReg7, newRiderReg30, newRiderRegCustom = null },
    totalActiveRiders,
    totalActiveDrivers,
    { totalDrivers, newDriverReg7, newDriverReg30, newDriverRegCustom = null },
    {
      ridesCompletedToday,
      ridesCompletedWeek,
      ridesCompletedMonth,
      ridesCompletedCustom = null,
      ridesCancelledToday,
      ridesCancelledWeek,
      ridesCancelledMonth,
      ridesCancelledCustom = null,
    },
    subRevResults,
    withCommResults,
    pendingDocDrivers,
    pendingVehicleDrivers,
    pendingReports,
  ] = await Promise.all([
    riderMetricsQuery,
    activeRidersQuery,
    activeDriversQuery,
    driverMetricsQuery,
    rideMetricsQuery,
    subscriptionAggQuery,
    withdrawalCommissionAggQuery,
    pendingDocDriversQuery,
    pendingVehicleDriversQuery,
    pendingReportsQuery,
  ]);

  // FIXED: unique drivers only
  const uniquePendingDrivers = new Set([
    ...pendingDocDrivers.map((id) => id.toString()),
    ...pendingVehicleDrivers.map((id) => id.toString()),
  ]);

  const subscriptionRevenueUSD = subRevResults.length
    ? subRevResults[0].total
    : 0;

  const withdrawalCommissionRevenueUSD = withCommResults.length
    ? Number(withCommResults[0].totalCommission.toFixed(2))
    : 0;

  return {
    data: {
      userMetrics: {
        totalActiveRiders,
        totalRiders,
        totalActiveDrivers,
        totalDrivers,
        newRiderRegistrations: {
          last7Days: newRiderReg7,
          last30Days: newRiderReg30,
          ...(newRiderRegCustom !== null && { customRange: newRiderRegCustom }),
        },
        newDriverRegistrations: {
          last7Days: newDriverReg7,
          last30Days: newDriverReg30,
          ...(newDriverRegCustom !== null && {
            customRange: newDriverRegCustom,
          }),
        },
      },

      rideMetrics: {
        totalRidesCompleted: {
          today: ridesCompletedToday,
          thisWeek: ridesCompletedWeek,
          thisMonth: ridesCompletedMonth,
          ...(ridesCompletedCustom !== null && {
            customRange: ridesCompletedCustom,
          }),
        },
        totalRidesCancelled: {
          today: ridesCancelledToday,
          thisWeek: ridesCancelledWeek,
          thisMonth: ridesCancelledMonth,
          ...(ridesCancelledCustom !== null && {
            customRange: ridesCancelledCustom,
          }),
        },
      },

      revenueMetrics: {
        subscriptionRevenueUSD: Number(subscriptionRevenueUSD.toFixed(2)),
        withdrawalCommissionRevenueUSD,
      },

      pendingActions: {
        pendingDriverRequests: uniquePendingDrivers.size,
        pendingReports,
      },
    },
  };
}

async function getPendingDriverRequests(_query, adminUser) {
  const { driverIds, documentIds, vehicleIds } =
    await getRestrictedIdentityIds(adminUser);
  const match = {
    status: "pending",
    isDeleted: false,
    ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
  };
  const pendingDocumentDriversPipeline = [
    {
      $match: {
        ...match,
        ...(documentIds.length > 0 && { _id: { $nin: documentIds } }),
      },
    },
    { $group: { _id: "$driver" } },
  ];
  const pendingVehicleDriversPipeline = [
    {
      $match: {
        ...match,
        ...(vehicleIds.length > 0 && { _id: { $nin: vehicleIds } }),
      },
    },
    { $group: { _id: "$driver" } },
  ];

  const [result] = await DocumentModel.aggregate([
    ...pendingDocumentDriversPipeline,
    {
      $unionWith: {
        coll: VehicleModel.collection.name,
        pipeline: pendingVehicleDriversPipeline,
      },
    },
    { $group: { _id: "$_id" } },
    {
      $group: {
        _id: null,
        pendingDriverRequests: { $sum: 1 },
        hasLegacyDriverReference: {
          $max: {
            $cond: [{ $ne: [{ $type: "$_id" }, "objectId"] }, 1, 0],
          },
        },
      },
    },
  ]);

  // Preserve distinct()/toString() behavior for malformed legacy references.
  // Valid records use the scalar aggregate result without transferring IDs.
  if (result?.hasLegacyDriverReference) {
    const [documentDrivers, vehicleDrivers] = await Promise.all([
      DocumentModel.distinct("driver", {
        ...match,
        ...(documentIds.length > 0 && { _id: { $nin: documentIds } }),
      }),
      VehicleModel.distinct("driver", {
        ...match,
        ...(vehicleIds.length > 0 && { _id: { $nin: vehicleIds } }),
      }),
    ]);
    return {
      data: {
        pendingDriverRequests: new Set(
          [...documentDrivers, ...vehicleDrivers].map((driver) =>
            driver.toString(),
          ),
        ).size,
      },
    };
  }

  return {
    data: {
      pendingDriverRequests: result?.pendingDriverRequests || 0,
    },
  };
}

async function getRideAnalytics(query, adminUser) {
  const { startDate, endDate } = query;
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const matchStage = getRideIdentityFilter(restrictedIdentityIds);

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  // Regular rides
  const pipeline = [
    { $match: matchStage },
    {
      $facet: {
        totalRidesCount: [{ $count: "count" }],
        completedRidesCount: [
          { $match: { rideStatus: "completed" } },
          { $count: "count" },
        ],
        cancelledRidesCount: [
          { $match: { rideStatus: "cancelled" } },
          { $count: "count" },
        ],
        rideTypeDistribution: [
          { $group: { _id: "$rideType", count: { $sum: 1 } } },
        ],
      },
    },
  ];

  // Carpool bookings
  const carpoolPipeline = [
    {
      $match: combineMongoFilters(
        Object.keys(matchStage.createdAt || {}).length > 0
          ? { createdAt: matchStage.createdAt }
          : {},
        getCarpoolBookingIdentityFilter(restrictedIdentityIds),
      ),
    },
    {
      $facet: {
        totalCarpoolsCount: [{ $count: "count" }],
        completedCarpoolsCount: [
          { $match: { status: "completed" } },
          { $count: "count" },
        ],
        cancelledCarpoolsCount: [
          { $match: { status: "cancelled" } },
          { $count: "count" },
        ],
      },
    },
  ];

  const [results, carpoolResults] = await Promise.all([
    RideModel.aggregate(pipeline),
    CarpoolBookingModel.aggregate(carpoolPipeline),
  ]);

  const facetDoc = results[0];
  const carpoolFacetDoc = carpoolResults[0];

  const regularTotalRides = facetDoc.totalRidesCount[0]?.count || 0;
  const regularCompletedRides = facetDoc.completedRidesCount[0]?.count || 0;
  const regularCancelledRides = facetDoc.cancelledRidesCount[0]?.count || 0;

  const totalCarpools = carpoolFacetDoc.totalCarpoolsCount[0]?.count || 0;
  const completedCarpools =
    carpoolFacetDoc.completedCarpoolsCount[0]?.count || 0;
  const cancelledCarpools =
    carpoolFacetDoc.cancelledCarpoolsCount[0]?.count || 0;

  const totalRides = regularTotalRides + totalCarpools;
  const completedRides = regularCompletedRides + completedCarpools;
  const cancelledRides = regularCancelledRides + cancelledCarpools;

  const completedPercentage =
    totalRides > 0
      ? Number(((completedRides / totalRides) * 100).toFixed(2))
      : 0;
  const cancelledPercentage =
    totalRides > 0
      ? Number(((cancelledRides / totalRides) * 100).toFixed(2))
      : 0;

  const rideTypesCounted = facetDoc.rideTypeDistribution || [];

  // Exclude "carpool" if it's already in the regular distribution so we don't double count incorrectly,
  // though rideType shouldn't normally be "carpool", we override its count below.
  const typesPresent = [
    ...new Set([
      ...rideTypesCounted.map((v) => v._id).filter((t) => t !== "carpool"),
      "economy",
      "luxury",
      "carpool",
    ]),
  ];

  const rideDistribution = typesPresent.map((type) => {
    let count = 0;
    if (type === "carpool") {
      count = totalCarpools;
      // Add any accidental carpool types found in RideModel
      const existingCarpoolType = rideTypesCounted.find(
        (t) => t._id === "carpool",
      );
      if (existingCarpoolType) count += existingCarpoolType.count;
    } else {
      const item = rideTypesCounted.find((t) => t._id === type);
      if (item) count = item.count;
    }

    const percentage =
      totalRides > 0 ? Number(((count / totalRides) * 100).toFixed(2)) : 0;

    return {
      type: type || "unknown",
      count,
      percentage,
    };
  });

  return {
    data: {
      overview: {
        totalRides,
        completedRides,
        cancelledRides,
        completedPercentage,
        cancelledPercentage,
      },
      rideDistribution,
    },
  };
}

async function getBirdsEyeView(adminUser) {
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  // ── Drivers ──────────────────────────────────────────────────────────────
  const driverIdsInGeo = await redis.zrange(
    REDIS_CONSTANTS.DRIVER_GEO_KEY,
    0,
    -1,
  );

  let driversData = [];

  if (driverIdsInGeo.length) {
    const statusPipeline = redis.pipeline();
    for (const driverId of driverIdsInGeo) {
      statusPipeline.hgetall(`${DRIVER}:${driverId}`);
    }
    const statusResults = await statusPipeline.exec();

    const onlineDriverIds = [];
    for (let i = 0; i < driverIdsInGeo.length; i++) {
      const driverData = statusResults[i][1];
      if (driverData?.status === DRIVER_SOCKET_EVENTS.ONLINE_STATUS) {
        onlineDriverIds.push(driverIdsInGeo[i]);
      }
    }

    if (onlineDriverIds.length) {
      const locationPipeline = redis.pipeline();
      const activityPipeline = redis.pipeline();

      for (const driverId of onlineDriverIds) {
        locationPipeline.geopos(REDIS_CONSTANTS.DRIVER_GEO_KEY, driverId);
        activityPipeline.get(`${DRIVER}:${driverId}:${RIDE}:${ACTIVE}`);
        activityPipeline.get(
          REDIS_CONSTANTS.keys.driverCarpoolActive(driverId),
        );
      }

      const [locationResults, activityResults] = await Promise.all([
        locationPipeline.exec(),
        activityPipeline.exec(),
      ]);

      const drivers = await DriverModel.find({
        _id: { $in: onlineDriverIds },
        isDeleted: false,
        isDeactivatedByAdmin: false,
        ...getVisibleIdentityEmailFilter(adminUser),
      })
        .select(
          "firstName lastName phone vehicleDetails vehicleType profilePicture",
        )
        .populate(
          "vehicleDetails",
          "make model yearOfManufacture color vehicleIdentificationNumber licensePlateNumber regionOfRegistration expiryDate vehicleType status",
        )
        .lean();

      const driverMap = new Map(drivers.map((d) => [d._id.toString(), d]));
      const activeRideIds = activityResults
        .filter((_, index) => index % 2 === 0)
        .map((result) => result[1])
        .filter(Boolean);
      const visibleActiveRideIds = new Set(
        (
          await RideModel.find({
            _id: { $in: activeRideIds },
            ...getRideIdentityFilter(restrictedIdentityIds),
          })
            .select("_id")
            .lean()
        ).map(({ _id }) => _id.toString()),
      );

      for (let i = 0; i < onlineDriverIds.length; i++) {
        const driverId = onlineDriverIds[i];
        const driver = driverMap.get(driverId);

        if (!driver) continue;

        const position = locationResults[i][1];
        if (!position || !position[0]) continue;

        const [lng, lat] = position[0].map(Number);

        const rawActiveRideId = activityResults[i * 2][1];
        const activeRideId = visibleActiveRideIds.has(rawActiveRideId)
          ? rawActiveRideId
          : null;
        const activeCarpoolId = activityResults[i * 2 + 1][1];

        driversData.push({
          id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone,
          vehicleType: driver.vehicleType,
          profilePicture: driver.profilePicture,
          location: {
            type: "Point",
            coordinates: [lng, lat],
          },
          vehicleDetails: driver.vehicleDetails || null,
          activeRideId: activeRideId || null,
          activeCarpoolId: activeCarpoolId || null,
        });
      }
    }
  }

  // ── Riders (live location from Redis) ────────────────────────────────────────
  const userIdsInGeo = await redis.zrange(REDIS_CONSTANTS.USER_GEO_KEY, 0, -1);

  let ridersData = [];

  if (userIdsInGeo.length) {
    // Fetch live coordinates + active ride IDs in parallel pipelines
    const locationPipeline = redis.pipeline();
    const activityPipeline = redis.pipeline();

    for (const userId of userIdsInGeo) {
      locationPipeline.geopos(REDIS_CONSTANTS.USER_GEO_KEY, userId);
      activityPipeline.get(`${USER}:${userId}:${RIDE}:${ACTIVE}`);
    }

    const [locationResults, activityResults] = await Promise.all([
      locationPipeline.exec(),
      activityPipeline.exec(),
    ]);

    // Fetch user details from DB
    const users = await UserModel.find({
      _id: { $in: userIdsInGeo },
      ...getVisibleIdentityEmailFilter(adminUser),
    })
      .select("firstName lastName phone profilePicture")
      .lean();
    const userMap = new Map(users.map((u) => [u._id.toString(), u]));

    // Collect active ride IDs to fetch pickupPlaceNames in one query
    const activeRideIds = activityResults.map((r) => r[1]).filter(Boolean);

    const ridePickupMap = new Map();
    if (activeRideIds.length) {
      const ridesDocs = await RideModel.find({
        _id: { $in: activeRideIds },
        ...getRideIdentityFilter(restrictedIdentityIds),
      })
        .select("_id rideStatus pickupPoint")
        .lean();
      for (const r of ridesDocs) {
        ridePickupMap.set(r._id.toString(), r);
      }
    }

    for (let i = 0; i < userIdsInGeo.length; i++) {
      const userId = userIdsInGeo[i];
      const user = userMap.get(userId);
      if (!user) continue;

      const position = locationResults[i][1];
      if (!position || !position[0]) continue;

      const [lng, lat] = position[0].map(Number);
      const activeRideId = activityResults[i][1];
      const rideDoc = activeRideId ? ridePickupMap.get(activeRideId) : null;

      ridersData.push({
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        profilePicture: user.profilePicture || null,
        rideStatus: rideDoc?.rideStatus || null,
        activeRideId: rideDoc ? activeRideId : null,
        location: {
          type: "Point",
          coordinates: [lng, lat],
        },
        pickupPlaceName: rideDoc?.pickupPoint?.placeName || null,
      });
    }
  }

  return {
    drivers: driversData,
    totalDrivers: driversData.length,
    riders: ridersData,
    totalRiders: ridersData.length,
  };
}

async function exportUsersCSV(query, adminUser) {
  const { type, search, startDate, endDate, sort = "desc", fields } = query;

  const ALLOWED_FIELDS = {
    firstName: (u) => u.firstName || "",
    lastName: (u) => u.lastName || "",
    email: (u) => u.email || "",
    phoneNumber: (u) => u.phone || "",
    address: (u) => u.address || "",
    state: (u) => u.state || "",
    city: (u) => u.city || "",
    status: (u) => (u.isDeactivatedByAdmin ? "Deactivated" : "Active"),
  };

  const selectedFields =
    !fields || !fields.length
      ? Object.keys(ALLOWED_FIELDS)
      : (Array.isArray(fields) ? fields : [fields]).filter(
          (f) => f in ALLOWED_FIELDS,
        );

  const isDriver = type === "driver";
  const Model = isDriver ? DriverModel : UserModel;

  const matchStage = {
    isDeleted: false,
    ...getVisibleIdentityEmailFilter(adminUser),
  };

  if (search) {
    const parts = search.trim().split(/\s+/);
    const nameQueries = parts.map((part) => {
      const partRegex = new RegExp(part, "i");
      return {
        $or: [{ firstName: partRegex }, { lastName: partRegex }],
      };
    });

    const searchRegex = new RegExp(search, "i");
    matchStage.$or = [
      { $and: nameQueries },
      { email: searchRegex },
      { phone: searchRegex },
    ];
  }

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const sortDirection = sort === "asc" ? 1 : -1;

  const pipeline = [
    { $match: matchStage },

    ...(isDriver
      ? [
          {
            $lookup: {
              from: "documents",
              localField: "driverLicense",
              foreignField: "_id",
              as: "driverLicense",
            },
          },
          {
            $unwind: {
              path: "$driverLicense",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: "documents",
              localField: "vehicleRegistration",
              foreignField: "_id",
              as: "vehicleRegistration",
            },
          },
          {
            $unwind: {
              path: "$vehicleRegistration",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $lookup: {
              from: "documents",
              localField: "insurance",
              foreignField: "_id",
              as: "insurance",
            },
          },
          { $unwind: { path: "$insurance", preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: "vehicles",
              localField: "vehicleDetails",
              foreignField: "_id",
              as: "vehicleDetails",
            },
          },
          {
            $unwind: {
              path: "$vehicleDetails",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $match: {
              "driverLicense.status": "approved",
              "vehicleRegistration.status": "approved",
              "insurance.status": "approved",
              "vehicleDetails.status": "approved",
            },
          },
        ]
      : []),

    { $sort: { createdAt: sortDirection } },
  ];

  const users = await Model.aggregate(pipeline);

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headerLine = selectedFields.map(escapeCsv).join(",");
  const dataLines = users.map((user) =>
    selectedFields
      .map((field) => escapeCsv(ALLOWED_FIELDS[field](user)))
      .join(","),
  );

  const csv = [headerLine, ...dataLines].join("\n");

  return {
    filename: `${type || "users"}-export-${Date.now()}.csv`,
    csv,
  };
}

async function exportRidesCSV(query, adminUser) {
  const { status, search, startDate, endDate, sort = "desc" } = query;

  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const matchStage = {
    ...getRideHistoryVisibilityFilter("admin"),
    ...getRideIdentityFilter(restrictedIdentityIds),
  };
  if (status) {
    matchStage.rideStatus = status;
  }

  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = new Date(startDate);
    if (endDate) matchStage.createdAt.$lte = new Date(endDate);
  }

  const sortDirection = sort === "asc" ? 1 : -1;

  const pipeline = [
    { $match: matchStage },

    // Join rider (user) info
    {
      $lookup: {
        from: "users",
        localField: "user",
        foreignField: "_id",
        as: "userInfo",
      },
    },
    {
      $unwind: {
        path: "$userInfo",
        preserveNullAndEmptyArrays: true,
      },
    },

    // Join driver info
    {
      $lookup: {
        from: "drivers",
        localField: "driver",
        foreignField: "_id",
        as: "driverInfo",
      },
    },
    {
      $unwind: {
        path: "$driverInfo",
        preserveNullAndEmptyArrays: true,
      },
    },
  ];

  if (search) {
    const parts = search.trim().split(/\s+/);
    const userQueries = parts.map((part) => ({
      $or: [
        { "userInfo.firstName": { $regex: part, $options: "i" } },
        { "userInfo.lastName": { $regex: part, $options: "i" } },
      ],
    }));
    const driverQueries = parts.map((part) => ({
      $or: [
        { "driverInfo.firstName": { $regex: part, $options: "i" } },
        { "driverInfo.lastName": { $regex: part, $options: "i" } },
      ],
    }));

    pipeline.push({
      $match: {
        $or: [
          { $and: userQueries },
          { $and: driverQueries },
          { "userInfo.phone": { $regex: search, $options: "i" } },
          { "driverInfo.phone": { $regex: search, $options: "i" } },
          { "pickupPoint.placeName": { $regex: search, $options: "i" } },
          {
            "dropOffPointRequested.placeName": {
              $regex: search,
              $options: "i",
            },
          },
        ],
      },
    });
  }

  pipeline.push({
    $sort: { createdAt: sortDirection },
  });

  const rides = await RideModel.aggregate(pipeline);

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return "";
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const getFullName = (first, last) => {
    const f = first || "";
    const l = last || "";
    const full = `${f} ${l}`.trim();
    return full || "";
  };

  // Define columns based on status (drop off place name is in completed)
  const isCompleted = status === "completed";

  const columns = [
    {
      header: "Driver Name",
      getValue: (r) =>
        getFullName(r.driverInfo?.firstName, r.driverInfo?.lastName),
    },
    {
      header: "Driver Phone Number",
      getValue: (r) => r.driverInfo?.phone || "",
    },
    {
      header: "Rider Name",
      getValue: (r) => getFullName(r.userInfo?.firstName, r.userInfo?.lastName),
    },
    { header: "Rider Phone Number", getValue: (r) => r.userInfo?.phone || "" },
    {
      header: "Pickup Place Name",
      getValue: (r) => r.pickupPoint?.placeName || "",
    },
    ...(!isCompleted
      ? []
      : [
          {
            header: "Drop Off Place Name",
            getValue: (r) => r.dropOffPointRequested?.placeName || "",
          },
        ]),
    {
      header: "Fare Charged",
      getValue: (r) =>
        r.rideFare !== undefined && r.rideFare !== null ? r.rideFare : "",
    },
    { header: "Ride Type", getValue: (r) => r.rideType || "" },
  ];

  const headerLine = columns.map((col) => escapeCsv(col.header)).join(",");
  const dataLines = rides.map((ride) =>
    columns.map((col) => escapeCsv(col.getValue(ride))).join(","),
  );

  const csv = [headerLine, ...dataLines].join("\n");

  return {
    filename: `${status}-rides-export-${Date.now()}.csv`,
    csv,
  };
}

// ── Ride Rates ────────────────────────────────────────────────────────────────

async function getRideConfiguration() {
  const configuration =
    await RideConfigurationService.getRideDistanceConfiguration();

  return { data: configuration };
}

async function updateRideConfiguration(updates) {
  const configuration =
    await RideConfigurationService.updateRideDistanceConfiguration(updates);

  return { data: configuration };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getRideRates({ city, cityName } = {}) {
  const cityFilter = normalizeCity(city);
  const cityNameSearch = normalizeCity(cityName);
  const cityRateFilter = cityFilter
    ? { cityKey: cityFilter }
    : cityNameSearch
      ? { cityKey: { $regex: escapeRegex(cityNameSearch), $options: "i" } }
      : {};

  const [rates, cityRates, peakWindows] = await Promise.all([
    RideRateModel.find({}).lean(),
    CityRideRateModel.find(cityRateFilter)
      .sort({ city: 1, rideType: 1 })
      .lean(),
    PeakWindowModel.find({}).lean(),
  ]);

  return {
    data: {
      rates,
      cityRates,
      peakWindows,
    },
  };
}

async function createCityRideRate(body) {
  try {
    const rate = await CityRideRateModel.create({
      ...body,
      city: body.city.trim(),
      cityKey: normalizeCity(body.city),
      brackets: sortBrackets(body.brackets),
    });

    return { data: rate };
  } catch (error) {
    if (error?.code === 11000) {
      throw new ConflictError(
        `City pricing for '${body.city}' and '${body.rideType}' already exists`,
      );
    }
    throw error;
  }
}

async function updateCityRideRate(id, updates) {
  const rate = await CityRideRateModel.findById(id);

  if (!rate) throw new NotFoundError("City ride rate not found");

  if (updates.city !== undefined) {
    rate.city = updates.city.trim();
    rate.cityKey = normalizeCity(updates.city);
  }
  if (updates.rideType !== undefined) rate.rideType = updates.rideType;
  if (updates.brackets !== undefined)
    rate.brackets = sortBrackets(updates.brackets);
  if (updates.peakSurchargePerMile !== undefined)
    rate.peakSurchargePerMile = updates.peakSurchargePerMile;
  if (updates.isActive !== undefined) rate.isActive = updates.isActive;

  try {
    await rate.save();
  } catch (error) {
    if (error?.code === 11000) {
      throw new ConflictError(
        `City pricing for '${rate.city}' and '${rate.rideType}' already exists`,
      );
    }
    throw error;
  }

  return { data: rate };
}

async function deleteCityRideRate(id) {
  const rate = await CityRideRateModel.findByIdAndDelete(id);

  if (!rate) throw new NotFoundError("City ride rate not found");

  return { data: { deleted: true } };
}

async function updateRideRate(rideType, updates) {
  const rate = await RideRateModel.findOne({ rideType });

  if (!rate) {
    throw new NotFoundError(`Ride rate for '${rideType}' not found`);
  }

  if (updates.brackets !== undefined) rate.brackets = updates.brackets;
  if (updates.peakSurchargePerMile !== undefined)
    rate.peakSurchargePerMile = updates.peakSurchargePerMile;
  if (updates.discountPercentage !== undefined)
    rate.discountPercentage = updates.discountPercentage;
  if (updates.isActive !== undefined) rate.isActive = updates.isActive;

  await rate.save();

  return { data: rate };
}

// ── Peak Windows ──────────────────────────────────────────────────────────────

async function getPeakWindows() {
  const windows = await PeakWindowModel.find({}).sort({ startHour: 1 }).lean();
  return { data: windows };
}

async function createPeakWindow(body) {
  const { startHour, endHour, isActive = true } = body;

  if (endHour <= startHour) {
    throw new BadRequestError("endHour must be greater than startHour");
  }

  // Two intervals [A,B) and [C,D) overlap when A < D && C < B
  const overlapping = await PeakWindowModel.findOne({
    startHour: { $lt: endHour },
    endHour: { $gt: startHour },
  });

  if (overlapping) {
    throw new BadRequestError(
      `This window (${startHour}:00 – ${endHour}:00) overlaps with an existing peak window (${overlapping.startHour}:00 – ${overlapping.endHour}:00).`,
    );
  }

  const window = await PeakWindowModel.create({ startHour, endHour, isActive });

  return { data: window };
}

async function updatePeakWindow(id, updates) {
  const window = await PeakWindowModel.findById(id);

  if (!window) {
    throw new NotFoundError("Peak window not found");
  }

  if (updates.startHour !== undefined) window.startHour = updates.startHour;
  if (updates.endHour !== undefined) window.endHour = updates.endHour;
  if (updates.isActive !== undefined) window.isActive = updates.isActive;

  if (window.endHour <= window.startHour) {
    throw new BadRequestError("endHour must be greater than startHour");
  }

  // Two intervals [A,B) and [C,D) overlap when A < D && C < B
  // Exclude the current document from the check so a no-op update doesn't conflict with itself
  const overlapping = await PeakWindowModel.findOne({
    _id: { $ne: window._id },
    startHour: { $lt: window.endHour },
    endHour: { $gt: window.startHour },
  });

  if (overlapping) {
    throw new BadRequestError(
      `This window (${window.startHour}:00 – ${window.endHour}:00) overlaps with an existing peak window (${overlapping.startHour}:00 – ${overlapping.endHour}:00).`,
    );
  }

  await window.save();

  return { data: window };
}

async function deletePeakWindow(id) {
  const window = await PeakWindowModel.findByIdAndDelete(id);

  if (!window) {
    throw new NotFoundError("Peak window not found");
  }

  return { data: { deleted: true } };
}

const updateAdminUser = async (id, updates, adminUser) => {
  const admin = await AdminModel.findOne({
    _id: id,
    ...getVisibleIdentityEmailFilter(adminUser),
  });
  if (!admin) {
    throw new NotFoundError("Admin user not found");
  }

  if (
    shouldRestrictInternalData(adminUser) &&
    updates.email &&
    isInternalIdentityEmail(updates.email)
  ) {
    throw new ForbiddenError(
      "Cannot create or modify an internal admin account",
    );
  }

  if (admin.role === "super_admin") {
    throw new ForbiddenError("Cannot modify a super_admin account");
  }

  Object.assign(admin, updates);
  await admin.save();

  const adminObj = admin.toObject();
  delete adminObj.password;

  return { status: "success", data: adminObj };
};

const deleteAdminUser = async (id, adminUser) => {
  const admin = await AdminModel.findOne({
    _id: id,
    ...getVisibleIdentityEmailFilter(adminUser),
  });
  if (!admin) {
    throw new NotFoundError("Admin user not found");
  }

  if (admin.role === ADMIN_ROLES.SUPER_ADMIN) {
    throw new ForbiddenError("Cannot delete a super_admin account");
  }

  await AdminModel.findByIdAndDelete(id);

  return { status: "success", data: { deleted: true } };
};

const createAdminUser = async ({ name, email, password, role }, adminUser) => {
  if (shouldRestrictInternalData(adminUser) && isInternalIdentityEmail(email)) {
    throw new ForbiddenError(
      "Cannot create or modify an internal admin account",
    );
  }

  const existing = await AdminModel.findOne({ email });
  if (existing) {
    throw new BadRequestError("An admin with this email already exists");
  }

  const admin = new AdminModel({ name, email, password, role });
  await admin.save();

  const adminObj = admin.toObject();
  delete adminObj.password;

  return { status: "success", data: adminObj };
};

const listAdminUsers = async (
  { page = 1, limit = 10, search, role, isActive, sort = "desc" },
  adminUser,
) => {
  const parsedPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const parsedLimit = Math.min(
    100,
    Math.max(1, Number.parseInt(limit, 10) || 10),
  );
  const filter = { ...getVisibleIdentityEmailFilter(adminUser) };

  if (role) filter.role = role;
  if (isActive !== undefined) filter.isActive = isActive;
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parsedPage - 1) * parsedLimit;
  const sortOrder = sort === "asc" ? 1 : -1;

  const [admins, total] = await Promise.all([
    AdminModel.find(filter)
      .sort({ createdAt: sortOrder, _id: sortOrder })
      .skip(skip)
      .limit(parsedLimit)
      .lean(),
    AdminModel.countDocuments(filter),
  ]);

  return {
    status: "success",
    data: {
      admins,
      pagination: {
        total,
        currentPage: parsedPage,
        page: parsedLimit,
        totalPages: Math.ceil(total / parsedLimit),
      },
    },
  };
};

async function getAdminNotificationById(id, adminUser) {
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const notification = await ScheduledNotificationModel.findOne({
    _id: id,
    recipientId: {
      $nin: [
        ...restrictedIdentityIds.userIds,
        ...restrictedIdentityIds.driverIds,
      ],
    },
  });
  if (!notification) {
    throw new NotFoundError("Scheduled notification not found");
  }
  return {
    message: "Scheduled notification retrieved successfully",
    data: notification,
  };
}

async function updateAdminNotification(id, data, adminUser) {
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const notification = await ScheduledNotificationModel.findOne({
    _id: id,
    recipientId: {
      $nin: [
        ...restrictedIdentityIds.userIds,
        ...restrictedIdentityIds.driverIds,
      ],
    },
  });
  if (!notification) {
    throw new NotFoundError("Scheduled notification not found");
  }

  if (notification.status !== "pending") {
    throw new BadRequestError(
      "Cannot edit a notification that is already sent or failed",
    );
  }

  if (data.scheduledFor) {
    const scheduledDate = new Date(data.scheduledFor);
    if (scheduledDate <= new Date()) {
      throw new BadRequestError("Scheduled time must be in the future");
    }
    notification.scheduledFor = scheduledDate;
  }

  if (data.title !== undefined) notification.title = data.title;
  if (data.message !== undefined) notification.message = data.message;
  if (data.recipientType !== undefined)
    notification.recipientType = data.recipientType;

  await notification.save();

  return {
    message: "Scheduled notification updated successfully",
    data: notification,
  };
}

async function deleteAdminNotification(id, adminUser) {
  const restrictedIdentityIds = await getRestrictedIdentityIds(adminUser);
  const notification = await ScheduledNotificationModel.findOne({
    _id: id,
    recipientId: {
      $nin: [
        ...restrictedIdentityIds.userIds,
        ...restrictedIdentityIds.driverIds,
      ],
    },
  });
  if (!notification) {
    throw new NotFoundError("Scheduled notification not found");
  }

  await ScheduledNotificationModel.findByIdAndDelete(id);

  return {
    message: "Scheduled notification deleted successfully",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver Suspension Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manually suspend a driver from the admin panel.
 * - Stores suspension metadata in Redis (driver:<id>:admin:suspension)
 * - If durationHours is provided → Redis key expires after that duration
 * - If no duration → indefinite; also flips isDeactivatedByAdmin in MongoDB
 * - Force-logs out the driver by wiping their session records
 */
async function suspendDriver(
  driverId,
  adminId,
  reason,
  durationHours,
  adminUser,
) {
  await assertVisibleIdentity(DriverModel, driverId, adminUser, "Driver");
  const driver = await DriverModel.findOne({
    _id: driverId,
    isDeleted: false,
  }).select("firstName lastName email signUpRecord");

  if (!driver) {
    throw new NotFoundError("Driver not found");
  }

  const suspendedAt = new Date().toISOString();
  const durationSeconds = durationHours
    ? Math.round(durationHours * 3600)
    : null;

  const suspensionKey = REDIS_CONSTANTS.keys.adminSuspension(driverId);
  const suspensionData = JSON.stringify({
    reason,
    suspendedAt,
    durationSeconds,
    suspendedByAdminId: adminId ? adminId.toString() : null,
  });

  // Store in Redis
  await redis.set(suspensionKey, suspensionData);

  // Apply TTL only if duration is provided
  if (durationSeconds) {
    await redis.expire(suspensionKey, durationSeconds);
  }

  // For indefinite suspensions also set the MongoDB flag
  if (!durationSeconds) {
    await DriverModel.findByIdAndUpdate(driverId, {
      isDeactivatedByAdmin: true,
    });
    if (driver.signUpRecord) {
      await SignupModel.findByIdAndUpdate(driver.signUpRecord, {
        isDeactivatedByAdmin: true,
      });
    }
  }

  // Force logout — delete all active sessions so existing socket connections
  // also get blocked on the next auth middleware check
  await LoggedDeviceModel.deleteMany({
    user: new mongoose.Types.ObjectId(driverId),
    userType: "Driver",
  });

  // Save admin notification
  await NotificationModel.create({
    title: "Driver Suspended by Admin",
    description: `${driver.firstName || ""} ${driver.lastName || ""} has been suspended. Reason: ${reason}. Duration: ${durationHours ? `${durationHours} hour(s)` : "Indefinite"}.`,
    metadata: {
      id: driverId,
      type: "driver",
    },
    userIds: [],
    role: "Admin",
  });

  return {
    message: "Driver suspended successfully",
    data: {
      driverId,
      reason,
      suspendedAt,
      durationHours: durationHours || null,
      durationSeconds,
      suspensionType: durationSeconds ? "admin_manual" : "admin_permanent",
    },
  };
}

/**
 * Lift any suspension on a driver:
 * - Removes admin:suspension Redis key
 * - Resets isDeactivatedByAdmin in MongoDB
 * - Resets cancellation counter in Redis
 */
async function unsuspendDriver(driverId, adminUser) {
  await assertVisibleIdentity(DriverModel, driverId, adminUser, "Driver");
  const driver = await DriverModel.findOne({
    _id: driverId,
    isDeleted: false,
  }).select("firstName lastName signUpRecord isDeactivatedByAdmin");

  if (!driver) {
    throw new NotFoundError("Driver not found");
  }

  const suspensionKey = REDIS_CONSTANTS.keys.adminSuspension(driverId);
  const cancellationKey = `${DRIVER}:${driverId}:${CANCELLATIONS}`;

  await Promise.all([
    redis.del(suspensionKey),
    redis.del(cancellationKey),
    DriverModel.findByIdAndUpdate(driverId, { isDeactivatedByAdmin: false }),
  ]);

  if (driver.signUpRecord) {
    await SignupModel.findByIdAndUpdate(driver.signUpRecord, {
      isDeactivatedByAdmin: false,
    });
  }

  return {
    message: "Driver suspension lifted successfully",
    data: {
      driverId,
      status: "active",
    },
  };
}

/**
 * Get suspension details for a single driver.
 * Checks all three suspension sources and returns a unified object.
 */
async function getDriverSuspensionDetails(driverId, adminUser) {
  await assertVisibleIdentity(DriverModel, driverId, adminUser, "Driver");
  const driver = await DriverModel.findOne({
    _id: driverId,
    isDeleted: false,
  }).select("firstName lastName email isDeactivatedByAdmin");

  if (!driver) {
    throw new NotFoundError("Driver not found");
  }

  const suspensionKey = REDIS_CONSTANTS.keys.adminSuspension(driverId);
  const cancellationKey = `${DRIVER}:${driverId}:${CANCELLATIONS}`;

  const [
    adminSuspensionRaw,
    adminSuspensionTtl,
    cancellationCount,
    cancellationTtl,
  ] = await Promise.all([
    redis.get(suspensionKey),
    redis.ttl(suspensionKey),
    redis.get(cancellationKey),
    redis.ttl(cancellationKey),
  ]);

  const suspensions = [];

  // Admin-initiated suspension (Redis)
  if (adminSuspensionRaw) {
    const meta = JSON.parse(adminSuspensionRaw);
    suspensions.push({
      suspensionType: meta.durationSeconds ? "admin_manual" : "admin_permanent",
      reason: meta.reason,
      suspendedAt: meta.suspendedAt,
      durationSeconds: meta.durationSeconds,
      remainingSeconds: adminSuspensionTtl >= 0 ? adminSuspensionTtl : null,
      suspendedByAdminId: meta.suspendedByAdminId,
    });
  }

  // Permanent MongoDB deactivation (not already covered by Redis key)
  if (driver.isDeactivatedByAdmin && !adminSuspensionRaw) {
    suspensions.push({
      suspensionType: "admin_permanent",
      reason: "admin_deactivated",
      suspendedAt: null,
      durationSeconds: null,
      remainingSeconds: null,
      suspendedByAdminId: null,
    });
  }

  // Cancellation-based suspension (Redis counter)
  const cancellationCountNum = Number(cancellationCount);
  if (cancellationCountNum >= REDIS_CONSTANTS.MAX_CANCELLATIONS) {
    suspensions.push({
      suspensionType: "cancellation",
      reason: "ride_cancellations",
      suspendedAt: null,
      durationSeconds: REDIS_CONSTANTS.CANCELLATION_WINDOW_TTL,
      remainingSeconds: cancellationTtl >= 0 ? cancellationTtl : null,
      cancellationCount: cancellationCountNum,
      maxCancellations: REDIS_CONSTANTS.MAX_CANCELLATIONS,
    });
  }

  const isSuspended = suspensions.length > 0 || driver.isDeactivatedByAdmin;

  return {
    data: {
      driver: {
        _id: driver._id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        email: driver.email,
      },
      isSuspended,
      suspensions,
    },
  };
}

/**
 * List all currently suspended drivers (paginated).
 * Aggregates:
 *   1. Drivers with isDeactivatedByAdmin: true from MongoDB
 *   2. Drivers with active admin:suspension Redis key
 *   3. Drivers with ride cancellation suspension Redis key
 *
 * Optional query param: suspensionType = "all" | "cancellation" | "admin_manual" | "admin_permanent"
 */
async function getSuspendedDrivers(query, adminUser) {
  const { page = 1, limit = 10, suspensionType = "all", search } = query;

  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const readSuspensions = async () => {
    const adminSuspendedMap = new Map();
    const cancellationSuspendedMap = new Map();
    const seenKeys = new Set();
    const batchSize = 500;
    let cursor = "0";

    // Scan both key families in one pass without blocking Redis with KEYS.
    do {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `${DRIVER}:*`,
        "COUNT",
        batchSize,
      );
      cursor = nextCursor;
      const suspensionKeys = keys.filter((key) => {
        const suffix = key.slice(DRIVER.length + 1);
        const matches =
          suffix.endsWith(":admin:suspension") ||
          suffix.endsWith(`:${CANCELLATIONS}`);
        if (!matches || seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      });

      // SCAN may return duplicates, empty pages, or more than COUNT keys.
      for (
        let offset = 0;
        offset < suspensionKeys.length;
        offset += batchSize
      ) {
        const batch = suspensionKeys.slice(offset, offset + batchSize);
        const pipeline = redis.pipeline();
        for (const key of batch) {
          pipeline.get(key);
          pipeline.ttl(key);
        }
        const results = await pipeline.exec();
        for (let i = 0; i < batch.length; i++) {
          const key = batch[i];
          const driverId = key.split(":")[1];
          const rawVal = results[i * 2][1];
          const ttl = results[i * 2 + 1][1];
          if (key.endsWith(":admin:suspension")) {
            if (rawVal) {
              try {
                const meta = JSON.parse(rawVal);
                adminSuspendedMap.set(driverId, { meta, ttl });
              } catch (_) {}
            }
          } else {
            const count = Number(rawVal);
            if (count >= REDIS_CONSTANTS.MAX_CANCELLATIONS) {
              cancellationSuspendedMap.set(driverId, { count, ttl });
            }
          }
        }
      }
    } while (cursor !== "0");

    return [adminSuspendedMap, cancellationSuspendedMap];
  };

  // ── 3. Fetch permanently deactivated drivers from MongoDB ──────────────────
  const mongoMatchStage = {
    isDeactivatedByAdmin: true,
    isDeleted: false,
    ...getVisibleIdentityEmailFilter(adminUser),
  };

  if (search) {
    const parts = search.trim().split(/\s+/);
    const nameQueries = parts.map((part) => ({
      $or: [
        { firstName: { $regex: part, $options: "i" } },
        { lastName: { $regex: part, $options: "i" } },
      ],
    }));
    mongoMatchStage.$or = [
      { $and: nameQueries },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const [[adminSuspendedMap, cancellationSuspendedMap], mongoDeactivated] =
    await Promise.all([
      readSuspensions(),
      DriverModel.find(mongoMatchStage)
        .select("_id firstName lastName email createdAt")
        .lean(),
    ]);

  // ── 4. Build unified set of suspended driver IDs ───────────────────────────
  const allDriverIds = new Set([
    ...mongoDeactivated.map((d) => d._id.toString()),
    ...adminSuspendedMap.keys(),
    ...cancellationSuspendedMap.keys(),
  ]);

  // Fetch any driver data for Redis-only suspensions (not in MongoDB result)
  const mongoDriverIds = new Set(mongoDeactivated.map((d) => d._id.toString()));
  const redisOnlyIds = [...allDriverIds].filter(
    (id) => !mongoDriverIds.has(id),
  );

  let redisOnlyDrivers = [];
  if (redisOnlyIds.length > 0) {
    redisOnlyDrivers = await DriverModel.find({
      _id: { $in: redisOnlyIds.map((id) => new mongoose.Types.ObjectId(id)) },
      isDeleted: false,
      ...getVisibleIdentityEmailFilter(adminUser),
    })
      .select("_id firstName lastName email")
      .lean();
  }

  // Combine all driver records into a single lookup map
  const driverLookup = new Map();
  for (const d of mongoDeactivated) {
    driverLookup.set(d._id.toString(), d);
  }
  for (const d of redisOnlyDrivers) {
    driverLookup.set(d._id.toString(), d);
  }

  // ── 5. Build result list ───────────────────────────────────────────────────
  let allSuspensions = [];

  for (const driverId of allDriverIds) {
    const driver = driverLookup.get(driverId);
    if (!driver) continue;

    // Apply search filter for Redis-only drivers (MongoDB search already filtered above)
    if (search && !mongoDriverIds.has(driverId)) {
      const fullName =
        `${driver.firstName || ""} ${driver.lastName || ""}`.toLowerCase();
      const emailMatch = (driver.email || "")
        .toLowerCase()
        .includes(search.toLowerCase());
      const nameMatch = fullName.includes(search.toLowerCase());
      if (!emailMatch && !nameMatch) continue;
    }

    const adminSuspension = adminSuspendedMap.get(driverId);
    const cancellationSuspension = cancellationSuspendedMap.get(driverId);
    const isPermanentlyDeactivated =
      mongoDriverIds.has(driverId) && !adminSuspension;

    // Determine primary suspension entry to report
    if (adminSuspension) {
      const { meta, ttl } = adminSuspension;
      const type = meta.durationSeconds ? "admin_manual" : "admin_permanent";
      if (suspensionType === "all" || suspensionType === type) {
        allSuspensions.push({
          driverId,
          driver: {
            _id: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            email: driver.email,
          },
          suspensionType: type,
          reason: meta.reason,
          suspendedAt: meta.suspendedAt,
          durationSeconds: meta.durationSeconds,
          remainingSeconds: ttl >= 0 ? ttl : null,
          suspendedByAdminId: meta.suspendedByAdminId,
        });
      }
    } else if (isPermanentlyDeactivated) {
      if (suspensionType === "all" || suspensionType === "admin_permanent") {
        allSuspensions.push({
          driverId,
          driver: {
            _id: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            email: driver.email,
          },
          suspensionType: "admin_permanent",
          reason: "admin_deactivated",
          suspendedAt: null,
          durationSeconds: null,
          remainingSeconds: null,
          suspendedByAdminId: null,
        });
      }
    }

    if (cancellationSuspension) {
      if (suspensionType === "all" || suspensionType === "cancellation") {
        allSuspensions.push({
          driverId,
          driver: {
            _id: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            email: driver.email,
          },
          suspensionType: "cancellation",
          reason: "ride_cancellations",
          suspendedAt: null,
          durationSeconds: REDIS_CONSTANTS.CANCELLATION_WINDOW_TTL,
          remainingSeconds:
            cancellationSuspension.ttl >= 0 ? cancellationSuspension.ttl : null,
          cancellationCount: cancellationSuspension.count,
          maxCancellations: REDIS_CONSTANTS.MAX_CANCELLATIONS,
        });
      }
    }
  }

  // ── 6. Paginate in-memory ──────────────────────────────────────────────────
  const total = allSuspensions.length;
  const totalPages = Math.ceil(total / parsedLimit);
  const skip = (parsedPage - 1) * parsedLimit;
  const paginated = allSuspensions.slice(skip, skip + parsedLimit);

  return {
    data: paginated,
    pagination: {
      page: parsedPage,
      limit: parsedLimit,
      total,
      totalPages,
    },
  };
}

module.exports = {
  login,
  getDrivers,
  getDocuments,
  getVehicles,
  respondToDocs,
  getUsers,
  getUserById,
  updateUserStatus,
  getSubscriptionRevenue,
  getReports,
  getReportById,
  resolveReport,
  getWithdrawalCommission,
  sendAdminNotification,
  getAdminNotifications,
  getDashboardStats,
  getRideAnalytics,
  forgotPasswordAdmin,
  resetPasswordAdmin,
  verifyOtp,
  updatePassword,
  getPendingDriverRequests,
  updateUserOrDriver,
  getDriverSubscriptionTransactions,
  getRides,
  getRideById,
  getCarpoolRides,
  getCarpoolDetails,
  deleteUser,
  getAllAdminNotifications,
  getBirdsEyeView,
  exportUsersCSV,
  exportRidesCSV,
  getRideRates,
  getRideConfiguration,
  updateRideConfiguration,
  updateRideRate,
  createCityRideRate,
  updateCityRideRate,
  deleteCityRideRate,
  getPeakWindows,
  createPeakWindow,
  updatePeakWindow,
  deletePeakWindow,
  createAdminUser,
  listAdminUsers,
  updateAdminUser,
  deleteAdminUser,
  getAdminNotificationById,
  updateAdminNotification,
  deleteAdminNotification,
  // Driver Suspension Management
  suspendDriver,
  unsuspendDriver,
  getSuspendedDrivers,
  getDriverSuspensionDetails,
  getRewardedBalanceHistory,
};
