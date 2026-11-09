const { Schema, model, models } = require("mongoose");

const vehicleSchema = new Schema(
  {
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },

    make: {
      type: String,
      required: [true, "Vehicle make is required"],
      trim: true,
    },

    model: {
      type: String,
      required: [true, "Vehicle model is required"],
      trim: true,
    },

    yearOfManufacture: {
      type: Number,
      required: [true, "Year of manufacture is required"],
      min: [1900, "Invalid manufacturing year"],
    },

    color: {
      type: String,
      required: [true, "Vehicle color is required"],
      trim: true,
    },

    vehicleIdentificationNumber: {
      type: String,
      required: [true, "VIN is required"],
      trim: true,
    },

    licensePlateNumber: {
      type: String,
      required: [true, "License plate number is required"],
      trim: true,
      index: true,
    },

    // registrationNumber: {
    //   type: String,
    //   required: [true, "Registration number is required"],
    //   trim: true,
    // },

    regionOfRegistration: {
      type: String,
      required: [true, "Region of registration is required"],
      trim: true,
    },

    expiryDate: {
      type: Date,
      required: [true, "Registration expiry date is required"],
    },

    // Raw value submitted by the driver (for example, SUV or Sedan).
    // The mapped economy/luxury class remains on Driver.vehicleType.
    vehicleType: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "old"],
      default: "pending",
    },

    rejectReason: {
      type: String,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Supports admin lookups that filter each driver's active vehicles by status.
vehicleSchema.index({ driver: 1, isDeleted: 1, status: 1 });
// Supports pending driver counts and status-first admin driver eligibility.
vehicleSchema.index({ status: 1, isDeleted: 1, driver: 1 });
vehicleSchema.index({ status: 1, _id: 1 });

const VehicleModel = models.Vehicle || model("Vehicle", vehicleSchema);
module.exports = VehicleModel;
