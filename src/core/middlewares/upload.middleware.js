// middlewares/upload.middleware.js
const multer = require("multer");
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

module.exports = uploadMiddleware;
