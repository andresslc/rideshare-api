const CHAT_CONSTANTS = {
  keys: {
    SEND_MESSAGE: "chat:send",
    RECEIVE_MESSAGE: "chat:receive",
    MESSAGE_READ: "chat:read",
    MESSAGE_STATUS_UPDATED: "chat:status_updated",
    HISTORY: "chat:history",

    rideChatRoom: (uid) => `ride:${uid}`,
    carpoolChatRoom: (uid) => `carpool:${uid}`,
  },
};

module.exports = {
  CHAT_CONSTANTS,
};
