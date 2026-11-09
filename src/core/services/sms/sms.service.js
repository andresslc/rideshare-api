const twilio = require("twilio");
const env = require("../../../../config");

const twilioClient = twilio(env.TWILIO.ACCOUNT_SID, env.TWILIO.AUTH_TOKEN);

const sendSms = async (to, body) => {
  try {
    const message = await twilioClient.messages.create({
      body,
      from: env.TWILIO.PHONE_NUMBER,
      messagingServiceSid: env.TWILIO.MESSAGING_SID,
      to,
    });

    console.log("📱 SMS sent, SID:", message?.sid);
    return message;
  } catch (error) {
    console.error("❌ Error sending SMS:", error.message);
  }
};

module.exports = {
  sendSms,
};
