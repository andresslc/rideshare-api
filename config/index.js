require("dotenv").config();
const { env } = process;

module.exports = {
  // App
  APP_NAME: env.APP_NAME || "App",
  NODE_ENV: env.NODE_ENV || "development",
  PORT: Number(env.PORT || 3000),
  SERVICE_URL: env.SERVICE_URL || `http://localhost:${env.PORT || 3000}`,
  TEST_OTP: env.TEST_OTP || "112233",
  FRONTEND_URL: env.FRONTEND_URL || "http://localhost:5173",
  BUSINESS_TIME_ZONE: env.BUSINESS_TIME_ZONE || "America/New_York",

  // JWT
  JWT_SECRET: env.JWT_SECRET,
  JWT_EXPIRES_IN: env.JWT_EXPIRES_IN || "180d",

  // Mongo
  MONGO_URI: env.MONGO_URI || "mongodb://localhost:27017/app",

  // Stripe
  STRIPE: {
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY: env.STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_KEY: env.STRIPE_WEBHOOK_KEY,
    STRIPE_CONNECTED_WEBHOOK_KEY: env.STRIPE_CONNECTED_WEBHOOK_KEY,
    STRIPE_WEBHOOK_KEY_MAIN: env.STRIPE_WEBHOOK_KEY_MAIN,
    STRIPE_APPLICATION_FEE: Number(env.STRIPE_APPLICATION_FEE) || 0,
    REQUEST_TIMEOUT_MS: Math.max(
      1000,
      Number(env.STRIPE_REQUEST_TIMEOUT_MS) || 10000,
    ),
    MAX_NETWORK_RETRIES: Math.max(
      0,
      env.STRIPE_MAX_NETWORK_RETRIES == null
        ? 1
        : Number(env.STRIPE_MAX_NETWORK_RETRIES),
    ),
  },

  // SendGrid
  SENDGRID: {
    IS_ENABLED: env.SENDGRID_ENABLED === "true",
    API_KEY: env.SENDGRID_API_KEY,
    SENDER: env.SENDGRID_SENDER,
  },

  NODEMAILER: {
    IS_ENABLED: env.NODEMAILER_ENABLED === "true",
    NODEMAILER_HOST: env.NODEMAILER_HOST,
    NODEMAILER_PORT: Number(env.NODEMAILER_PORT) || 587,
    // Email
    EMAIL_SERVICE: env.EMAIL_SERVICE || "gmail",
    EMAIL_USER: env.EMAIL_USER,
    EMAIL_PASSWORD: env.EMAIL_PASSWORD,
  },

  // Twilio
  TWILIO: {
    IS_ENABLED: env.TWILIO_ENABLED === "true",
    ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
    AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
    PHONE_NUMBER: env.TWILIO_PHONE_NUMBER,
    MESSAGING_SID: env.TWILIO_MESSAGING_SID,
    VERIFY_SERVICE_SID: env.TWILIO_VERIFY_SERVICE_SID,
  },

  // CDN
  CDN: {
    CDN_TYPE: env.CDN_TYPE,
    CDN_REGION: env.CDN_REGION,
    CDN_BUCKET_NAME: env.CDN_BUCKET_NAME,
    CDN_ENDPOINT: env.CDN_ENDPOINT,
    CDN_KEY: env.CDN_KEY,
    CDN_SECRET: env.CDN_SECRET,
  },
  REDIS: {
    IS_ENABLED: env.REDIS_IS_ENABLED === "true",
    HOST: env.REDIS_HOST || "localhost",
    PORT: Number(env.REDIS_PORT) || 6379,
    PASSWORD: env.REDIS_PASSWORD || "",
    DB: Number(env.REDIS_DB) || 0,
    CONNECT_TIMEOUT_MS: Math.max(
      500,
      Number(env.REDIS_CONNECT_TIMEOUT_MS) || 5000,
    ),
    MAX_RETRIES_PER_REQUEST: Math.max(
      0,
      env.REDIS_MAX_RETRIES_PER_REQUEST == null
        ? 2
        : Number(env.REDIS_MAX_RETRIES_PER_REQUEST),
    ),
  },
  BULLMQ: {
    IS_ENABLED: env.BULLMQ_ENABLED === "true",
  },

  JOURNEY_LOGGING: {
    // Clients can keep publishing live GPS updates at their current rate.
    // MongoDB only persists one breadcrumb per active journey per interval.
    LOCATION_SAMPLE_INTERVAL_SECONDS: Math.max(
      60,
      Math.floor(Number(env.JOURNEY_LOCATION_SAMPLE_INTERVAL_SECONDS)) || 180,
    ),
    // Event GPS and sampled GPS rarely match exactly. Group events into the
    // same map marker when they are within this distance.
    EVENT_LOCATION_GROUP_RADIUS_METERS: Math.min(
      500,
      Math.max(
        5,
        Math.floor(Number(env.JOURNEY_EVENT_GROUP_RADIUS_METERS)) || 50,
      ),
    ),
  },

  // Veriff
  VERIFF: {
    VERIFF_BASE_URL: env.VERIFF_BASE_URL,
    VERIFF_API_KEY: env.VERIFF_API_KEY,
    VERIFF_API_SECRET: env.VERIFF_API_SECRET || env.VERIFF_HMAC_SECRET,
  },
};
