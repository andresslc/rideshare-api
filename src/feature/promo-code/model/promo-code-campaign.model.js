const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const promoCodeCampaignSchema = Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: null,
    },
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      required: true,
    },
    discountValue: {
      type: Number,
      required: true,
    },
    maxDiscountCap: {
      type: Number,
      default: null,
    },
    minRideAmount: {
      type: Number,
      default: null,
    },
    startDate: {
      type: Date,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    maxUsesPerUser: {
      type: Number,
      required: true,
      default: 1,
    },
    totalRedemptionLimit: {
      type: Number,
      required: true,
    },
    codeMode: {
      type: String,
      enum: ["public", "unique"],
      required: true,
    },
    eligibility: {
      rideTypes: {
        type: [String],
        enum: ["economy", "luxury", "private", "carpool"],
        default: [],
      },
      userType: {
        type: String,
        enum: ["all", "new", "existing"],
        default: "all",
      },
      minAge: {
        type: Number,
        default: null,
      },
      cities: {
        type: [String],
        default: [],
      },
    },
    status: {
      type: String,
      enum: ["active", "paused", "expired"],
      default: "active",
    },
    totalRedemptions: {
      type: Number,
      default: 0,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

const PromoCodeCampaign =
  models.PromoCodeCampaign ||
  model("PromoCodeCampaign", promoCodeCampaignSchema);
module.exports = PromoCodeCampaign;
