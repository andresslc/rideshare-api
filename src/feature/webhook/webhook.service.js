const stripeService = require("../../core/services/stripe/stripe.service");
const BankModel = require("../bank/models/bank.model");
const DriverModel = require("../driver/models/driver.model");
const UserModel = require("../user/models/user.model");
const SubscriptionModel = require("../subscription/models/subscription.model");
const TransactionModel = require("../transactions/model/transaction.model");
const RideModel = require("../ride/model/ride.model");
const CarpoolBookingModel = require("../carpool/model/carpool-booking.model");
const {
  getCarpoolDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const { creditDriverForRide } = require("../ride/ride-settlement.helper");
const emitter = require("../../core/common/emitters");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { t, _resolveStripeError } = require("../../core/common/helpers");
const {
  handleMidTripRefundFailed,
} = require("../ride/ride-mid-trip-cancellation.service");

const getReferralEligibility = (driver) => {
  const total = Number(driver?.totalReferrals || 0);
  const redeemed = Number(driver?.referralFreeMonthsRedeemed || 0);
  return { total, redeemed, isEligible: total >= 5 && redeemed < 1 };
};

const handleStripeSubscriptionCreatedEvent = async (sub) => {
  const subscription = await SubscriptionModel.findOne({
    stripeSubscriptionId: sub.id,
  });

  if (subscription && subscription?.status != "incomplete") {
    console.log(
      `[handleStripeSubscriptionCreatedEvent] Subscription with Stripe ID ${sub.id} already exists, skipping creation.`,
    );
    return subscription;
  }

  const newSubscription = await SubscriptionModel.findOneAndUpdate(
    {
      driver: sub.metadata.driverId,
    },
    {
      driver: sub.metadata.driverId,
      stripeCustomerId: sub.customer,
      stripeSubscriptionId: sub.id,
      productId: sub.items.data[0].price.product,
      priceId: sub.items.data[0].price.id,
      amount: sub.items.data[0].price.unit_amount / 100,
      status: sub.status,
      currentPeriodStart: new Date(
        sub.items.data[0].current_period_start * 1000,
      ),
      currentPeriodEnd: new Date(sub.items.data[0].current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end || false,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    },
    {
      upsert: true,
      new: true,
    },
  );

  await DriverModel.findOneAndUpdate(
    { _id: sub.metadata.driverId },
    { subscription: newSubscription.id },
  );

  const driver = await DriverModel.findById(sub.metadata.driverId).select(
    "locale",
  );
  sendNotificationToSpecificUser({
    title: t(
      "NOTIFICATION_SUBSCRIPTION_PURCHASED_TITLE",
      driver?.locale || "en",
    ),
    description: t(
      "NOTIFICATION_SUBSCRIPTION_PURCHASED_DESC",
      driver?.locale || "en",
    ),
    userIds: [sub.metadata.driverId],
    role: "user",
    metadata: {
      type: "PAYMENT",
    },
  });

  return newSubscription;
};

const handleStripeSubscriptionUpdatedEvent = async (sub) => {
  const updatedSubscription = await SubscriptionModel.findOneAndUpdate(
    { stripeSubscriptionId: sub.id },
    {
      status: sub.status,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      currentPeriodStart: new Date(
        sub.items.data[0].current_period_start * 1000,
      ),
      currentPeriodEnd: new Date(sub.items.data[0].current_period_end * 1000),
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    },
    { new: true },
  );

  return updatedSubscription;
};

const handleStripeSubscriptionDeletedEvent = async (sub) => {
  const deletedSubscription = await SubscriptionModel.findOneAndUpdate(
    { stripeSubscriptionId: sub.id },
    {
      status: "canceled",
      canceledAt: sub.ended_at ? new Date(sub.ended_at * 1000) : new Date(),
    },
    { new: true },
  );

  if (deletedSubscription) {
    const driver = await DriverModel.findById(
      deletedSubscription.driver,
    ).select("locale");
    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_SUBSCRIPTION_EXPIRED_TITLE",
        driver?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_SUBSCRIPTION_EXPIRED_DESC",
        driver?.locale || "en",
      ),
      userIds: [deletedSubscription.driver],
      role: "user",
      metadata: {
        type: "PAYMENT",
      },
    });
  }

  return deletedSubscription;
};

const handleStripeInvoicePaidEvent = async (invoice) => {
  console.log("Paid hit");
  if (invoice?.billing_reason !== "subscription_create") return;

  const subscriptionId = invoice?.parent?.subscription_details?.subscription;
  if (!subscriptionId) {
    console.log(
      `[handleStripeInvoicePaidEvent] No subscription ID found in invoice ${invoice.id}`,
    );
    return;
  }

  console.log(
    `[handleStripeInvoicePaidEvent] Processing invoice ${invoice.id} for subscription ${subscriptionId}`,
  );

  const driverId =
    invoice?.parent?.subscription_details?.metadata?.driverId ||
    invoice?.lines?.data?.[0]?.metadata?.driverId;

  if (!driverId) {
    console.log(
      `[handleStripeInvoicePaidEvent] No driverId found in invoice metadata for ${invoice.id}`,
    );
    return;
  }

  // Retry subscription lookup to handle webhook ordering race condition
  let subscription = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    subscription = await SubscriptionModel.findOne({
      stripeSubscriptionId: subscriptionId,
    });
    if (subscription) break;
    console.log(
      `[handleStripeInvoicePaidEvent] Subscription not found (attempt ${attempt}/5), retrying in 1s...`,
    );
    await new Promise((res) => setTimeout(res, 1000));
  }

  // If subscription still not found, fall back to processing referral via driverId only
  if (!subscription) {
    console.log(
      `[handleStripeInvoicePaidEvent] Subscription not found after retries, processing referral via driverId only`,
    );

    const driver =
      await DriverModel.findById(driverId).select("_id referredBy");
    if (!driver?.referredBy) {
      console.log(
        `[handleStripeInvoicePaidEvent] Driver ${driverId} has no referrer`,
      );
      return;
    }

    console.log(
      `[handleStripeInvoicePaidEvent] Incrementing referral count for driver ${driver.referredBy}`,
    );
    const updatedReferrer = await DriverModel.findByIdAndUpdate(
      driver.referredBy,
      { $inc: { totalReferrals: 1 } },
      { new: true },
    );

    if (updatedReferrer.totalReferrals === 5) {
      sendNotificationToSpecificUser({
        title: t(
          "NOTIFICATION_REFERRAL_5_MILESTONE_TITLE",
          updatedReferrer.locale || "en",
        ),
        description: t(
          "NOTIFICATION_REFERRAL_5_MILESTONE_DESC",
          updatedReferrer.locale || "en",
        ),
        userIds: [updatedReferrer._id],
        metadata: {
          type: "PAYMENT",
        },
      });
    }

    console.log(
      `[handleStripeInvoicePaidEvent] Referral processed (fallback) for driver ${driverId}`,
    );
    return;
  }

  const paidAt =
    invoice.status_transitions?.paid_at != null
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : new Date();

  if (!subscription.paidAt) subscription.paidAt = paidAt;

  const existingTransaction = await TransactionModel.findOne({
    identifierKey: invoice.id,
    purpose: "subscription_charged",
  });

  if (!existingTransaction) {
    await TransactionModel.create({
      amount: (invoice.amount_paid || 0) / 100,
      type: "debit",
      user: driverId,
      userType: "Driver",

      identifierKey: invoice.id,

      status: "success",

      purpose: "subscription_charged",

      stripeIds: {
        paymentIntent: invoice.payment_intent,
      },

      metadata: {
        invoiceId: invoice.id,
        subscriptionId,
      },
    });

    console.log(
      `[handleStripeInvoicePaidEvent] Transaction created for invoice ${invoice.id}`,
    );
  }

  if (subscription.referralProcessedAt) {
    console.log(
      `[handleStripeInvoicePaidEvent] Referral already processed for subscription ${subscription._id}`,
    );
    await subscription.save();
    return;
  }

  const driver = await DriverModel.findById(subscription.driver).select(
    "_id referredBy",
  );
  if (!driver?.referredBy) {
    console.log(
      `[handleStripeInvoicePaidEvent] Driver ${subscription.driver} has no referrer`,
    );
    subscription.referralProcessedAt = new Date();
    await subscription.save();
    return;
  }

  console.log(
    `[handleStripeInvoicePaidEvent] Incrementing referral count for driver ${driver.referredBy}`,
  );
  const updatedReferrer = await DriverModel.findByIdAndUpdate(
    driver.referredBy,
    { $inc: { totalReferrals: 1 } },
    { new: true },
  );

  if (updatedReferrer.totalReferrals === 5) {
    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_REFERRAL_5_MILESTONE_TITLE",
        updatedReferrer.locale || "en",
      ),
      description: t(
        "NOTIFICATION_REFERRAL_5_MILESTONE_DESC",
        updatedReferrer.locale || "en",
      ),
      userIds: [updatedReferrer._id],
      role: "user",
      metadata: {
        type: "PAYMENT",
      },
    });
  }

  subscription.referralProcessedAt = new Date();
  await subscription.save();
  console.log(
    `[handleStripeInvoicePaidEvent] Referral processed successfully for subscription ${subscription._id}`,
  );
};

const handleStripeInvoiceCreatedEvent = async (invoice) => {
  console.log("Created hit");
  if (invoice?.billing_reason !== "subscription_cycle") {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Skipping invoice ${invoice.id} - billing reason: ${invoice?.billing_reason}`,
    );
    return;
  }

  const subscriptionId = invoice?.parent?.subscription_details?.subscription;
  if (!subscriptionId) {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Skipping invoice ${invoice.id} - no subscription`,
    );
    return;
  }

  console.log(
    `[handleStripeInvoiceCreatedEvent] Processing invoice ${invoice.id} for subscription ${subscriptionId}`,
  );

  const subscription = await SubscriptionModel.findOne({
    stripeSubscriptionId: subscriptionId,
  });
  if (!subscription) {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Subscription not found for ${subscriptionId}`,
    );
    return;
  }

  const driver = await DriverModel.findById(subscription.driver).select(
    "_id totalReferrals referralFreeMonthsRedeemed referralLastVoidedInvoiceId",
  );
  if (!driver) {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Driver not found for subscription ${subscription._id}`,
    );
    return;
  }

  if (driver.referralLastVoidedInvoiceId === invoice.id) {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Invoice ${invoice.id} already voided`,
    );
    return;
  }

  const eligibility = getReferralEligibility(driver);
  console.log(
    `[handleStripeInvoiceCreatedEvent] Driver ${driver._id} eligibility:`,
    eligibility,
  );
  if (!eligibility.isEligible) {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Driver ${driver._id} not eligible for free month`,
    );
    return;
  }

  if (!["draft", "open"].includes(invoice.status)) {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Invoice ${invoice.id} status ${invoice.status} cannot be voided`,
    );
    return;
  }

  console.log(
    `[handleStripeInvoiceCreatedEvent] Voiding invoice ${invoice.id} for driver ${driver._id}`,
  );

  if (invoice.status === "draft") {
    console.log(
      `[handleStripeInvoiceCreatedEvent] Finalizing draft invoice ${invoice.id} before voiding`,
    );
    await stripeService.finalizeInvoice(invoice.id);
  }

  await stripeService.voidInvoice(invoice.id);

  await DriverModel.findByIdAndUpdate(driver._id, {
    $inc: { referralFreeMonthsRedeemed: 1 },
    $set: { referralLastVoidedInvoiceId: invoice.id },
  });

  console.log(
    `[handleStripeInvoiceCreatedEvent] Invoice ${invoice.id} voided successfully`,
  );
};

const handleStripeAccountUpdatedEvent = async (driver, account) => {
  const updates = {};
  if (account.capabilities) {
    if (account.capabilities.transfers)
      updates["stripeConnectCapabilities.transfers"] =
        account.capabilities.transfers;
  }

  if (!driver.isStripeConnectOnboardingCompleted) {
    updates.isStripeConnectOnboardingCompleted = true;
  }

  updates["stripeConnectCapabilities.payout"] = account.payouts_enabled
    ? "active"
    : "inactive";

  if (Object.keys(updates).length > 0) {
    await DriverModel.findByIdAndUpdate(driver._id, updates, {
      new: true,
    });
  }
};

const handleStripeExternalAccountEvents = async (driver, externalAccount) => {
  const bank = await BankModel.findOneAndUpdate(
    { bankId: externalAccount.id },
    {
      driver: driver._id,
      bankId: externalAccount.id,
      bankTitle: externalAccount.bank_name || "Stripe Bank",
      accountHolderName: externalAccount.account_holder_name || "Unknown",
      accountNumber: externalAccount.last4,
      routingNumber: externalAccount.routing_number,
      status: externalAccount.status,
    },
    { upsert: true, new: true },
  );

  if (!driver.bank) {
    driver.bank = bank._id;
    await driver.save();

    bank.selected = true;
    await bank.save();
  }
};

const handleStripeTransferCreatedEvent = async (event) => {
  const metadata = event.metadata;

  try {
    const bank = await BankModel.findOne({
      _id: metadata.bankId,
    });

    if (!bank) {
      const transaction = await TransactionModel.findOneAndUpdate(
        {
          identifierKey: metadata.identifierKey,
          status: "initiated",
        },
        {
          status: "failed",
          errorMessage: "Bank account not found.",
        },
        {
          new: true,
        },
      );

      if (transaction) {
        await DriverModel.findByIdAndUpdate(transaction.user, {
          $inc: {
            pendingWithdrawalBalance: -transaction.amount,
            pendingRewardedWithdrawalBalance: -(
              transaction.rewardedAmount || 0
            ),
          },
        });
      }

      return transaction;
    }

    const transaction = await TransactionModel.findOneAndUpdate(
      {
        identifierKey: metadata.identifierKey,
        status: "initiated",
      },
      {
        status: "processing",
      },
      {
        new: true,
      },
    );

    if (!transaction) return;

    await stripeService.createPayout(
      event.amount,
      event.currency,
      event.destination,
      bank.bankId,
      {
        transferId: event.id,
        identifierKey: metadata.identifierKey,
      },
    );
  } catch (err) {
    console.log(err);
    const transaction = await TransactionModel.findOneAndUpdate(
      {
        identifierKey: metadata.identifierKey,
        status: { $in: ["initiated", "processing"] },
      },
      {
        status: "failed",
        errorMessage: err.message || "Stripe transfer creation failed",
      },
      { new: true },
    );

    if (transaction) {
      await DriverModel.findByIdAndUpdate(transaction.user, {
        $inc: {
          pendingWithdrawalBalance: -transaction.amount,
          pendingRewardedWithdrawalBalance: -(transaction.rewardedAmount || 0),
        },
      });
    }
  }
};

const handleStripeTransferReversedEvent = async (event) => {
  const metadata = event.metadata || {};

  try {
    const transaction = await TransactionModel.findOneAndUpdate(
      {
        identifierKey: metadata.identifierKey,
        status: { $in: ["initiated", "processing", "success"] },
      },
      {
        status: "failed",
        errorMessage: event.reversal_details?.reason || "unknown",
        $set: {
          "metadata.transferReversal": event.reversal_details || {},
        },
      },
      {
        new: true,
      },
    );

    // Release reserved funds, or refund them if the payout had already completed.
    if (transaction) {
      const withdrawalUpdate = transaction?.stripeIds?.payout
        ? {
            balance: transaction.amount - (transaction.rewardedAmount || 0),
            rewardedBalance: transaction.rewardedAmount || 0,
          }
        : {
            pendingWithdrawalBalance: -transaction.amount,
            pendingRewardedWithdrawalBalance: -(
              transaction.rewardedAmount || 0
            ),
          };

      await DriverModel.findByIdAndUpdate(transaction.user, {
        $inc: withdrawalUpdate,
      });
    }
  } catch (err) {
    await TransactionModel.findOneAndUpdate(
      { identifierKey: metadata.identifierKey },
      {
        status: "failed",
        errorMessage: err.message || "Stripe transfer reversal handling failed",
      },
      { new: true },
    );
  }
};

const handleStripePayoutPaidEvent = async (event) => {
  const metadata = event.metadata;

  try {
    const transaction = await TransactionModel.findOne({
      identifierKey: metadata.identifierKey,
      status: { $ne: "failed" },
    });

    if (!transaction || transaction?.stripeIds?.payout) return;

    // On payout success: deduct the real balance AND release the reservation simultaneously.
    const driver = await DriverModel.findByIdAndUpdate(
      transaction.user,
      {
        $inc: {
          balance: -(transaction.amount - (transaction.rewardedAmount || 0)),
          rewardedBalance: -(transaction.rewardedAmount || 0),
          pendingWithdrawalBalance: -transaction.amount,
          pendingRewardedWithdrawalBalance: -(transaction.rewardedAmount || 0),
        },
      },
      { new: true },
    );

    /* Update transaction */
    transaction.status = "success";
    transaction.stripeIds.payout = event.id;
    transaction.metadata = {
      ...transaction.metadata,
      payout: event,
    };

    await transaction.save();

    sendNotificationToSpecificUser({
      title: t("PAYOUT_COMPLETED", driver.locale),
      description: t("PAYOUT_COMPLETED_DESC", driver.locale),
      userIds: [transaction.user],
      role: "user",
      metadata: {
        type: "PAYMENT",
      },
    });
  } catch (err) {
    await TransactionModel.findOneAndUpdate(
      { identifierKey: metadata.identifierKey },
      {
        status: "failed",
        errorMessage: err.message || "Stripe payout processing failed",
      },
      { new: true },
    );

    const driver = await DriverModel.findById(transaction.user).select(
      "locale",
    );
    sendNotificationToSpecificUser({
      title: t("PAYOUT_FAILED", driver.locale),
      description: t("PAYOUT_FAILED_DESC", driver.locale),
      userIds: [transaction.user],
      role: "user",
      metadata: {
        type: "PAYMENT",
      },
    });
  }
};

const handleStripePayoutFailedOrCanceledEvent = async (event) => {
  const metadata = event.metadata || {};

  try {
    const transaction = await TransactionModel.findOne({
      identifierKey: metadata.identifierKey,
      status: { $ne: "failed" },
    });

    if (!transaction) return;

    // Release the reservation only when the payout has not already completed.
    const balanceUpdate = { $inc: {} };

    // A paid payout already released its reservation, so only refund balances.
    // A payout that never completed still needs its reservation released.
    if (transaction?.stripeIds?.payout) {
      balanceUpdate.$inc.balance =
        transaction.amount - (transaction.rewardedAmount || 0);
      balanceUpdate.$inc.rewardedBalance = transaction.rewardedAmount || 0;
    } else {
      balanceUpdate.$inc.pendingWithdrawalBalance = -transaction.amount;
      balanceUpdate.$inc.pendingRewardedWithdrawalBalance = -(
        transaction.rewardedAmount || 0
      );
    }

    await DriverModel.findByIdAndUpdate(transaction.user, balanceUpdate);

    /* Update transaction */
    transaction.status = "failed";
    transaction.errorMessage =
      event.failure_message || "Payout failed or canceled";

    transaction.metadata = {
      ...transaction.metadata,
      payout: event,
    };

    transaction.stripeIds.payout = event.id;
    await transaction.save();

    const driver = await DriverModel.findById(transaction.user).select(
      "locale",
    );
    sendNotificationToSpecificUser({
      title: t("PAYMENT_FAILED", driver.locale),
      description: t("PAYMENT_FAILED_DESC", driver.locale),
      userIds: [transaction.user],
      role: "user",
      metadata: {
        type: "PAYMENT",
      },
    });
  } catch (err) {
    await TransactionModel.findOneAndUpdate(
      { identifierKey: metadata.identifierKey },
      {
        status: "failed",
        errorMessage: err.message || "Stripe payout failure handling failed",
      },
      { new: true },
    );
  }
};

const handleStripePaymentSuccessEvent = async (event) => {
  const metadata = event.metadata;

  try {
    const transaction = await TransactionModel.findOne({
      identifierKey: metadata.identifierKey,
    });

    if (!transaction || transaction?.stripeIds?.paymentIntent) return;
    const user = await UserModel.findById(transaction.user).select("locale");

    /* ── Ride payment ───────────────────────────────────── */
    if (metadata.rideId) {
      const ride = await RideModel.findByIdAndUpdate(
        metadata.rideId,
        { paymentStatus: "completed" },
        { new: true },
      );

      // Same payout path as the wallet and free-ride branches, so a change to
      // how drivers are paid only has to be made once.
      await creditDriverForRide({
        ride,
        paymentMethod: "attached_card",
        amountChargedToRider: transaction.amount,
        identifierKey: transaction.identifierKey,
        stripeIds: { paymentIntent: event.id },
      });

      emitter.emit("ride:payment:success", {
        rideId: ride._id,
        transactionId: transaction._id,
        paymentIntentId: event.id,
      });
    }

    /* ── Carpool booking payment ────────────────────────── */
    if (metadata.bookingId) {
      const booking = await CarpoolBookingModel.findById(
        metadata.bookingId,
      ).select("originalFare discountAmount fareCharged");
      const driverAmount = booking
        ? getCarpoolDriverFare(booking)
        : transaction.amount;
      const discountAmount = booking?.discountAmount || 0;

      emitter.emit("carpool:payment:success", {
        bookingId: metadata.bookingId,
        driverId: metadata.driverId,
        amount: transaction.amount,
        driverAmount,
        discountAmount,
        transactionId: transaction._id,
        paymentIntentId: event.id,
      });
    }

    /* ── Wallet top-up ──────────────────────────────────── */
    if (!metadata.rideId && !metadata.bookingId) {
      await UserModel.findByIdAndUpdate(
        transaction.user,
        { $inc: { balance: transaction.amount } },
        { new: true },
      );

      await sendNotificationToSpecificUser({
        title: t("WALLET_TOP_UP", user.locale),
        description: t("WALLET_TOP_UP_DESC", user.locale),
        userIds: [transaction.user],
        role: "user",
        metadata: {
          type: "PAYMENT",
        },
      });
    }

    transaction.status = "success";
    transaction.stripeIds = transaction.stripeIds || {};
    transaction.stripeIds.paymentIntent = event.id;
    transaction.metadata = {
      ...transaction.metadata,
      paymentIntent: event,
    };
    await transaction.save();
  } catch (err) {
    const transaction = await TransactionModel.findOneAndUpdate(
      {
        identifierKey: metadata?.identifierKey,
        userType: "User",
        type: "Debit",
      },
      {
        status: "failed",
        errorMessage: err.message || "Stripe payment processing failed",
      },
      { new: true },
    );

    if (transaction?.user) {
      const user = await UserModel.findById(transaction.user).select("locale");
      await sendNotificationToSpecificUser({
        title: t("PAYMENT_FAILED", user?.locale || "en"),
        description: t("PAYMENT_FAILED_DESC", user?.locale || "en"),
        userIds: [transaction.user],
        role: "user",
        metadata: {
          type: "PAYMENT",
        },
      });
    }
  }
};

const handleStripePaymentFailedEvent = async (event) => {
  const metadata = event.metadata;

  try {
    const transaction = await TransactionModel.findOne({
      identifierKey: metadata.identifierKey,
      userType: "User",
      type: "Debit",
    });
    if (!transaction || transaction?.stripeIds?.paymentIntent) return;

    /* ── Ride payment failed ────────────────────────────── */
    if (metadata.rideId) {
      emitter.emit("ride:payment:failed", {
        rideId: metadata.rideId,
        transactionId: transaction._id,
        paymentIntentId: event.id,
        message:
          "Could not process payment. Ride has been cancelled. Please try again.",
      });
    }

    /* ── Carpool booking payment failed ─────────────────── */
    if (metadata.bookingId) {
      emitter.emit("carpool:payment:failed", {
        bookingId: metadata.bookingId,
        reason: _resolveStripeError(event.last_payment_error || event),
        transactionId: transaction._id,
        paymentIntentId: event.id,
      });
    }

    transaction.status = "failed";
    transaction.stripeIds = transaction.stripeIds || {};
    transaction.stripeIds.paymentIntent = event.id;
    transaction.metadata = {
      ...transaction.metadata,
      paymentIntent: event,
    };
    await transaction.save();
  } catch (err) {
    await TransactionModel.findOneAndUpdate(
      {
        identifierKey: metadata.identifierKey,
        userType: "User",
        type: "Debit",
      },
      {
        status: "failed",
        errorMessage: err.message || "Stripe payment failure handling failed",
      },
      { new: true },
    );
  }
};

/**
 * A refund Stripe accepted was later bounced by the card issuer. For a
 * mid-trip refund the ride is marked so support can see the rider was not
 * paid back.
 */
const handleStripeRefundFailedEvent = async (refund) => {
  const metadata = refund.metadata || {};

  if (metadata.reason === "mid_trip_cancellation") {
    await handleMidTripRefundFailed(refund);
  }
};

///////// VERIFF
const constantTimeHexEquals = (aHex, bHex) => {
  if (!aHex || !bHex) return false;

  const a = aHex.trim().toLowerCase();
  const b = bHex.trim().toLowerCase();

  if (a.length !== b.length) return false;

  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
};

const parseJsonBody = (body) => {
  if (Buffer.isBuffer(body)) {
    return JSON.parse(body.toString("utf8"));
  }
  return body;
};

module.exports = {
  handleStripePayoutFailedOrCanceledEvent,
  handleStripeRefundFailedEvent,
  handleStripeSubscriptionCreatedEvent,
  handleStripeSubscriptionUpdatedEvent,
  handleStripeSubscriptionDeletedEvent,
  handleStripeExternalAccountEvents,
  handleStripeTransferReversedEvent,
  handleStripeTransferCreatedEvent,
  handleStripePaymentSuccessEvent,
  handleStripeAccountUpdatedEvent,
  handleStripePaymentFailedEvent,
  handleStripePayoutPaidEvent,
  handleStripeInvoicePaidEvent,
  handleStripeInvoiceCreatedEvent,
  constantTimeHexEquals,
  parseJsonBody,
};
