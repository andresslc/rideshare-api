const { Schema, model, models } = require("mongoose");

const conversationSchema = new Schema(
  {
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],

    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: "Message",
    },

    contextId: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "contextType",
    },

    contextType: {
      type: String,
      required: true,
      enum: ["Ride", "CarpoolBooking"],
    },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1 });
conversationSchema.index({ contextId: 1, contextType: 1 });

const ConversationModel =
  models.Conversation || model("Conversation", conversationSchema);
module.exports = ConversationModel;
