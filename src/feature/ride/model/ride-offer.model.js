// ride-offer.model.js
const { Schema, model, models } = require("mongoose");

const RideOfferSchema = new Schema(
  {
    ride: {
      type: Schema.Types.ObjectId,
      ref: "Ride",
      required: true,
    },
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    rideType: {
      type: String,
      enum: ["economy", "luxury"],
      required: true,
    },
    offeredFare: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "expired", "canceled"],
      default: "pending",
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

RideOfferSchema.index({ ride: 1, status: 1 });

const RideOfferModel = models.RideOffer || model("RideOffer", RideOfferSchema);
module.exports = RideOfferModel;
