const { Schema, model, models } = require("mongoose");

const subscriptionSchema = new Schema(
  {
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },

    stripeCustomerId: {
      type: String,
      required: true,
    },

    stripeSubscriptionId: {
      type: String,
      required: true,
      unique: true,
    },

    productId: {
      type: String,
      required: true,
    },

    priceId: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: [
        "incomplete",
        "incomplete_expired",
        "trialing",
        "active",
        "past_due",
        "canceled",
        "unpaid",
        "paused",
      ],
      default: "incomplete",
    },

    currentPeriodStart: {
      type: Date,
    },

    currentPeriodEnd: {
      type: Date,
    },

    cancelAtPeriodEnd: {
      type: Boolean,
      default: false,
    },

    canceledAt: {
      type: Date,
    },

    paidAt: {
      type: Date,
    },
    referralProcessedAt: {
      type: Date,
    },
    amount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Supports the two existing admin subscription revenue sort options.
subscriptionSchema.index({ createdAt: -1 });
subscriptionSchema.index({ driver: 1, createdAt: -1 });
subscriptionSchema.index({ currentPeriodEnd: -1 });

const SubscriptionModel =
  models.Subscription || model("Subscription", subscriptionSchema);
module.exports = SubscriptionModel;
