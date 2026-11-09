const { SENDGRID, NODEMAILER, APP_NAME } = require("../../../../config");
const sgMail = require("@sendgrid/mail");
const nodemailer = require("nodemailer");

const sendEmail = async (subject, message, recipient) => {
  const senderName = "RideShare";
  const senderEmail = SENDGRID.SENDER || NODEMAILER.SENDER_EMAIL;

  if (!senderEmail) {
    console.error("Error: Sender email is not configured.");
    return false;
  }

  const emailData = {
    to: recipient,
    from: { name: senderName, email: senderEmail },
    subject,
    text: message,
  };

  try {
    if (SENDGRID.IS_ENABLED) {
      sgMail.setApiKey(SENDGRID.API_KEY);
      await sgMail.send(emailData);
      console.log("Message sent successfully via SendGrid.");
    } else if (
      NODEMAILER.IS_ENABLED &&
      NODEMAILER.EMAIL_USER &&
      NODEMAILER.EMAIL_PASSWORD
    ) {
      const transporter = nodemailer.createTransport({
        service: env.EMAIL_SERVICE,
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: env.EMAIL_USER,
          pass: env.EMAIL_PASSWORD,
        },
      });

      const mailOptions = {
        ...emailData,
        from: { name: senderName, address: senderEmail },
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(
        `Message sent successfully via Nodemailer. Message ID: ${info.messageId}`,
      );
    } else {
      console.error("Error: No email configuration found.");
      return false;
    }
    return true;
  } catch (error) {
    console.error("Error sending email:", JSON.stringify(error, null, 2));
    return false;
  }
};

module.exports = { sendEmail };
