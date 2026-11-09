const mongoose = require("mongoose");

const peakWindowSchema = new mongoose.Schema(
  {
    startHour: { type: Number, required: true },
    endHour: { type: Number, required: true },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PeakWindow", peakWindowSchema);
