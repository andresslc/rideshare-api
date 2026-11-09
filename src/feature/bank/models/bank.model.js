const mongoose = require("mongoose");

const bankDetailsSchema = new mongoose.Schema(
  {
    driver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Driver",
      required: true,
      index: true,
    },
    bankId: {
      type: String,
      required: true,
    },
    bankTitle: {
      type: String,
      required: true,
      default: "Stripe Bank",
    },
    accountHolderName: {
      type: String,
      required: true,
    },
    accountNumber: {
      type: String,
      required: true,
    },
    routingNumber: {
      type: String,
      required: true,
    },
    status: {
      type: String,
    },
    selected: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
);

const BankModel =
  mongoose.models.BankDetails ||
  mongoose.model("BankDetails", bankDetailsSchema);

module.exports = BankModel;
