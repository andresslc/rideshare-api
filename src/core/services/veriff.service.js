const axios = require("axios");
const crypto = require("crypto");
const env = require("../../../config/index");

const getVeriffHmacSecret = () => env.VERIFF.VERIFF_API_SECRET || null;

const generateVeriffHmac = (data) => {
  const secret = getVeriffHmacSecret();
  if (!secret) {
    throw new Error(
      "Veriff HMAC secret is missing. Configure VERIFF_API_SECRET/VERIFF_WEBHOOK_SECRET in env.VERIFF.",
    );
  }

  const payload = Buffer.isBuffer(data)
    ? data
    : Buffer.from(String(data), "utf8");
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
};

const verifyVeriffWebhookSignature = (rawBody, signatureHeader) => {
  if (!rawBody || !signatureHeader) return false;

  const expected = generateVeriffHmac(rawBody);
  const provided = signatureHeader.trim().toLowerCase();

  // Both are expected to be hex strings.
  if (provided.length !== expected.length) return false;

  try {
    const providedBuf = Buffer.from(provided, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
};

const guessImageMimeTypeFromUrl = (imageUrl) => {
  const withoutQuery = (imageUrl || "").split("?")[0];
  const ext = withoutQuery.split(".").pop()?.toLowerCase();

  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  return "image/jpeg";
};

// VERIFF API
const createVeriffSession = async (user) => {
  try {
    const firstName =
      (user?.firstName && String(user.firstName).trim()) ||
      (user?.lastName && String(user.lastName).trim()) ||
      "Driver";
    const requestPayload = {
      verification: {
        person: { firstName },
        document: { type: "DRIVERS_LICENSE", country: "US" },
      },
    };

    const signature = generateVeriffHmac(JSON.stringify(requestPayload));

    const { data } = await axios.post(
      `${env.VERIFF.VERIFF_BASE_URL}/v1/sessions`,
      requestPayload,
      {
        headers: {
          "X-AUTH-CLIENT": env.VERIFF.VERIFF_API_KEY,
          "X-HMAC-SIGNATURE": signature,
          "Content-Type": "application/json",
        },
      },
    );

    const sessionId = data?.verification?.id || null;
    return sessionId;
  } catch (error) {
    console.error("Veriff API Error:", error.response?.data || error.message);
    return null;
  }
};

const uploadVeriffMedia = async (sessionId, imageUrl, imageType) => {
  try {
    const { data: imageBuffer } = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });

    const base64Image = Buffer.from(imageBuffer).toString("base64");
    const mimeType = guessImageMimeTypeFromUrl(imageUrl);
    const payload = {
      image: {
        context: imageType,
        content: `data:${mimeType};base64,${base64Image}`,
      },
    };

    const signature = generateVeriffHmac(JSON.stringify(payload));

    const { data } = await axios.post(
      `${env.VERIFF.VERIFF_BASE_URL}/v1/sessions/${sessionId}/media`,
      payload,
      {
        headers: {
          "X-AUTH-CLIENT": env.VERIFF.VERIFF_API_KEY,
          "X-HMAC-SIGNATURE": signature,
          "Content-Type": "application/json",
        },
      },
    );

    return data || null;
  } catch (error) {
    console.error(
      `Veriff Media Upload Error (${imageType}):`,
      error.response?.data || error.message,
    );
    return null;
  }
};

const submitVeriffSession = async (sessionId) => {
  try {
    const payload = { verification: { status: "submitted" } };
    const signature = generateVeriffHmac(JSON.stringify(payload));

    const { data } = await axios.patch(
      `${env.VERIFF.VERIFF_BASE_URL}/v1/sessions/${sessionId}`,
      payload,
      {
        headers: {
          "X-AUTH-CLIENT": env.VERIFF.VERIFF_API_KEY,
          "X-HMAC-SIGNATURE": signature,
          "Content-Type": "application/json",
        },
      },
    );

    return data || null;
  } catch (error) {
    console.error(
      `Veriff Session Submission Error:`,
      error.response?.data || error.message,
    );
    return null;
  }
};

const getSessionDecision = async (sessionId) => {
  try {
    const signature = generateVeriffHmac(sessionId);
    const response = await axios.get(
      `${env.VERIFF.VERIFF_BASE_URL}/v1/sessions/${sessionId}/decision`,
      {
        headers: {
          "X-AUTH-CLIENT": env.VERIFF.VERIFF_API_KEY,
          "X-HMAC-SIGNATURE": signature,
          "Content-Type": "application/json",
        },
      },
    );

    const sessionData = response.data;

    const { status, reason } = sessionData.verification || {};

    if (status === "approved") {
      console.log(`✅ Session ${sessionId} is approved.`);
    } else if (status === "declined") {
      console.log(`❌ Session ${sessionId} was declined. Reason: ${reason}`);
    } else {
      console.log(`Session ${sessionId} is still pending.`);
    }

    return sessionData;
  } catch (error) {
    console.error(
      "Error retrieving session decision:",
      error.response?.data || error.message,
    );
    return null;
  }
};

module.exports = {
  createVeriffSession,
  uploadVeriffMedia,
  submitVeriffSession,
  getSessionDecision,
  generateVeriffHmac,
  verifyVeriffWebhookSignature,
};
