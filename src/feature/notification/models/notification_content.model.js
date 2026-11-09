const { Schema, model, models } = require("mongoose");

const NotificationContentSchema = new Schema(
  {
    title: {
      type: String,
      default: null,
    },
    description: {
      type: String,
      default: null,
    },
    metaData: {
      type: Schema.Types.Mixed,
      default: null,
    },
    isAdmin: {
      type: Boolean,
      default: false,
      select: false,
    },
  },
  { timestamps: true },
);

const NotificationContentModel =
  models.NotificationContentContent ||
  model("NotificationContent", NotificationContentSchema);

module.exports = NotificationContentModel;
