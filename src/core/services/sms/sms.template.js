const sendNotificationPhone = async (title, message, phone) => {
  const body = `${title}\n${message}\nIf you didn’t request this, please ignore.`;
  return sendSms(phone, body);
};

/**
 * Send OTP to phone for verification
 */
const sendOtpPhone = async (otp, phone, name) => {
  const body = `Hi ${name}, Welcome to Boiler Plate!\nUse this code to verify your phone number: ${otp}\nIf you didn’t request this, ignore this message.`;
  return sendSms(phone, body);
};

/**
 * Send password reset code to phone
 */
const sendPassPhone = async (otp, phone, name) => {
  const body = `Hi ${name},\nIt looks like you’ve requested a password reset for your Boiler Plate account.\nUse this code to create a new password: ${otp}\nIf you didn’t request this, just ignore this message.`;
  return sendSms(phone, body);
};

module.exports = {
  sendNotificationPhone,
  sendOtpPhone,
  sendPassPhone,
};
