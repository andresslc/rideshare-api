const { Schema, model, models } = require("mongoose");

const UserSchema = new Schema(
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
    profilePicture: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    signUpRecord: {
      type: Schema.Types.ObjectId,
      ref: "Signup",
    },
    stripeCustomerId: {
      type: String,
      default: null,
    },
    isDeactivatedByAdmin: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
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
    locale: {
      type: String,
      default: "en",
    },
    isNotificationEnabled: {
      type: Boolean,
      default: true,
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
    dob: {
      type: Date,
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

UserSchema.index({ isDeleted: 1, isDeactivatedByAdmin: 1, createdAt: -1 });

const UserModel = models.User || model("User", UserSchema);

module.exports = UserModel;
