const { Schema, model } = require("mongoose");

const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },

    sender: {
      id: {
        type: Schema.Types.ObjectId,
        refPath: "sender.type",
        required: true,
      },
      type: {
        type: String,
        enum: ["User", "Driver"],
        required: true,
      },
    },

    receiver: {
      id: {
        type: Schema.Types.ObjectId,
        refPath: "receiver.type",
        required: true,
      },
      type: {
        type: String,
        enum: ["User", "Driver"],
        required: true,
      },
    },

    message: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read'],
      default: 'sent',
    },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, status: 1 });

module.exports = model("Message", messageSchema);
