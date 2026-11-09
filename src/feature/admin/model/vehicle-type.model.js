const { Schema, model, models } = require("mongoose");

const vehicleTypeSchema = new Schema(
  {
    make: {
      type: String,
      trim: true,
      lowercase: true,
    },

    model: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
    },

    rideType: {
      type: String,
      enum: ["economy", "luxury", "carpool"],
      required: [true, "Ride type is required"],
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true },
);

// Compound index on [make, model] for efficient lookups
vehicleTypeSchema.index({ make: 1, model: 1 });
// Additional index on make alone for fallback queries
vehicleTypeSchema.index({ make: 1 });
// Index on isActive for filtering
vehicleTypeSchema.index({ make: 1, isActive: 1 });

const VehicleTypeModel =
  models.VehicleType || model("VehicleType", vehicleTypeSchema);

module.exports = VehicleTypeModel;
