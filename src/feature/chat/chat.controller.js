const chatService = require("./chat.service");
const {
  CHAT_CONSTANTS,
} = require("../../core/common/constants/chat-constants");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const UserModel = require("../user/models/user.model");
const { t, formatFullName } = require("../../core/common/helpers");

const sendMessage = async (req, res) => {
  const sender = req.user;
  const role = sender?.vehicleType ? "Driver" : "User";
  const { receiverId, message, contextId, contextType } = req.body;

  const io = req.app.get("io");

  const { msg, conversation, readModifiedCount } =
    await chatService.createMessage(
      sender?._id,
      receiverId,
      message,
      contextId,
      contextType,
      role === "Driver" ? "Driver" : "User",
      role === "Driver" ? "User" : "Driver",
    );

  const chatRoom =
    contextType === "Ride"
      ? CHAT_CONSTANTS.keys.rideChatRoom(contextId)
      : CHAT_CONSTANTS.keys.carpoolChatRoom(contextId);

  const payload = {
    contextId,
    contextType,
    conversationId: conversation._id,
    sender,
    receiver: receiverId,
    message: msg.message,
    status: msg.status,
    createdAt: msg.createdAt,
  };

  if (chatRoom) {
    io.to(chatRoom).emit(CHAT_CONSTANTS.keys.RECEIVE_MESSAGE, payload);
  }

  // If sending this message caused previous messages to be marked read, notify room
  if (readModifiedCount > 0) {
    io.to(chatRoom).emit(CHAT_CONSTANTS.keys.MESSAGE_STATUS_UPDATED, {
      conversationId: conversation._id,
      status: "read",
      updatedBy: sender._id,
    });
  }

  const receiverLocale = await UserModel.findById(receiverId).select("locale");
  sendNotificationToSpecificUser({
    title: t(
      "NOTIFICATION_NEW_MESSAGE_TITLE",
      receiverLocale?.locale || "en",
    ).replace("${senderName}", formatFullName(sender) || "Someone"),
    description: t(
      "NOTIFICATION_NEW_MESSAGE_DESC",
      receiverLocale?.locale || "en",
    ).replace("${senderName}", formatFullName(sender) || "Someone"),
    userIds: [receiverId],
    metadata: {
      riderId: sender._id,
      riderName: formatFullName(sender) || "Someone",
      riderProfileImage: sender.profilePicture || "",
      rideId: contextId,
      type: "NEW_MESSAGE",
      isCarpool: contextType === "CarpoolBooking",
    },
    skipSave: true,
  });

  return payload;
};

const getChatHistory = async (req, res) => {
  const { contextId } = req.params;
  const { page = 1, limit = 20 } = req.query;
  const requesterId = req.user._id;
  const io = req.app.get("io");

  const messages = await chatService.getChatHistory(
    contextId,
    page,
    limit,
    requesterId,
    io,
  );

  return messages;
};

module.exports = {
  sendMessage,
  getChatHistory,
};
