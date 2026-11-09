const cron = require("node-cron");
const ScheduledNotificationModel = require("../notification/models/scheduled-notification.model");
const AdminService = require("./admin.service");

const init = () => {
  cron.schedule("*/5 * * * *", async () => {
    try {
      console.log("Starting scheduled notifications cron job");
      const pendingNotifications = await ScheduledNotificationModel.find({
        status: "pending",
        scheduledFor: { $lte: new Date() },
      });

      console.log(
        `Found ${pendingNotifications?.length || 0} pending notifications`,
      );

      if (!pendingNotifications || pendingNotifications.length === 0) {
        console.log("No pending notifications to process");
        return;
      }

      // trigger without awaiting promise
      pendingNotifications.forEach((notification) => {
        console.log(`Processing notification ${notification._id}`);

        // Mark as sent immediately to avoid duplicate triggering by subsequent crons
        notification.status = "sent";
        notification
          .save()
          .catch((err) =>
            console.error("Error updating notification status:", err),
          );

        // Call the service without waiting
        AdminService.sendAdminNotification(
          {
            recipientType: notification.recipientType,
            recipientId: notification.recipientId,
            title: notification.title,
            message: notification.message,
          },
          null,
          {
            includeInternalData:
              notification.includeInternalRecipients === true,
          },
        ).catch((err) => {
          console.error(
            `Error sending scheduled notification ${notification._id}:`,
            err.message,
          );
        });
      });

      console.log("Scheduled notifications cron job completed");
    } catch (error) {
      console.error("Scheduled Notifications Cron Error:", error);
    }
  });
};

module.exports = { init };
