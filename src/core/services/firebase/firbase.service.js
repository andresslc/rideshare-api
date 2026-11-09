const admin = require("firebase-admin");
const serviceAccountCredentials = require("../../../../firebase-adminsdk.json");

class FirebaseService {
  constructor() {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccountCredentials),
      });
    }

    this.admin = admin;
    this.db = admin.firestore();
  }

  // SEND NOTIFICATION
  async sendPushNotification({
    title,
    description,
    metadata = {},
    fcmTokens = [],
  }) {
    try {
      const tokens = fcmTokens.filter((token) => Boolean(token));

      if (!tokens.length) {
        console.log(
          "⚠️ [NOTIFICATION] No valid tokens found to send notification to.",
        );
        return;
      }

      // Firebase requires data payload values to be strings
      const formattedMetadata = {};
      Object.keys(metadata).forEach((key) => {
        formattedMetadata[key] = String(metadata[key]);
      });

      const payload = {
        tokens,
        notification: {
          title,
          body: description,
        },

        data: formattedMetadata,
        android: {
          priority: "high",
          notification: {
            sound: "default",
            channelId: "default",
          },
        },
        apns: {
          headers: {
            "apns-priority": "10",
          },
          payload: {
            aps: {
              sound: "default",
              badge: 1,
              contentAvailable: true,
            },
          },
        },
      };

      console.log(
        `📤 [NOTIFICATION] Sending notification to ${tokens.length} devices`,
        {
          title,
          tokens,
        },
      );
      const response = await this.admin
        .messaging()
        .sendEachForMulticast(payload);
      console.log(
        `✅ [NOTIFICATION] Notifications sent. Success: ${response.successCount}, Failed: ${response.failureCount}`,
        {
          title,
          description,
          successCount: response.successCount,
          failureCount: response.failureCount,
        },
      );

      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(
            `❌ [NOTIFICATION] Token ${tokens[idx]} failed with error:`,
            resp.error,
          );
        }
      });
      return response;
    } catch (error) {
      console.error("❌ [NOTIFICATION] Error sending push notification:", {
        title,
        description,
        error: error.message,
        stack: error.stack,
      });
    }
  }
}

module.exports = new FirebaseService();
