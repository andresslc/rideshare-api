const { models, model } = require("mongoose");
const { Schema } = require("mongoose");

const documentSchema = Schema(
  {
    frontImage: {
      type: String,
    },
    backImage: {
      type: String,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "old", "verified"],
      default: "pending",
    },
    rejectReason: {
      type: String,
    },
    rejectionReason: {
      type: String,
      default: null,
    },
    driver: {
      type: Schema.Types.ObjectId,
      ref: "Driver",
    },
    type: {
      type: String,
      enum: [
        "driverLicense",
        "vehicleRegistration",
        "insurance",
        "vehicleDetails",
      ],
    },
    veriffSessionId: {
      type: String,
      default: null,
    },
    veriffLastSubmittedAt: {
      type: Date,
      default: null,
    },
    veriffDecisionTime: {
      type: Date,
      default: null,
    },
    veriffAttemptId: {
      type: String,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Supports the admin driver listing's correlated lookup and latest-first sort.
documentSchema.index({ driver: 1, status: 1, createdAt: -1 });
// Supports pending driver counts and status-first admin driver eligibility.
documentSchema.index({ status: 1, isDeleted: 1, driver: 1 });
// Covers status-first eligibility reads without loading document metadata.
documentSchema.index({ status: 1, _id: 1 });

const DocumentModel = models.Document || model("Document", documentSchema);
module.exports = DocumentModel;
