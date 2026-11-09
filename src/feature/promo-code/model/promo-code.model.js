const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const promoCodeSchema = Schema(
  {
    code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
    },
    campaign: {
      type: Schema.Types.ObjectId,
      ref: "PromoCodeCampaign",
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
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

const PromoCode = models.PromoCode || model("PromoCode", promoCodeSchema);
module.exports = PromoCode;
