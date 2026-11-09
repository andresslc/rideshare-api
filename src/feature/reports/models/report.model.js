const { Schema, model, models } = require("mongoose");

const ReportSchema = new Schema(
  {
    reporter: {
      type: Schema.Types.ObjectId,
      refPath: "reporterType",
      required: true,
    },
    reporterType: {
      type: String,
      enum: ["Driver", "User"],
      required: true,
    },
    entityId: {
      type: Schema.Types.ObjectId,
      refPath: "entityType",
      required: true,
    },
    entityType: {
      type: String,
      enum: ["Driver", "User"],
      required: true,
    },
    supportingEntityId: {
      type: Schema.Types.ObjectId,
      refPath: "supportingEntityType",
      required: true,
    },
    supportingEntityType: {
      type: String,
      enum: ["Ride", "CarpoolRoute"],
      required: true,
    },
    reason: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: ["pending", "resolved", "rejected"],
      default: "pending",
      index: true,
    },
    resolvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    adminNotes: {
      type: String,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      select: false,
    },
  },
  { timestamps: true },
);

ReportSchema.index({ isDeleted: 1, createdAt: -1 });
ReportSchema.index({ isDeleted: 1, status: 1, createdAt: -1 });

const ReportModel = models.Report || model("Report", ReportSchema);

module.exports = ReportModel;
