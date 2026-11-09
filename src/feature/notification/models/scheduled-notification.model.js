const { Schema, model, models } = require("mongoose");

const ScheduledNotificationSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    recipientType: {
      type: String,
      enum: ["riders", "drivers", "both", "rider", "driver"],
      required: true,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    includeInternalRecipients: {
      type: Boolean,
      default: false,
    },
    scheduledFor: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
  },
  { timestamps: true },
);

const ScheduledNotificationModel =
  models.ScheduledNotification ||
  model("ScheduledNotification", ScheduledNotificationSchema);

module.exports = ScheduledNotificationModel;
