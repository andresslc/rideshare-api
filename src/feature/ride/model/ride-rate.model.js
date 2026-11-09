const mongoose = require("mongoose");

const rateBracketSchema = new mongoose.Schema(
  {
    minMiles: { type: Number, required: true },
    maxMiles: { type: Number, required: false },
    ratePerMile: { type: Number, required: true },
  },
  { _id: false },
);

const rideRateSchema = new mongoose.Schema(
  {
    rideType: {
      type: String,
      enum: ["luxury", "economy", "carpool"],
      required: true,
      unique: true,
    },

    brackets: {
      type: [rateBracketSchema],
      required: true,
    },

    peakSurchargePerMile: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    effectiveFrom: {
      type: Date,
      default: Date.now,
    },

    discountPercentage: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("RideRate", rideRateSchema);
