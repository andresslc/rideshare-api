const express = require("express");
const router = express.Router();

const catchAsync = require("../../core/common/catch-async");
const { getPlanController } = require("./plan.controller");

router.get("/", catchAsync(getPlanController));

module.exports = {
  path: "/plan",
  router: router,
};
