const mongoose = require("mongoose");
const { Schema, model, models } = mongoose;

const DriverShiftSchema = new Schema(
  {
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },
    startTime: { type: Date },
    endTime: { type: Date },
    isActive: { type: Boolean, default: true, index: true },
    isExceedsMaxHours: { type: Boolean, default: false },
    isPendingForceOffline: { type: Boolean, default: false },
    isWarned11h: { type: Boolean, default: false },
    totalMinutes: { type: Number, default: 0 },
    lastSyncTime: { type: Date },
    limitReachedAt: { type: Date },
    forcedOfflineAt: { type: Date },
  },
  {
    timestamps: false,
    versionKey: false,
  },
);

DriverShiftSchema.index({ driverId: 1, isActive: 1 });
DriverShiftSchema.index({ lastSyncTime: -1 });

const DriverShiftModel =
  models.DriverShift || model("DriverShift", DriverShiftSchema);

module.exports = DriverShiftModel;
