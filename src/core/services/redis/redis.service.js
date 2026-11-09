const IORedis = require("ioredis");
const { REDIS } = require("../../../../config");

let redis;

function getRedisOptions() {
  return {
    host: REDIS.HOST || "localhost",
    port: REDIS.PORT || 6379,
    password: REDIS.PASSWORD,
    db: REDIS.DB || 0,
    connectTimeout: REDIS.CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: REDIS.MAX_RETRIES_PER_REQUEST,
    enableReadyCheck: true,
    lazyConnect: false,
  };
}

function getRedisConnection() {
  if (!REDIS.IS_ENABLED) {
    console.log("Redis is disabled");
    return null;
  }

  if (!redis) {
    redis = new IORedis(getRedisOptions());

    redis.on("connect", () => {
      console.log("✅ Redis connected");
    });

    redis.on("error", (err) => {
      console.error("❌ Redis error:", err);
    });

    redis.on("close", () => {
      console.log("⚠️ Redis connection closed");
    });
  }

  return redis;
}

module.exports = { getRedisConnection, getRedisOptions };
