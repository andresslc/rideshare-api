const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;
const {
  REFERRAL_STATUS,
  REFERRAL_STATUS_ENUM,
} = require("../driver-referral.helper");

// One document per rider, ever: the unique index on `rider` is what makes a
// driver's code a once-per-rider benefit. The status only moves forward
// (saved -> applied -> completed), except that a ride which ends before the
// rider is charged hands the code back (applied -> saved), and one cancelled
// after the charge uses it up with no bonus (applied -> voided).
const riderReferralSchema = Schema(
  {
    rider: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The driver who owns the code and earns the bonus. Not necessarily the
    // driver who does the ride.
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: REFERRAL_STATUS_ENUM,
      default: REFERRAL_STATUS.SAVED,
    },
    ride: {
      type: Schema.Types.ObjectId,
      ref: "Ride",
      default: null,
    },
    // Copied from the configuration when the code is attached to a ride, so a
    // later change to the amounts never alters a ride already in flight.
    riderDiscountAmount: {
      type: Number,
      min: 0,
      default: null,
    },
    driverBonusAmount: {
      type: Number,
      min: 0,
      default: null,
    },
    bonusTransaction: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
    appliedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    voidedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

riderReferralSchema.index({ rider: 1 }, { unique: true });
riderReferralSchema.index({ driver: 1, status: 1, createdAt: -1 });
riderReferralSchema.index({ ride: 1 });

const RiderReferralModel =
  models.RiderReferral || model("RiderReferral", riderReferralSchema);

module.exports = RiderReferralModel;
