const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const env = require("../../config");

let connectionInstance = null;

/**
 * Recursively load all *.model.js files from feature/*
 */
const loadModels = (baseDir) => {
  fs.readdirSync(baseDir).forEach((item) => {
    const fullPath = path.join(baseDir, item);
    const stat = fs.statSync(fullPath);

    // Go deeper into directories
    if (stat.isDirectory()) {
      loadModels(fullPath);
      return;
    }

    // Load only *.model.js (case-safe)
    if (!item.endsWith(".model.js")) {
      return;
    }

    require(fullPath);
    console.log(`📦 Model loaded: ${item}`);
  });
};

/**
 * Connect MongoDB
 */
const connect = async () => {
  try {
    if (connectionInstance) {
      return connectionInstance;
    }

    connectionInstance = await mongoose.connect(env.MONGO_URI);

    console.log("✅ MongoDB connected");

    const featureDir = path.join(process.cwd(), "src", "feature");
    loadModels(featureDir);

    console.log("✅ All models loaded");

    return connectionInstance;
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    throw error;
  }
};

/**
 * Disconnect MongoDB
 */
const disconnect = async () => {
  try {
    if (!connectionInstance) {
      return;
    }

    await mongoose.disconnect();
    connectionInstance = null;
    console.log("✅ MongoDB disconnected");
  } catch (error) {
    console.error("❌ MongoDB disconnect error:", error);
    throw error;
  }
};

module.exports = Object.freeze({
  connect,
  disconnect,
});
