const { Schema, models, model } = require("mongoose");
const { RIDE_TYPE } = require("../../../core/common/constants/ride-constants");

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

const driverSchema = new Schema(
  {
    firstName: {
      type: String,
      default: null,
    },
    lastName: {
      type: String,
      default: null,
    },
    email: {
      type: String,
      required: true,
    },
    referralLink: {
      type: String,
      default: null,
    },
    // The code this driver shares with riders (driver-referral feature). No
    // default on purpose: the unique index is sparse, and a stored `null` would
    // be indexed and collide with every other driver still waiting for one.
    referralCode: {
      type: String,
      uppercase: true,
      trim: true,
      unique: true,
      sparse: true,
    },
    referredBy: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      default: null,
      index: true,
    },
    totalReferrals: {
      type: Number,
      default: 0,
      min: 0,
    },
    referralFreeMonthsRedeemed: {
      type: Number,
      default: 0,
      min: 0,
    },
    referralLastVoidedInvoiceId: {
      type: String,
      default: null,
    },
    profilePicture: {
      type: String,
      default: null,
    },
    signUpRecord: {
      type: Schema.Types.ObjectId,
      ref: "Signup",
    },
    phone: {
      type: String,
      default: null,
    },
    currentLocation: LocationSchema,
    stripeAccountId: {
      type: String,
      default: null,
    },
    stripeCustomerId: {
      type: String,
      default: null,
    },
    balance: {
      type: Number,
      default: 0,
    },
    rewardedBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    pendingWithdrawalBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    pendingRewardedWithdrawalBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    locale: {
      type: String,
      default: "en",
    },
    veriffSessionId: {
      type: String,
      default: null,
    },
    isNotificationEnabled: {
      type: Boolean,
      default: true,
    },
    driverLicense: {
      type: Schema.Types.ObjectId,
      ref: "Document",
    },
    vehicleRegistration: {
      type: Schema.Types.ObjectId,
      ref: "Document",
    },
    insurance: {
      type: Schema.Types.ObjectId,
      ref: "Document",
    },
    vehicleDetails: {
      type: Schema.Types.ObjectId,
      ref: "Vehicle",
    },
    subscription: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
    },
    isDeactivatedByAdmin: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    stripeConnectCapabilities: {
      transfers: {
        type: String,
      },
      payout: {
        type: String,
      },
    },
    isStripeConnectOnboardingCompleted: {
      type: Boolean,
      default: false,
    },
    bank: {
      type: Schema.Types.ObjectId,
      ref: "BankDetails",
    },
    rating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    reviewsReceived: {
      type: Number,
      default: 0,
    },
    reviewsGiven: {
      type: Number,
      default: 0,
    },
    vehicleType: {
      type: String,
      enum: RIDE_TYPE,
      default: "economy",
    },
    ssn: {
      type: String,
      default: null,
    },
    address: {
      type: String,
      default: null,
    },
    state: {
      type: String,
      default: null,
    },
    city: {
      type: String,
      default: null,
    },
  },
  { timestamps: true },
);

// Supports the admin driver page's filter and newest/oldest-first ordering.
driverSchema.index({ isDeleted: 1, createdAt: -1 });

const DriverModel = models.Driver || model("Driver", driverSchema);
module.exports = DriverModel;
