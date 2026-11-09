const mongoose = require("mongoose");
const { Schema, model, Types, models } = mongoose;

const configSchema = new Schema({
  environments: {
    dev: {
      baseUrl: String,
    },
    staging: {
      baseUrl: String,
    },
    prod: {
      baseUrl: String,
    },
  },

  appVersion: {
    type: String,
    required: true,
  },

  minSupportedVersion: String,

  maintenanceMode: {
    type: Boolean,
    default: false,
  },

  features: {
    type: Map,
    of: Types.Mixed,
    default: {},
  },

  config: {
    type: Map,
    of: Types.Mixed,
    default: {},
  },
});

const ConfigModel = models.Config || model("Config", configSchema);
module.exports = ConfigModel;
