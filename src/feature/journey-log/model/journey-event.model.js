const { Schema, model, models } = require("mongoose");

const GeoPointSchema = new Schema(
  {
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
        message: "Invalid journey event coordinates",
      },
    },
  },
  { _id: false },
);

const JourneyEventSchema = new Schema(
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
    rideId: {
      type: Schema.Types.ObjectId,
      ref: "Ride",
      default: null,
    },
    carpoolId: {
      type: Schema.Types.ObjectId,
      ref: "CarpoolRoute",
      default: null,
    },
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "CarpoolBooking",
      default: null,
    },
    eventType: {
      type: String,
      required: true,
    },
    phase: {
      type: String,
      enum: [
        "pre_assignment",
        "to_pickup",
        "waiting_pickup",
        "on_trip",
        "ended",
      ],
      default: null,
    },
    actor: {
      type: {
        type: String,
        enum: ["user", "driver", "system", "stripe"],
        required: true,
      },
      id: {
        type: Schema.Types.ObjectId,
        default: null,
      },
    },
    source: {
      type: String,
      // "dispatch" is the escalating ring search, which runs both inline from a
      // request and later from its queue worker.
      enum: ["socket", "http", "service", "webhook", "cron", "dispatch"],
      default: "service",
    },
    transition: {
      from: { type: String, default: null },
      to: { type: String, default: null },
    },
    occurredAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    receivedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    clientObservedAt: {
      type: Date,
      default: null,
    },
    location: {
      type: GeoPointSchema,
      default: null,
    },
    locationAccuracyM: {
      type: Number,
      min: 0,
      default: null,
    },
    locationSource: {
      type: String,
      enum: ["payload", "latest_driver_location", "planned_stop", null],
      default: null,
    },
    references: {
      routeStopId: { type: Schema.Types.ObjectId, default: null },
      transactionId: { type: Schema.Types.ObjectId, default: null },
      paymentIntentId: { type: String, default: null },
    },
    amount: {
      value: { type: Number, default: null },
      currency: { type: String, uppercase: true, default: null },
    },
    reasonCode: {
      type: String,
      default: null,
    },
    dedupeKey: {
      type: String,
      default: null,
    },
    correlationId: {
      type: String,
      default: null,
    },
    schemaVersion: {
      type: Number,
      default: 1,
      immutable: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true },
);

JourneyEventSchema.index({ journeyType: 1, journeyId: 1, occurredAt: 1 });
JourneyEventSchema.index({ bookingId: 1, occurredAt: 1 });
JourneyEventSchema.index({ eventType: 1, occurredAt: -1 });
JourneyEventSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
);

const JourneyEventModel =
  models.JourneyEvent || model("JourneyEvent", JourneyEventSchema);

module.exports = JourneyEventModel;
