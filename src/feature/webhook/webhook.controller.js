const stripeService = require("../../core/services/stripe/stripe.service");
const env = require("../../../config/index");
const DriverModel = require("../driver/models/driver.model");
const DocumentsModel = require("../driver/models/documents.model");
const crypto = require("crypto");

const {
  handleStripeSubscriptionCreatedEvent,
  handleStripeSubscriptionUpdatedEvent,
  handleStripeSubscriptionDeletedEvent,
  handleStripeAccountUpdatedEvent,
  handleStripeExternalAccountEvents,
  handleStripeTransferCreatedEvent,
  handleStripeTransferReversedEvent,
  handleStripePayoutFailedOrCanceledEvent,
  handleStripePayoutPaidEvent,
  handleStripePaymentSuccessEvent,
  handleStripePaymentFailedEvent,
  handleStripeInvoicePaidEvent,
  handleStripeInvoiceCreatedEvent,
  handleStripeRefundFailedEvent,
  constantTimeHexEquals,
  parseJsonBody,
} = require("./webhook.service");
const { sendSms } = require("../../core/services/sms/sms.service");
const { sendEmail } = require("../../core/services/email/email.service");
const {
  buildDriverVerificationEmail,
} = require("../../core/services/email/driver-verification-email.helper");

const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  const SECRET =
    req.params.source === "connected"
      ? env.STRIPE.STRIPE_CONNECTED_WEBHOOK_KEY
      : env.STRIPE.STRIPE_WEBHOOK_KEY;

  try {
    event = stripeService.stripe.webhooks.constructEvent(req.body, sig, SECRET);
  } catch (err) {
    console.log(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // ================== Subscription events ==================
      case "customer.subscription.created": {
        const sub = event.data.object;
        await handleStripeSubscriptionCreatedEvent(sub);
        console.log("Processed subscription created webhook");
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object;
        await handleStripeSubscriptionUpdatedEvent(sub);
        console.log("Processed subscription updated webhook");
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await handleStripeSubscriptionDeletedEvent(sub);
        console.log("Processed subscription deleted webhook");
        break;
      }
      // ================== Stripe Transfer and Payouts ===========
      case "transfer.created": {
        const sub = event.data.object;
        await handleStripeTransferCreatedEvent(sub);
        console.log("Processed transfer created webhook");
        break;
      }

      case "transfer.reversed": {
        const sub = event.data.object;
        await handleStripeTransferReversedEvent(sub);
        console.log("Processed transfer reversal webhook");
        break;
      }

      case "payout.paid": {
        const sub = event.data.object;
        await handleStripePayoutPaidEvent(sub);
        console.log("Processed payout paid webhook");
        break;
      }

      case "payout.canceled":
      case "payout.failed": {
        const sub = event.data.object;
        await handleStripePayoutFailedOrCanceledEvent(sub);
        console.log("Processed payout failed/canceled webhook");
        break;
      }

      // ================== Stripe Payments =======================
      case "payment_intent.succeeded": {
        const sub = event.data.object;
        await handleStripePaymentSuccessEvent(sub);
        console.log("Processed payment intent succeeded webhook");
        break;
      }

      case "payment_intent.payment_failed": {
        const sub = event.data.object;
        await handleStripePaymentFailedEvent(sub);
        console.log("Processed payment intent failed webhook");
        break;
      }

      case "refund.failed": {
        const refund = event.data.object;
        await handleStripeRefundFailedEvent(refund);
        console.log("Processed refund failed webhook");
        break;
      }

      // ================== Stripe invoices (Subscriptions billing) ==========
      case "invoice.paid": {
        const invoice = event.data.object;
        await handleStripeInvoicePaidEvent(invoice);
        console.log("Processed invoice paid webhook");
        break;
      }

      case "invoice.created": {
        const invoice = event.data.object;
        await handleStripeInvoiceCreatedEvent(invoice);
        console.log("Processed invoice created webhook");
        break;
      }

      // ================== Stripe Connect events ==================
      case "account.updated": {
        const account = event.data.object;
        const driver = await DriverModel.findOne({
          stripeAccountId: account.id,
        });
        if (!driver) break;
        await handleStripeAccountUpdatedEvent(driver, account);
        break;
      }

      case "account.external_account.created":
      case "account.external_account.updated": {
        const externalAccount = event.data.object;
        const accountId = event.account;
        const driver = await DriverModel.findOne({
          stripeAccountId: accountId,
        });
        if (!driver) break;
        await handleStripeExternalAccountEvents(driver, externalAccount);
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.status(200).send("Stripe Webhook processed");
  } catch (err) {
    console.error("Error processing webhook:", err);
    res.status(500).send("Server Error");
  }
};

const veriffWebhook = async (req, res) => {
  try {
    const signatureHeader =
      req.headers["x-hmac-signature"] ||
      req.headers["vrf-hmac-signature"] ||
      req.headers["x-veriff-hmac-signature"];

    if (!signatureHeader) {
      return res.status(401).send("Unauthorized");
    }

    const sharedSecret = env.VERIFF.VERIFF_API_SECRET;
    if (!sharedSecret) {
      return res.status(500).send("Server Error");
    }

    const rawBody = req.body;
    const providedSignature = signatureHeader.trim().toLowerCase();

    const expectedSignature = crypto
      .createHmac("sha256", sharedSecret)
      .update(rawBody)
      .digest("hex")
      .toLowerCase();

    if (providedSignature !== expectedSignature) {
      return res.status(401).send("Unauthorized");
    }

    const payload = parseJsonBody(rawBody);
    const verification = payload?.verification || {};

    const sessionId = verification?.id;
    const status = verification?.status;
    const reason = verification?.reason || null;
    const attemptId = verification?.attemptId || null;
    const decisionTimeRaw = verification?.decisionTime || null;

    if (!sessionId || !status) {
      return res.status(400).send("Bad Request");
    }

    const newStatus =
      status === "approved"
        ? "approved"
        : status === "declined" || status === "resubmission_requested"
          ? "rejected"
          : null;

    if (!newStatus) {
      return res.status(200).send("OK");
    }

    const document = await DocumentsModel.findOne({
      veriffSessionId: sessionId,
      type: "driverLicense",
    })
      .sort({ createdAt: -1 })
      .populate("driver", "email");

    if (!document) {
      console.warn("[Veriff] Document not found for sessionId:", sessionId);
      return res.status(200).send("OK");
    }

    if (document.status === "approved") {
      return res.status(200).send("OK");
    }

    const incomingDecisionTime = decisionTimeRaw
      ? new Date(decisionTimeRaw)
      : null;

    if (
      incomingDecisionTime &&
      document.veriffLastSubmittedAt &&
      incomingDecisionTime < document.veriffLastSubmittedAt
    ) {
      return res.status(200).send("OK");
    }

    if (
      incomingDecisionTime &&
      document.veriffDecisionTime &&
      incomingDecisionTime <= document.veriffDecisionTime
    ) {
      return res.status(200).send("OK");
    }

    const rejectionReason = newStatus === "rejected" ? reason : null;
    const statusChanged = document.status !== newStatus;

    const updatedDoc = await DocumentsModel.findOneAndUpdate(
      {
        _id: document._id,
        status: { $ne: "approved" },
      },
      {
        $set: {
          status: newStatus,
          rejectionReason: rejectionReason,
          rejectReason: rejectionReason,
          veriffAttemptId: attemptId,
          veriffDecisionTime: incomingDecisionTime,
        },
      },
      { new: true },
    );

    if (updatedDoc && statusChanged) {
      const driver = await DriverModel.findById(document.driver._id)
        .select(
          "email driverLicense vehicleRegistration insurance vehicleDetails",
        )
        .populate([
          { path: "driverLicense", select: "status" },
          { path: "vehicleRegistration", select: "status" },
          { path: "insurance", select: "status" },
          { path: "vehicleDetails", select: "status" },
        ]);

      if (driver?.email) {
        const approvedCount = [
          driver.driverLicense,
          driver.vehicleRegistration,
          driver.insurance,
          driver.vehicleDetails,
        ].filter((record) => record?.status === "approved").length;
        const verificationEmail = buildDriverVerificationEmail({
          status: newStatus,
          reviewedItems: [
            {
              label: "Driver License",
              rejectReason: rejectionReason || "No reason was provided.",
            },
          ],
          approvedCount,
          frontendUrl: env.FRONTEND_URL,
        });

        await sendEmail(
          verificationEmail.subject,
          verificationEmail.message,
          driver.email,
        );
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("[Veriff] Webhook handling error:", err?.message || err);
    return res.status(500).send("Server Error");
  }
};

module.exports = { stripeWebhook, veriffWebhook };
