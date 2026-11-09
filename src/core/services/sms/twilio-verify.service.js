const twilio = require("twilio");
const env = require("../../../../config");

let twilioClient;

const getTwilioClient = () => {
  if (!twilioClient) {
    twilioClient = twilio(env.TWILIO.ACCOUNT_SID, env.TWILIO.AUTH_TOKEN);
  }

  return twilioClient;
};

const normalizePhoneNumber = (phone) => {
  const value = String(phone).trim();
  return value.startsWith("+") ? value : `+${value}`;
};

const createTwilioVerifyService = ({
  client,
  serviceSid = env.TWILIO.VERIFY_SERVICE_SID,
} = {}) => {
  const getVerifyService = () => {
    if (!serviceSid) {
      throw new Error("TWILIO_VERIFY_SERVICE_SID is not configured");
    }

    return (client || getTwilioClient()).verify.v2.services(serviceSid);
  };

  const sendVerification = async (phone, locale) => {
    const payload = {
      to: normalizePhoneNumber(phone),
      channel: "sms",
    };

    if (locale) payload.locale = locale;

    return getVerifyService().verifications.create(payload);
  };

  const checkVerification = async (phone, code) => {
    const verification = await getVerifyService().verificationChecks.create({
      to: normalizePhoneNumber(phone),
      code: String(code),
    });

    return verification.status === "approved";
  };

  return {
    sendVerification,
    checkVerification,
  };
};

const twilioVerifyService = createTwilioVerifyService();

module.exports = {
  ...twilioVerifyService,
  createTwilioVerifyService,
  normalizePhoneNumber,
};
