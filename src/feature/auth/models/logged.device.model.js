const { Schema, model, models } = require("mongoose");

const LoggedDeviceSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      refPath: "userType",
      required: true,
    },
    userType: {
      type: String,
      enum: ["User", "Driver", "Admin"],
    },
    fcmToken: {
      type: String,
      default: null,
    },
    deviceIdentity: {
      type: String,
    },
    deviceModel: {
      type: String,
      default: null,
    },
    ipAddress: {
      type: String,
      default: null,
    },
    userAgent: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

LoggedDeviceSchema.index({ user: 1, userType: 1, updatedAt: -1 });

const LoggedDeviceModel =
  models.LoggedDevice || model("LoggedDevice", LoggedDeviceSchema);

module.exports = LoggedDeviceModel;
