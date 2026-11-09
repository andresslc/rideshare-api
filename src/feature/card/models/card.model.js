const mongoose = require("mongoose");
const { Schema } = mongoose;

const cardSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    brand: {
      type: String,
      required: true,
    },
    last4: {
      type: String,
      required: true,
    },
    expMonth: {
      type: Number,
      required: true,
    },
    expYear: {
      type: Number,
      required: true,
    },
    paymentMethodId: {
      type: String,
      required: true,
    },
    default: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      default: "active",
      enum: ["active", "inactive", "deleted"],
    },
  },
  { timestamps: true },
);

cardSchema.index({ user: 1, status: 1, default: 1 });

const CardModel = mongoose.models.Card || mongoose.model("Card", cardSchema);
module.exports = CardModel;
