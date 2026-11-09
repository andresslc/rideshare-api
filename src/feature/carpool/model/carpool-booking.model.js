const { Schema, model, models } = require("mongoose");
const {
  CARPOOL_BOOKING_STATUS_ENUM,
} = require("../../../core/common/constants/carpool-constants");

const LocationSchema = new Schema(
  {
    type: { type: String, default: "Point" },
    coordinates: { type: [Number], required: true },
  },
  { _id: false },
);

const RouteStopSchema = new Schema(
  {
    placeName: { type: String, required: true },
    location: { type: LocationSchema, required: true },
    order: { type: Number, required: true },
  },
  { _id: false },
);

const CarpoolBookingSchema = new Schema(
  {
    carpool: {
      type: Schema.Types.ObjectId,
      ref: "CarpoolRoute",
      required: true,
      index: true,
    },

    passenger: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
    },

    pickupStop: {
      type: RouteStopSchema,
      required: true,
    },

    dropOffStop: {
      type: RouteStopSchema,
      required: true,
    },

    requiredSeats: {
      type: Number,
      min: 1,
      default: 1,
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

    status: {
      type: String,
      enum: Object.values(CARPOOL_BOOKING_STATUS_ENUM),
      default: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
      index: true,
    },

    fareCharged: {
      type: Number,
      default: 0,
    },

    originalFare: {
      type: Number,
      default: 0,
    },

    codeId: {
      type: Schema.Types.ObjectId,
      ref: "PromoCode",
      default: null,
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "PromoCodeCampaign",
      default: null,
    },
    discountAmount: {
      type: Number,
      default: 0,
    },

    paymentMethod: {
      type: String,
      enum: ["wallet", "attached_card"],
      required: true,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },

    otp: {
      type: String,
      select: false, // never leak OTP in regular queries
    },

    otpVerified: {
      type: Boolean,
      default: false,
    },

    requestedAt: { type: Date },
    acceptedAt: { type: Date },
    otpVerifiedAt: { type: Date },
    paymentCompletedAt: { type: Date },
    rideStartedAt: { type: Date },
    rideCompletedAt: { type: Date },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

CarpoolBookingSchema.index({ passenger: 1, status: 1, createdAt: -1 });

/* Prevent a passenger from having two active bookings on the same carpool */
CarpoolBookingSchema.index(
  { carpool: 1, passenger: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["pending", "accepted"] },
    },
  },
);

const CarpoolBookingModel =
  models.CarpoolBooking || model("CarpoolBooking", CarpoolBookingSchema);

module.exports = CarpoolBookingModel;
