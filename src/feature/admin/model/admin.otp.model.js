const { Schema, model, models } = require("mongoose");

const AdminOTPSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
    },
    otp: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true },
);

AdminOTPSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

const AdminOTPModel = models.AdminOTP || model("AdminOTP", AdminOTPSchema);

module.exports = AdminOTPModel;
