const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const promoCodeRedemptionSchema = Schema(
  {
    promoCode: {
      type: Schema.Types.ObjectId,
      ref: "PromoCode",
      required: true,
    },
    campaign: {
      type: Schema.Types.ObjectId,
      ref: "PromoCodeCampaign",
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    appliedTo: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "appliedToType",
    },
    appliedToType: {
      type: String,
      enum: ["Ride", "CarpoolBooking"],
      required: true,
    },
    discountApplied: {
      type: Number,
      required: true,
    },
    redeemedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

promoCodeRedemptionSchema.index({ user: 1, campaign: 1 });

const PromoCodeRedemption =
  models.PromoCodeRedemption ||
  model("PromoCodeRedemption", promoCodeRedemptionSchema);
module.exports = PromoCodeRedemption;
