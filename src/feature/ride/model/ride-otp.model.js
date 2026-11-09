const { Schema, model, models } = require("mongoose");

const RideOtpSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  otp: {
    type: Number,
    required: true,
  },
  ride: {
    type: Schema.Types.ObjectId,
    ref: "Ride",
  },
  attempts: {
    type: Number,
    default: 0,
  },
});

RideOtpSchema.index({ ride: 1 });

const RideOtpModel = models.RideOtp || model("RideOtp", RideOtpSchema);
module.exports = RideOtpModel;
