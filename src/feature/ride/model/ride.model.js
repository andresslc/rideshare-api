const { Schema, model, models } = require("mongoose");
const {
  RIDE_STATUS_ENUM,
  RIDE_TYPE,
  RIDE_PAYMENT_METHODS,
} = require("../../../core/common/constants/ride-constants");

const LocationSchema = new Schema(
  {
    type: {
      type: String,
      default: "Point",
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  },
  { _id: false },
);

const RideSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: false,
    },
    pickupPoint: {
      placeName: String,
      location: LocationSchema,
    },
    // The city the fare was quoted against. Stored because a re-quote — an
    // upgrade offered after an exhausted search — must hit the same city rate
    // the rider was first shown, and `pickupPoint.placeName` is a street
    // address, not a city key.
    pickupCity: {
      type: String,
      trim: true,
    },
    dropOffPointRequested: {
      placeName: String,
      location: LocationSchema,
    },
    dropOffPoint: {
      placeName: String,
      location: LocationSchema,
    },
    specialRequest: {
      type: String,
    },
    rideJourneyPoints: {
      type: [
        {
          placeName: String,
          hasReached: {
            type: Boolean,
            default: false,
          },
          location: LocationSchema,
        },
      ],
      default: [],
    },
    rideStatus: {
      type: String,
      enum: RIDE_STATUS_ENUM,
      default: "accepted",
    },
    rideType: {
      type: String,
      enum: RIDE_TYPE,
      default: "economy",
    },
    rideDistance: {
      type: Number,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: RIDE_PAYMENT_METHODS,
      default: "attached_card",
      required: false,
    },
    rideFare: {
      type: Number,
      required: false,
      default: 0,
    },
    economyRideFare: {
      type: Number,
      required: false,
      default: 0,
    },
    luxuryRideFare: {
      type: Number,
      required: false,
      default: 0,
    },
    originalRideFare: {
      type: Number,
      required: false,
      default: 0,
    },
    originalEconomyRideFare: {
      type: Number,
    },
    originalLuxuryRideFare: {
      type: Number,
    },
    codeId: {
      type: Schema.Types.ObjectId,
      ref: "PromoCode",
    },
    campaignId: {
      type: Schema.Types.ObjectId,
      ref: "PromoCodeCampaign",
    },
    // Set when the discount on this ride comes from a driver's referral code
    // rather than a promo campaign. The two never share a ride.
    riderReferral: {
      type: Schema.Types.ObjectId,
      ref: "RiderReferral",
      default: null,
    },
    discountAmount: {
      type: Number,
    },
    averageTime: {
      type: Number, // store in minutes
      required: false,
    },
    rideDate: {
      type: Date,
      required: false,
    },
    requestedAt: Date,
    acceptedAt: Date,
    driverArrivedAt: Date,
    passengerComingAt: Date,
    otpVerifiedAt: Date,
    paymentCompletedAt: Date,
    startedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    startTime: {
      type: Date,
      required: false,
    },
    endTime: {
      type: Date,
      required: false,
    },

    paymentStatus: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
    },
    cancelledBy: {
      type: String,
      enum: ["user", "driver", null],
      default: null,
    },
    cancellationReason: {
      type: String,
      default: null,
    },
    selectedOffer: {
      type: Schema.Types.ObjectId,
      ref: "RideOffer",
      required: false,
    },
    // The question put to the rider when a search exhausts: retry in a pricier
    // category, or lose the request. The ride stays "requested" the whole time,
    // so this is the only record that the offer is open — every transition is a
    // conditional update on `status`, which is what makes the accept, the
    // timeout and a driver's acceptance race safely against each other.
    upgradeOffer: {
      // offered → accepting → accepted | declined | timed_out | payment_failed
      //                                | superseded
      status: { type: String, default: null },
      fromRideType: { type: String, default: null },
      toRideType: { type: String, default: null },
      quotedFare: { type: Number, default: null },
      // The rider's promo code is not valid in the new category and will be
      // dropped if they accept. Recorded so support can see what was lost.
      promoCodeDropped: { type: Boolean, default: false },
      offeredAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      decidedAt: { type: Date, default: null },
      // On a referral ride `quotedFare` is already discounted. This is the full
      // price behind it, which is what the driver is paid if the rider accepts.
      fullFare: { type: Number, default: null },
    },
    // Settlement of a ride cancelled after Start Ride. The full fare was taken
    // at start, so the rider is refunded the undelivered share and the driver
    // keeps only the delivered share. The quote is frozen on the first attempt
    // so a retry refunds the same amount under the same Stripe idempotency key.
    // processing → completed | failed (a failed settlement can be retried)
    midTripCancellation: {
      status: { type: String, default: null },
      cancelledBy: { type: String, default: null },
      paymentMethod: { type: String, default: null },
      travelledMiles: { type: Number, default: null },
      elapsedMinutes: { type: Number, default: null },
      distanceShare: { type: Number, default: null },
      timeShare: { type: Number, default: null },
      share: { type: Number, default: null },
      riderPaid: { type: Number, default: null },
      riderCharged: { type: Number, default: null },
      riderRefund: { type: Number, default: null },
      riderRegularRefund: { type: Number, default: null },
      riderRewardedRefund: { type: Number, default: null },
      driverPaid: { type: Number, default: null },
      driverKept: { type: Number, default: null },
      driverClawback: { type: Number, default: null },
      platformAbsorbed: { type: Number, default: null },
      platformReversal: { type: Number, default: null },
      stripeRefundId: { type: String, default: null },
      errorMessage: { type: String, default: null },
      claimedAt: { type: Date, default: null },
      settledAt: { type: Date, default: null },
    },
    // Which search generation this ride is on. Ring jobs carry it, so a
    // straggler from the first search cannot reopen a ring of — or conclude —
    // the search that replaced it.
    searchAttempt: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

RideSchema.index({ "pickupPoint.location": "2dsphere" });
RideSchema.index({ rideStatus: 1, createdAt: -1 });
RideSchema.index({ createdAt: -1 });
RideSchema.index({ user: 1, rideStatus: 1, createdAt: -1 });
RideSchema.index({ driver: 1, rideStatus: 1, createdAt: -1 });

const RideModel = models.Ride || model("Ride", RideSchema);

module.exports = RideModel;
