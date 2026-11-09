const { Schema, model, models } = require("mongoose");

const OTPSchema = new Schema(
  {
    phone: {
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

OTPSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

const OTPModel = models.OTP || model("OTP", OTPSchema);

module.exports = OTPModel;
