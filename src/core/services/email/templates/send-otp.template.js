module.exports = (otp) => {
  return `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #4CAF50;">Your One-Time Password (OTP)</h2>
        <p>Use the following OTP to complete your action. This OTP is valid for the next 10 minutes.</p>
        <div style="font-size: 24px; font-weight: bold; margin: 20px 0; padding: 10px; border: 2px dashed #4CAF50; display: inline-block;">
            ${otp}
        </div>
        <p>If you did not request this OTP, please ignore this email.</p>
        <p>Thank you,<br/>The Team</p>
    </div>
    `;
};
