const { t } = require("../../core/common/helpers");
const NotificationService = require("./notification.service");

const toggleNotificationController = async (req, res) => {
  const id = req.user.id;
  const role = req.params.role;
  const token = req.body.token;
  const sessionId = req.session.id;

  console.log("Toggle Notification Request:", {
    id,
    role,
    token,
    sessionId,
  });

  const result = await NotificationService.toggleNotification(
    id,
    role,
    token,
    sessionId,
  );
  return result;
};

const retrieveNotificationController = async (req, res) => {
  const id = req.user.id;
  const page = req.query.page;
  const limit = req.query.limit;

  const result = await NotificationService.retrieveUserNotifications(
    id,
    page,
    limit,
  );

  return result;
};

const sendNotificationToUser = async (req) => {
  const userId = req.user._id;
  const locale = req.body.locale || "en";

  return await NotificationService.sendNotificationToSpecificUser({
    title: t("RIDE_ACCEPTED", locale),
    description: t("RIDE_ACCEPTED_DESC", locale),
    userIds: [userId],
    role: "user",
  });
};

const clearAllNotificationsController = async (req, res) => {
  const id = req.user.id;

  const result = await NotificationService.clearAllNotifications(id);

  return result;
};

const deleteSingleNotificationController = async (req, res) => {
  const id = req.user.id;
  const { notificationId } = req.params;

  const result = await NotificationService.deleteSingleNotification(
    id,
    notificationId,
  );

  return result;
};

module.exports = {
  toggleNotificationController,
  retrieveNotificationController,
  sendNotificationToUser,
  clearAllNotificationsController,
  deleteSingleNotificationController,
};
