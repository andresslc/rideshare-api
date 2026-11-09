const { Schema, model, models } = require("mongoose");

const ReviewSchema = new Schema(
  {
    reviewer: {
      type: Schema.Types.ObjectId,
      refPath: "reviewerType",
    },
    receiver: {
      type: Schema.Types.ObjectId,
      refPath: "receiverType",
      default: null,
    },
    reviewerType: {
      type: String,
      enum: ["Driver", "User"],
    },
    receiverType: {
      type: String,
      enum: ["Driver", "User"],
    },
    stars: {
      type: Number,
      default: 0,
    },
    description: {
      type: String,
      default: null,
    },
    isAnonymous: {
      type: Boolean,
      default: false,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      select: false,
    },
    ride: {
      type: Schema.Types.ObjectId,
      ref: "Ride",
      default: null,
    },
    carpool: {
      type: Schema.Types.ObjectId,
      ref: "CarpoolRoute",
      default: null,
    },
  },
  { timestamps: true },
);

ReviewSchema.index({ receiver: 1, createdAt: -1 });

const ReviewModel = models.Review || model("Review", ReviewSchema);

module.exports = ReviewModel;
