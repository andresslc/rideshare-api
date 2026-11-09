const mongoose = require("mongoose");
const ConversationModel = require("./model/conversation.model");
const Message = require("./model/message.model");

const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  USER,
  SOCKET,
  DRIVER,
} = require("../../core/common/constants/ride-constants");
const {
  CHAT_CONSTANTS,
} = require("../../core/common/constants/chat-constants");

const redis = getRedisConnection();

const getOrCreateConversation = async (
  user1,
  user2,
  contextId,
  contextType,
) => {
  let conversation = await ConversationModel.findOne({
    participants: { $all: [user1, user2] },
    contextId: new mongoose.Types.ObjectId(contextId),
    contextType,
  });

  if (!conversation) {
    conversation = await ConversationModel.create({
      participants: [user1, user2],
      contextId: new mongoose.Types.ObjectId(contextId),
      contextType,
    });
  }

  return conversation;
};

const markMessagesAsRead = async (conversationId, readerId) => {
  const result = await Message.updateMany(
    {
      conversationId: new mongoose.Types.ObjectId(conversationId),
      "receiver.id": new mongoose.Types.ObjectId(readerId),
      status: { $ne: "read" },
    },
    { $set: { status: "read" } },
  );

  return result.modifiedCount;
};

const createMessage = async (
  senderId,
  receiverId,
  message,
  contextId,
  contextType,
  senderType,
  receiverType,
) => {
  const conversation = await getOrCreateConversation(
    senderId,
    receiverId,
    contextId,
    contextType,
  );

  const socketKeyMap = {
    user: `${USER}:${receiverId}:${SOCKET}`,
    driver: `${DRIVER}:${receiverId}:${SOCKET}`,
  };

  const socketKey = socketKeyMap[receiverType?.toLowerCase()];

  // Check if receiver is currently online via Redis
  const receiverSocketId = await redis.get(socketKey);
  const initialStatus = receiverSocketId ? "delivered" : "sent";

  const msg = await Message.create({
    conversationId: conversation._id,
    sender: { id: senderId, type: senderType },
    receiver: { id: receiverId, type: receiverType },
    message,
    status: initialStatus,
  });

  conversation.lastMessage = msg._id;
  await conversation.save();

  // Sender is active in conversation — mark all messages sent TO them as read
  const readModifiedCount = await markMessagesAsRead(
    conversation._id,
    senderId,
  );

  return { msg, conversation, readModifiedCount };
};

const getChatHistory = async (contextId, page, limit, requesterId, io) => {
  const skip = (page - 1) * limit;

  const conversation = await ConversationModel.findOne({
    contextId: new mongoose.Types.ObjectId(contextId),
  });

  if (!conversation) {
    return { data: [], pagination: { page, limit } };
  }

  const messages = await Message.find({
    conversationId: conversation._id,
  })
    .populate([
      { path: "sender", select: "firstName lastName email" },
      { path: "receiver", select: "firstName lastName email" },
    ])
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(Number(limit));

  // Auto mark as read — all messages where receiver = requester
  const modifiedCount = await markMessagesAsRead(conversation._id, requesterId);

  // Notify room if anything was updated
  if (modifiedCount > 0 && io) {
    const chatRoom =
      conversation.contextType === "Ride"
        ? CHAT_CONSTANTS.keys.rideChatRoom(contextId)
        : CHAT_CONSTANTS.keys.carpoolChatRoom(contextId);

    io.to(chatRoom).emit(CHAT_CONSTANTS.keys.MESSAGE_STATUS_UPDATED, {
      conversationId: conversation._id,
      status: "read",
      updatedBy: requesterId,
    });
  }

  return { data: messages, pagination: { page, limit } };
};

module.exports = {
  createMessage,
  getChatHistory,
  markMessagesAsRead,
};
