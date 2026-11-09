const {
  NotFoundError,
  BadRequestError,
} = require("../../core/common/exceptions");
const LoggedDeviceModel = require("../auth/models/logged.device.model");
const DriverModel = require("../driver/models/driver.model");
const UserModel = require("../user/models/user.model");
const firebaseService = require("../../core/services/firebase/firbase.service");
const NotificationModel = require("./models/notification.model");
const NotificationContentModel = require("./models/notification_content.model");
const { paginate, t, aggregatePaginate } = require("../../core/common/helpers");
const mongoose = require("mongoose");

const toggleNotification = async (id, role, token, sessionId) => {
  const modelMap = {
    user: UserModel,
    driver: DriverModel,
  };

  const Model = modelMap[role];

  if (!Model) {
    throw new BadRequestError("Invalid role");
  }

  const user = await Model.findOne({
    _id: id,
  });

  const updatedDoc = await Model.findOneAndUpdate(
    { _id: id },
    [
      {
        $set: {
          isNotificationEnabled: { $not: "$isNotificationEnabled" },
        },
      },
    ],
    { new: true },
  );

  if (!updatedDoc) {
    throw new NotFoundError(`${role} not found`);
  }

  if (token) {
    await LoggedDeviceModel.findOneAndUpdate(
      {
        _id: sessionId,
        user: id,
        userType: "User",
      },
      {
        $set: {
          fcmToken: token,
        },
      },
    );
  }

  return {
    success: true,
    message: `Notifications ${
      updatedDoc.isNotificationEnabled ? "Enabled" : "Disabled"
    }`,
  };
};

const saveNotification = async ({
  title,
  description,
  metadata = {},
  userIds = [],
  role,
  session = null,
}) => {
  const notificationContent = await NotificationContentModel.create(
    [
      {
        title,
        description,
        metaData: metadata,
      },
    ],
    { session },
  );

  const notifications =
    role === "Admin"
      ? [
          {
            notificationContent: notificationContent[0]._id,
            userType: role,
          },
        ]
      : userIds.map((userId) => ({
          notificationContent: notificationContent[0]._id,
          user: userId,
          userType: role,
        }));

  const s = await NotificationModel.insertMany(notifications, { session });
};

const sendNotificationToSpecificUser = async ({
  title,
  description,
  metadata = {},
  userIds = [],
  skipSave = false,
}) => {
  console.log("🚀 ~ sendNotificationToSpecificUser ~ userIds:", userIds)
  if (!userIds?.length) {
    console.error("❌ [NOTIFICATION SERVICE] userIds cannot be empty");
    throw new Error("userIds cannot be empty");
  }
  const userObjectIds = userIds.map((id) => new mongoose.Types.ObjectId(id));
  const [users, drivers] = await Promise.all([
    UserModel.find({
      _id: { $in: userObjectIds },
      isNotificationEnabled: true,
    }).select("_id"),
    DriverModel.find({
      _id: { $in: userObjectIds },
      isNotificationEnabled: true,
    }).select("_id"),
  ]);

  const combinedIds = [
    ...users.map((u) => u._id),
    ...drivers.map((d) => d._id),
  ];
  const notificationEnabledUserIds = combinedIds;

  console.log(
    "✅ [NOTIFICATION SERVICE] Users with notifications enabled:",
    notificationEnabledUserIds,
  );
  const devices = await LoggedDeviceModel.find({
    user: { $in: notificationEnabledUserIds },
    fcmToken: { $ne: null },
  })
    .select("user fcmToken userType")
    .lean();

  if (!devices.length) {
    console.log(
      "⚠️ [NOTIFICATION SERVICE] No devices found with FCM tokens for users:",
      userIds,
    );
    return;
  }
  const fcmTokens = [...new Set(devices.map((d) => d.fcmToken))];

  await firebaseService.sendPushNotification({
    title,
    description,
    metadata,
    fcmTokens,
  });

  if (!skipSave) {
    const usersByType = {};
    for (const device of devices) {
      const uId = device.user.toString();
      const userType = device.userType || "User";
      if (!usersByType[userType]) usersByType[userType] = new Set();
      usersByType[userType].add(uId);
    }

    for (const [role, ids] of Object.entries(usersByType)) {
      await saveNotification({
        title,
        description,
        metadata,
        userIds: Array.from(ids),
        role,
      });
    }
  } else {
    console.log(
      "⏭️ [NOTIFICATION SERVICE] Skipping save to database (skipSave=true)",
    );
  }

  return {
    success: true,
    sentTokens: fcmTokens.length,
  };
};

const retrieveUserNotifications = async (userId, page = 1, limit = 10) => {
  const parsedPage = parseInt(page, 10);
  const parsedLimit = parseInt(limit, 10);

  const notifications = await NotificationModel.find({ user: userId })
    .populate("notificationContent")
    .sort({ createdAt: -1 })
    .skip((parsedPage - 1) * parsedLimit)
    .limit(parsedLimit)
    .lean();

  const pagination = await paginate(
    NotificationModel,
    { user: userId },
    parsedPage,
    parsedLimit,
  );

  console.log(pagination);

  return {
    data: notifications,
    pagination,
  };
};

const clearAllNotifications = async (userId) => {
  const result = await NotificationModel.deleteMany({ user: userId });

  return {
    success: true,
    message: "All notifications cleared successfully",
    deletedCount: result.deletedCount,
  };
};

const deleteSingleNotification = async (userId, notificationId) => {
  const notification = await NotificationModel.findOneAndDelete({
    _id: notificationId,
    user: userId,
  });

  if (!notification) {
    throw new NotFoundError("Notification not found");
  }

  return {
    success: true,
    message: "Notification deleted successfully",
  };
};

module.exports = {
  toggleNotification,
  sendNotificationToSpecificUser,
  saveNotification,
  retrieveUserNotifications,
  clearAllNotifications,
  deleteSingleNotification,
};
