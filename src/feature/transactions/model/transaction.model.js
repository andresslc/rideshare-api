const mongoose = require("mongoose");
const { Schema, models, model } = mongoose;

const transactionSchema = new Schema(
  {
    amount: {
      type: Number,
    },
    type: {
      type: String,
    },
    rewardedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    isRewarded: {
      type: Boolean,
      default: false,
    },
    balanceSource: {
      type: String,
      enum: ["regular", "rewarded", "mixed"],
      default: "regular",
    },
    user: {
      type: Schema.Types.ObjectId,
      refPath: "userType",
    },
    userType: {
      type: String,
      required: true,
      enum: ["User", "Driver", "Platform"],
    },
    identifierKey: {
      type: String,
    },
    bank: {
      type: Schema.Types.ObjectId,
      ref: "BankDetails",
    },
    card: {
      type: Schema.Types.ObjectId,
      ref: "Card",
    },
    stripeIds: {
      transfer: String,
      payout: String,
      paymentIntent: String,
    },
    status: {
      type: String,
      enum: ["initiated", "processing", "success", "failed"],
    },
    errorMessage: {
      type: String,
    },
    purpose: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    stripeFee: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Supports per-driver subscription revenue lookups and global revenue totals.
transactionSchema.index({ user: 1, userType: 1, purpose: 1, status: 1 });
transactionSchema.index({ user: 1, userType: 1, createdAt: -1 });
transactionSchema.index({ identifierKey: 1 });
transactionSchema.index(
  { identifierKey: 1, user: 1, userType: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      identifierKey: { $type: "string" },
      user: { $type: "objectId" },
    },
  },
);
transactionSchema.index({ purpose: 1, status: 1, userType: 1, createdAt: -1 });

// Limit these indexes to the admin history records they serve.
transactionSchema.index(
  { userType: 1, status: 1 },
  { partialFilterExpression: { bank: { $exists: true }, amount: { $gt: 0 } } },
);
transactionSchema.index(
  { createdAt: -1 },
  { partialFilterExpression: { purpose: "admin_reward", status: "success" } },
);
transactionSchema.index(
  { amount: -1 },
  { partialFilterExpression: { purpose: "admin_reward", status: "success" } },
);

const TransactionModel =
  models.Transaction || model("Transaction", transactionSchema);
module.exports = TransactionModel;
