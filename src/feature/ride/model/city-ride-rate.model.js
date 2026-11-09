const mongoose = require("mongoose");
const {
  normalizeCity,
  sortBrackets,
  hasRequiredCityBrackets,
} = require("../fare-pricing.helper");

const cityRateBracketSchema = new mongoose.Schema(
  {
    minMiles: { type: Number, required: true },
    maxMiles: { type: Number, default: null },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const cityRideRateSchema = new mongoose.Schema(
  {
    city: {
      type: String,
      required: true,
      trim: true,
    },
    cityKey: {
      type: String,
      required: true,
      select: false,
    },
    rideType: {
      type: String,
      enum: ["luxury", "economy", "carpool"],
      required: true,
    },
    brackets: {
      type: [cityRateBracketSchema],
      required: true,
      validate: {
        validator: hasRequiredCityBrackets,
        message:
          "brackets must define exactly 0-4, 5-9, 10-15, 16-20, and 21+ miles",
      },
    },
    peakSurchargePerMile: {
      type: Number,
      min: 0,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

cityRideRateSchema.index({ cityKey: 1, rideType: 1 }, { unique: true });

cityRideRateSchema.pre("validate", function normalizeCityRate() {
  this.cityKey = normalizeCity(this.city);
  if (Array.isArray(this.brackets)) this.brackets = sortBrackets(this.brackets);
});

module.exports = mongoose.model("CityRideRate", cityRideRateSchema);
