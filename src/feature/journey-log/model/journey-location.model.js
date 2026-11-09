const { Schema, model, models } = require("mongoose");

const JourneyLocationSchema = new Schema(
  {
    journeyType: {
      type: String,
      enum: ["ride", "carpool"],
      required: true,
    },
    journeyId: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    driverId: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },
    observedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    ingestedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        required: true,
        validate: {
          validator: ([lng, lat] = []) =>
            Number.isFinite(lng) &&
            Number.isFinite(lat) &&
            lng >= -180 &&
            lng <= 180 &&
            lat >= -90 &&
            lat <= 90,
          message: "Invalid journey location coordinates",
        },
      },
    },
    phase: {
      type: String,
      enum: ["to_pickup", "waiting_pickup", "on_trip"],
      default: null,
    },
    accuracyM: { type: Number, min: 0, default: null },
    speedMps: { type: Number, min: 0, default: null },
    heading: { type: Number, min: 0, max: 360, default: null },
    sampleReason: {
      type: String,
      enum: ["interval", "event", "first", "final"],
      default: "interval",
    },
    schemaVersion: {
      type: Number,
      default: 1,
      immutable: true,
    },
  },
  { timestamps: false },
);

JourneyLocationSchema.index({ journeyType: 1, journeyId: 1, observedAt: 1 });
JourneyLocationSchema.index({ driverId: 1, observedAt: -1 });

const JourneyLocationModel =
  models.JourneyLocation || model("JourneyLocation", JourneyLocationSchema);

module.exports = JourneyLocationModel;
