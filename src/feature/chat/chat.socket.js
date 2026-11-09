const {
  CHAT_CONSTANTS,
} = require("../../core/common/constants/chat-constants");
const {
  sendMessageValidator,
  markAsReadValidator,
  historyValidator,
} = require("./dto/chat.validator");

const {
  createMessage,
  getChatHistory,
  markMessagesAsRead,
} = require("./chat.service");
const ConversationModel = require("./model/conversation.model");

const asyncSocketWrapper = require("../../core/common/socket-async");
const { validateOrFail, ok, t } = require("../../core/common/helpers");

const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");

const redis = getRedisConnection();

module.exports = (io, socket) => {
  const userId = socket.user._id.toString();
  const locale = socket.user.locale || "en";

  /*
  =========================
  SEND MESSAGE
  =========================
  */

  socket.on(
    CHAT_CONSTANTS.keys.SEND_MESSAGE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(sendMessageValidator, payload, callback);
      if (!data) return;

      const { receiverId, message, contextId, contextType } = data;

      const { msg, conversation, readModifiedCount } = await createMessage(
        userId,
        receiverId,
        message,
        contextId,
        contextType,
        socket.user?.role === "Driver" ? "Driver" : "User",
        socket.user?.role === "Driver" ? "User" : "Driver",
      );

      const chatRoom =
        contextType === "Ride"
          ? CHAT_CONSTANTS.keys.rideChatRoom(contextId)
          : CHAT_CONSTANTS.keys.carpoolChatRoom(contextId);

      const response = {
        conversationId: conversation._id,
        sender: msg.sender,
        receiver: msg.receiver,
        message: msg.message,
        status: msg.status,
        createdAt: msg.createdAt,
      };

      if (chatRoom) {
        io.to(chatRoom).emit(CHAT_CONSTANTS.keys.RECEIVE_MESSAGE, response);
      }

      // Notify room if sending caused previous messages to be marked read
      if (readModifiedCount > 0) {
        io.to(chatRoom).emit(CHAT_CONSTANTS.keys.MESSAGE_STATUS_UPDATED, {
          conversationId: conversation._id,
          status: "read",
          updatedBy: userId,
        });
      }

      return ok(callback, t("MESSAGE_SENT", locale), {});
    }),
  );

  /*
  =========================
  CHAT HISTORY
  =========================
  */

  socket.on(
    CHAT_CONSTANTS.keys.HISTORY,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(historyValidator, payload, callback);
      if (!data) return;

      const { contextId, page, limit } = data;

      const messages = await getChatHistory(contextId, page, limit, userId, io);

      return ok(callback, t("CHAT_HISTORY", locale), messages);
    }),
  );

  socket.on(
    CHAT_CONSTANTS.keys.MESSAGE_READ,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(markAsReadValidator, payload, callback);
      console.log("🚀 ~ data:", data)
      if (!data) return;

      const { conversationId } = data;
      console.log("🚀 ~ conversationId:", conversationId)

      const modifiedCount = await markMessagesAsRead(conversationId, userId);
      console.log("🚀 ~ modifiedCount:", modifiedCount)

      const conversation = await ConversationModel.findById(conversationId)
        .select("contextId contextType")
        .lean();
      console.log("🚀 ~ conversation:", conversation)

      if (conversation) {
        const chatRoom =
          conversation.contextType === "Ride"
            ? CHAT_CONSTANTS.keys.rideChatRoom(
                conversation.contextId.toString(),
              )
            : CHAT_CONSTANTS.keys.carpoolChatRoom(
                conversation.contextId.toString(),
              );
        console.log("🚀 ~ chatRoom:", chatRoom)

        io.to(chatRoom).emit(CHAT_CONSTANTS.keys.MESSAGE_STATUS_UPDATED, {
          conversationId,
          status: "read",
          updatedBy: userId,
        });
      }

      return ok(callback, "messages marked as read", { modifiedCount });
    }),
  );
};
