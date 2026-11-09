const express = require("express");
const router = express.Router();
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware.js");

const chatController = require("./chat.controller");
const { validate } = require("../../core/middlewares/validate.middleware");
const {
  sendMessageValidator,
  historyValidator,
} = require("./dto/chat.validator");
const catchAsync = require("../../core/common/catch-async.js");

router.use(protectRouteMiddleware);

router.post(
  "/send",
  validate(sendMessageValidator),
  catchAsync(chatController.sendMessage),
);

router.get(
  "/:contextId/history",
  validate(historyValidator),
  catchAsync(chatController.getChatHistory),
);

module.exports = {
  path: "/chat",
  router,
};
