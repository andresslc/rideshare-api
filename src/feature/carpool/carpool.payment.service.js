const mongoose = require("mongoose");
const {
  enqueueJourneyEventWithDriverLocation: recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.producer");
const CarpoolBookingModel = require("./model/carpool-booking.model");
const CarpoolRouteModel = require("./model/carpool-route.model");
const TransactionModel = require("../transactions/model/transaction.model");
const {
  carpoolPickupPaymentKey,
} = require("../transactions/payment-attempt.helper");
const {
  getWalletAllocation,
  transactionRewardFields,
} = require("../wallet/wallet.service");
const {
  getCarpoolDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const CardModel = require("../card/models/card.model");
const StripeService = require("../../core/services/stripe/stripe.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  CANCELLATION_FEE,
} = require("../../core/common/constants/ride-constants");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  CARPOOL_BOOKING_STATUS_ENUM,
  CARPOOL_STATUS_ENUM,
  CARPOOL_SOCKET_EVENTS,
} = require("../../core/common/constants/carpool-constants");
const { _resolveStripeError, t } = require("../../core/common/helpers");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");

const redis = getRedisConnection();

/* ─────────────────────────────────────────────────────────────
   CANCELLATION FEE (passenger cancels accepted booking)
   Mirrors ride.service.js chargeCancellationFee but for booking.
───────────────────────────────────────────────────────────── */
async function chargeCarpoolCancellationFee(bookingId, passengerId) {
  const booking = await CarpoolBookingModel.findById(bookingId)
    .select("fareCharged driver passenger carpool status")
    .lean();

  if (!booking) {
    throw new Error("BOOKING_NOT_FOUND");
  }

  if (booking.passenger.toString() !== passengerId.toString()) {
    throw new Error("UNAUTHORIZED_PASSENGER");
  }

  if (!booking.fareCharged || booking.fareCharged <= 0) {
    throw new Error("INVALID_BOOKING_FARE");
  }

  const cancellationFee = parseFloat(
    (Number(booking.fareCharged) * CANCELLATION_FEE).toFixed(2),
  );

  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const passenger = await UserModel.findById(passengerId).session(session);
      if (!passenger) {
        throw new Error("PASSENGER_NOT_FOUND");
      }

      const walletAllocation = getWalletAllocation(passenger, cancellationFee, {
        allowNegativeBalance: true,
      });

      const createdTransactions = await TransactionModel.create(
        [
          {
            user: new mongoose.Types.ObjectId(passengerId),
            userType: "User",
            amount: cancellationFee,
            type: "Debit",
            status: "success",
            ...transactionRewardFields(walletAllocation),
            metadata: {
              bookingId: booking._id,
              carpoolId: booking.carpool,
              paymentMethod: "wallet",
              kind: "carpool_cancellation_fee",
            },
          },
          {
            user: new mongoose.Types.ObjectId(booking.driver),
            userType: "Driver",
            amount: cancellationFee,
            type: "Credit",
            status: "success",
            metadata: {
              bookingId: booking._id,
              carpoolId: booking.carpool,
              paymentMethod: "wallet",
              kind: "carpool_cancellation_fee",
            },
          },
        ],
        { session, ordered: true },
      );

      await UserModel.findByIdAndUpdate(
        passengerId,
        {
          $inc: {
            balance: -walletAllocation.regularAmount,
            rewardedBalance: -walletAllocation.rewardedAmount,
          },
        },
        { session },
      );

      await DriverModel.findByIdAndUpdate(
        booking.driver,
        { $inc: { balance: cancellationFee } },
        { session },
      );

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "carpool",
          journeyId: booking.carpool,
          carpoolId: booking.carpool,
          bookingId: booking._id,
          eventType: "carpool.cancellation_fee_succeeded",
          phase: "ended",
          actor: { type: "user", id: passengerId },
          source: "service",
          references: { transactionId: createdTransactions[0]._id },
          amount: { value: cancellationFee, currency: "USD" },
          dedupeKey: `carpool:${booking.carpool}:booking:${booking._id}:cancellation_fee_succeeded`,
          metadata: { paymentMethod: "wallet" },
        },
        booking.driver,
        { session },
      );
    });

    const passenger = await UserModel.findById(passengerId).select("locale");

    sendNotificationToSpecificUser({
      title: t(
        "NOTIFICATION_CANCELLATION_FEE_CHARGED_TITLE",
        passenger?.locale || "en",
      ),
      description: t(
        "NOTIFICATION_CANCELLATION_FEE_CHARGED_DESC",
        passenger?.locale || "en",
      ),
      userIds: [passengerId],
      role: "user",
    });

    return { success: true, bookingId, cancellationFee };
  } finally {
    await session.endSession();
  }
}

/* ─────────────────────────────────────────────────────────────
   MAIN CHARGE ENTRY POINT
   Called inside pickPassengerService after OTP is verified.
───────────────────────────────────────────────────────────── */
async function chargeCarpoolPassenger(booking) {
  const passenger = booking.passenger; // must be populated
  const fare = booking.fareCharged;
  const driverId = booking.driver.toString();

  if (booking.paymentMethod === "wallet") {
    return await _handleCarpoolWalletPayment({
      passenger,
      fare,
      booking,
      driverId,
    });
  }

  if (booking.paymentMethod === "attached_card") {
    return await _handleCarpoolCardPayment({
      passenger,
      fare,
      booking,
      driverId,
    });
  }

  throw new Error("UNSUPPORTED_PAYMENT_METHOD");
}

/* ─────────────────────────────────────────────────────────────
   WALLET PAYMENT
───────────────────────────────────────────────────────────── */
async function _handleCarpoolWalletPayment({
  passenger,
  fare,
  booking,
  driverId,
}) {
  /* Re-check balance at charge time */
  if (!getWalletAllocation(passenger, fare)) {
    return { cancelled: true, reason: "insufficient_wallet_balance" };
  }

  const driverAmount = getCarpoolDriverFare(booking);

  const discountAmount =
    booking.discountAmount > 0
      ? booking.discountAmount
      : driverAmount > fare
        ? driverAmount - fare
        : 0;

  const session = await mongoose.startSession();

  try {
    const result = await session.withTransaction(async () => {
      const currentBooking = await CarpoolBookingModel.findById(
        booking._id,
      ).session(session);

      if (currentBooking?.paymentStatus === "completed") {
        return {
          success: true,
          paymentMethod: "wallet",
          alreadyProcessed: true,
        };
      }

      const currentPassenger = await UserModel.findById(passenger._id).session(
        session,
      );
      const walletAllocation = currentPassenger
        ? getWalletAllocation(currentPassenger, fare)
        : null;

      if (!walletAllocation) {
        return { cancelled: true, reason: "insufficient_wallet_balance" };
      }

      /* Deduct from passenger */
      await UserModel.findByIdAndUpdate(
        passenger._id,
        {
          $inc: {
            balance: -walletAllocation.regularAmount,
            rewardedBalance: -walletAllocation.rewardedAmount,
          },
        },
        { session },
      );

      /* Credit driver with original full fare */
      await DriverModel.findByIdAndUpdate(
        driverId,
        { $inc: { balance: driverAmount } },
        { session },
      );

      /* Create Debit + Credit + Platform transactions */
      const transactions = [
        {
          user: passenger._id,
          userType: "User",
          amount: fare,
          type: "Debit",
          status: "success",
          ...transactionRewardFields(walletAllocation),
          metadata: {
            bookingId: booking._id,
            paymentMethod: "wallet",
          },
        },
        {
          user: driverId,
          userType: "Driver",
          amount: driverAmount,
          type: "Credit",
          status: "success",
          metadata: {
            bookingId: booking._id,
            paymentMethod: "wallet",
          },
        },
      ];

      if (discountAmount > 0) {
        transactions.push({
          userType: "Platform",
          amount: discountAmount,
          type: "Debit",
          status: "success",
          metadata: {
            bookingId: booking._id,
            reason: "promo_discount_absorbed",
            paymentMethod: "wallet",
          },
        });
      }

      const createdTransactions = await TransactionModel.create(transactions, {
        session,
        ordered: true,
      });

      const paymentCompletedAt = new Date();
      await CarpoolBookingModel.findByIdAndUpdate(
        booking._id,
        {
          $set: {
            otpVerified: true,
            otpVerifiedAt: booking.otpVerifiedAt || paymentCompletedAt,
            paymentStatus: "completed",
            paymentCompletedAt,
            rideStartedAt: paymentCompletedAt,
          },
          $unset: { otp: 1 },
        },
        { session },
      );

      const carpoolId = booking.carpool?._id || booking.carpool;
      return {
        success: true,
        paymentMethod: "wallet",
        journeyEvent: {
          data: {
            journeyType: "carpool",
            journeyId: carpoolId,
            carpoolId,
            bookingId: booking._id,
            eventType: "carpool.payment_succeeded",
            phase: "waiting_pickup",
            actor: { type: "user", id: passenger._id },
            source: "service",
            references: { transactionId: createdTransactions[0]._id },
            amount: { value: fare, currency: "USD" },
            dedupeKey: `carpool:${carpoolId}:booking:${booking._id}:payment_succeeded`,
            metadata: { paymentMethod: "wallet" },
          },
          driverId,
        },
      };
    });

    if (result?.journeyEvent) {
      await recordJourneyEventWithDriverLocation(
        result.journeyEvent.data,
        result.journeyEvent.driverId,
      );
      delete result.journeyEvent;
    }

    return result;
  } finally {
    session.endSession();
  }
}

/* ─────────────────────────────────────────────────────────────
   CARD PAYMENT
───────────────────────────────────────────────────────────── */
async function _handleCarpoolCardPayment({
  passenger,
  fare,
  booking,
  driverId,
}) {
  console.log(`[CARD_PAYMENT] Starting payment for booking ${booking._id}`);

  const card = await CardModel.findOne({
    user: passenger._id,
    status: "active",
    default: true,
  });
  if (!card) {
    console.error(
      `[CARD_PAYMENT] No active card found for user ${passenger._id}`,
    );
    throw new Error("CARPOOL_CARD_NOT_FOUND");
  }

  const identifierKey = carpoolPickupPaymentKey(booking._id);
  const amountInCents = Math.round(fare * 100);
  console.log(
    `[CARD_PAYMENT] Amount: ${fare} USD (${amountInCents} cents), identifierKey: ${identifierKey}`,
  );

  /* Create initiated transaction — will be updated by webhook */
  const transaction = await TransactionModel.findOneAndUpdate(
    {
      identifierKey,
      user: passenger._id,
      userType: "User",
      type: "Debit",
    },
    {
      $setOnInsert: {
        amount: fare,
        type: "Debit",
        user: passenger._id,
        userType: "User",
        card: card._id,
        status: "initiated",
        identifierKey,
        metadata: {
          bookingId: booking._id.toString(),
          driverId,
          paymentMethod: "attached_card",
        },
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  console.log(`[CARD_PAYMENT] Transaction created: ${transaction._id}`);

  const carpoolId = booking.carpool?._id || booking.carpool;
  await recordJourneyEventWithDriverLocation(
    {
      journeyType: "carpool",
      journeyId: carpoolId,
      carpoolId,
      bookingId: booking._id,
      eventType: "carpool.payment_initiated",
      phase: "waiting_pickup",
      actor: { type: "user", id: passenger._id },
      source: "service",
      references: { transactionId: transaction._id },
      amount: { value: fare, currency: "USD" },
      dedupeKey: `carpool:${carpoolId}:booking:${booking._id}:payment_initiated:${transaction._id}`,
      metadata: { paymentMethod: "attached_card" },
    },
    driverId,
  );

  let paymentIntent;
  try {
    paymentIntent = await StripeService.createPaymentIntent({
      amount: amountInCents,
      currency: "usd",
      customerId: passenger.stripeCustomerId,
      paymentMethodId: card.paymentMethodId,
      metadata: {
        identifierKey,
        pmId: card.paymentMethodId,
        bookingId: booking._id.toString(),
        driverId,
      },
      idempotencyKey: identifierKey,
    });
    console.log(
      `[CARD_PAYMENT] Payment intent created: ${paymentIntent.id}, status: ${paymentIntent.status}`,
    );
  } catch (stripeError) {
    console.error(
      `[CARD_PAYMENT] Stripe error: ${stripeError.message}, code: ${stripeError.code}`,
    );

    await TransactionModel.findByIdAndUpdate(transaction._id, {
      status: "failed",
      errorMessage: stripeError.message,
    });

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolId,
        carpoolId,
        bookingId: booking._id,
        eventType: "carpool.payment_failed",
        phase: "waiting_pickup",
        actor: { type: "stripe", id: null },
        source: "service",
        references: { transactionId: transaction._id },
        amount: { value: fare, currency: "USD" },
        reasonCode: _resolveStripeError(stripeError),
        dedupeKey: `carpool:${carpoolId}:booking:${booking._id}:payment_failed`,
        metadata: { paymentMethod: "attached_card" },
      },
      driverId,
    );

    return {
      cancelled: true,
      reason: _resolveStripeError(stripeError),
      stripeMessage: stripeError.message,
    };
  }

  const requiresAction = paymentIntent.status === "requires_action";
  console.log(`[CARD_PAYMENT] Payment requires action: ${requiresAction}`);

  if (requiresAction) {
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "carpool",
        journeyId: carpoolId,
        carpoolId,
        bookingId: booking._id,
        eventType: "carpool.payment_action_required",
        phase: "waiting_pickup",
        actor: { type: "stripe", id: null },
        source: "service",
        references: {
          transactionId: transaction._id,
          paymentIntentId: paymentIntent.id,
        },
        amount: { value: fare, currency: "USD" },
        dedupeKey: `carpool:${carpoolId}:booking:${booking._id}:payment_action_required:${paymentIntent.id}`,
      },
      driverId,
    );
  }

  return {
    requiresAction,
    clientSecret: requiresAction ? paymentIntent.client_secret : null,
    paymentIntentId: paymentIntent.id,
  };
}

module.exports = {
  chargeCarpoolPassenger,
  chargeCarpoolCancellationFee,
};
