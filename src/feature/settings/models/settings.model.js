const { Schema, model, models } = require("mongoose");

const SettingsSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null
    },
    notification: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

const SettingsModel = models.Settings || model("Settings", SettingsSchema);

module.exports = SettingsModel;
