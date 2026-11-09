const { Schema, model, models } = require("mongoose");
const {
  CARPOOL_STATUS_ENUM,
} = require("../../../core/common/constants/carpool-constants");

const LocationSchema = new Schema(
  {
    type: { type: String, default: "Point" },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  { _id: false },
);

const RouteStopSchema = new Schema({
  placeName: { type: String, required: true },
  location: { type: LocationSchema, required: true },
  status: {
    type: String,
    enum: ["pending", "arrived", "coming"],
    default: "pending",
  },
  order: { type: Number, required: true }, // 1-based, strictly ascending
});

const CarpoolRouteSchema = new Schema(
  {
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },

    startingPoint: {
      placeName: { type: String, required: true },
      location: { type: LocationSchema, required: true },
    },

    destination: {
      placeName: { type: String, required: true },
      location: { type: LocationSchema, required: true },
    },

    /* Ordered waypoints — index 0 is start, last is destination */
    routes: {
      type: [RouteStopSchema],
      required: true,
      validate: {
        validator: (arr) => arr.length >= 2,
        message: "A carpool route must have at least 2 stops",
      },
    },

    status: {
      type: String,
      enum: Object.values(CARPOOL_STATUS_ENUM),
      default: CARPOOL_STATUS_ENUM.OPEN,
      index: true,
    },

    cancelledBy: {
      type: String,
      enum: ["user", "driver", "payment_failure", null],
      default: null,
    },

    cancellationReason: {
      type: String,
      default: null,
    },

    maxPassengers: {
      type: Number,
      required: true,
      min: 1,
    },

    availableSeats: {
      type: Number,
      required: true,
      min: 0,
    },

    graceTime: {
      type: Date,
      required: true,
      index: true,
    },

    avgTime: {
      type: Number,
      min: 0,
      default: 0,
    },

    distance: {
      type: Number,
      min: 0,
      default: 0,
    },

    routeStartedAt: { type: Date },
    routeCompletedAt: { type: Date },
    cancelledAt: { type: Date },

    /* Populated when passengers are accepted */
    passengers: [
      {
        user: { type: Schema.Types.ObjectId, ref: "User" },
        bookingId: { type: Schema.Types.ObjectId, ref: "CarpoolBooking" },
        pickupStop: RouteStopSchema,
        dropOffStop: RouteStopSchema,
        status: {
          type: String,
          enum: ["pending", "accepted", "rejected", "completed", "cancelled"],
          default: "pending",
        },
      },
    ],
  },
  { timestamps: true },
);

/* 2dsphere on every route stop location for $near queries */
CarpoolRouteSchema.index({ "routes.location": "2dsphere" });

/* Compound index for the most common query: open routes with seats */
CarpoolRouteSchema.index({ status: 1, availableSeats: 1, graceTime: 1 });
CarpoolRouteSchema.index({ status: 1, createdAt: -1 });
CarpoolRouteSchema.index({ createdAt: -1 });
CarpoolRouteSchema.index({ driver: 1, status: 1, createdAt: -1 });
CarpoolRouteSchema.index({ "passengers.user": 1, status: 1, createdAt: -1 });

const CarpoolRouteModel =
  models.CarpoolRoute || model("CarpoolRoute", CarpoolRouteSchema);

module.exports = CarpoolRouteModel;
