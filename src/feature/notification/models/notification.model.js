const { Schema, model, models } = require("mongoose");

const NotificationSchema = new Schema(
  {
    notificationContent: {
      type: Schema.Types.ObjectId,
      ref: "NotificationContent",
    },
    user: {
      type: Schema.Types.ObjectId,
      refPath: "userType",
    },
    userType: {
      type: String,
      enum: ["User", "Driver", "Admin"],
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

const NotificationModel =
  models.Notification || model("Notification", NotificationSchema);

module.exports = NotificationModel;
