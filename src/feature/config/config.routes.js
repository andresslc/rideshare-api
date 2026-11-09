const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");

const { getConfigController } = require("./config.controller");
const {
  getAppRideConfigurationController,
} = require("./ride-config.controller");

router.get("/", catchAsync(getConfigController));

// Everything the rider and driver apps need to render a dispatch: the ring
// ladder, its timings, the distance unit and the copy — all editable from the
// admin panel, none of it compiled into a build.
router.get("/ride", catchAsync(getAppRideConfigurationController));

module.exports = {
  path: "/config",
  router: router,
};
