const { default: mongoose } = require("mongoose");
const RideModel = require("./model/ride.model");
const TransactionModel = require("../transactions/model/transaction.model");
const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const JourneyLocationModel = require("../journey-log/model/journey-location.model");
const StripeService = require("../../core/services/stripe/stripe.service");
const {
  getLatestDriverLocation,
  recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.service");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { t } = require("../../core/common/helpers");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const { RIDE_STATUS } = require("../../core/common/constants/ride-constants");
const {
  traceLengthInMiles,
  getDeliveredShare,
  splitMidTripSettlement,
} = require("./mid-trip-cancellation.helper");

// A settlement stuck in "processing" this long is taken to have crashed and may
// be claimed again. The quote is frozen, so the retry moves the same amounts.
const STALE_CLAIM_MS = 5 * 60 * 1000;
// The retry sweep gives up after this many attempts; a person takes it from there.
const MAX_SETTLEMENT_ATTEMPTS = 5;

const refundKey = (rideId) => `ride:${rideId}:mid_trip_refund`;
const clawbackKey = (rideId) => `ride:${rideId}:mid_trip_clawback`;

/**
 * What was actually collected at Start Ride, read from the ledger rather than
 * the ride: the card path records the authoritative amount on the transaction,
 * and a promo leaves a platform debit behind.
 */
async function loadStartSettlement(ride) {
  const rideFilter = { "metadata.rideId": ride._id, status: "success" };

  const [riderDebit, driverCredit, platformDebit] = await Promise.all([
    TransactionModel.findOne({
      ...rideFilter,
      user: ride.user,
      userType: "User",
      type: "Debit",
      "metadata.reason": { $exists: false },
    })
      .sort({ createdAt: 1 })
      .lean(),
    TransactionModel.findOne({
      ...rideFilter,
      user: ride.driver,
      userType: "Driver",
      type: "Credit",
      "metadata.reason": { $exists: false },
    })
      .sort({ createdAt: 1 })
      .lean(),
    TransactionModel.findOne({
      ...rideFilter,
      userType: "Platform",
      type: "Debit",
      "metadata.reason": "promo_discount_absorbed",
    }).lean(),
  ]);

  return {
    riderDebit,
    riderPaid: riderDebit?.amount ?? 0,
    riderRewardedPaid: riderDebit?.rewardedAmount ?? 0,
    driverPaid: driverCredit?.amount ?? getRideDriverFare(ride),
    platformAbsorbed: platformDebit?.amount ?? 0,
  };
}

/**
 * Pickup, every on-trip GPS sample, then where the driver is right now.
 */
async function loadTripTrace(ride) {
  const samples = await JourneyLocationModel.find({
    journeyType: "ride",
    journeyId: ride._id,
    phase: "on_trip",
  })
    .sort({ observedAt: 1 })
    .select("location.coordinates")
    .lean();

  const latest = await getLatestDriverLocation(ride.driver).catch(() => null);

  return [
    ride.pickupPoint?.location?.coordinates,
    ...samples.map((sample) => sample.location?.coordinates),
    latest?.coordinates,
  ].filter(Boolean);
}

async function buildQuote(ride) {
  const [trace, collected] = await Promise.all([
    loadTripTrace(ride),
    loadStartSettlement(ride),
  ]);

  const travelledMiles = traceLengthInMiles(trace);
  const endedAt = ride.cancelledAt || new Date();
  const elapsedMs = Math.max(
    new Date(endedAt).getTime() - new Date(ride.startedAt).getTime(),
    0,
  );

  const { distanceShare, timeShare, share } = getDeliveredShare({
    travelledMiles,
    quotedMiles: ride.rideDistance,
    elapsedMs,
    quotedMinutes: ride.averageTime,
  });

  const split = splitMidTripSettlement({
    share,
    riderPaid: collected.riderPaid,
    riderRewardedPaid: collected.riderRewardedPaid,
    driverPaid: collected.driverPaid,
    platformAbsorbed: collected.platformAbsorbed,
  });

  return {
    riderDebit: collected.riderDebit,
    quote: {
      ...split,
      travelledMiles: Number(travelledMiles.toFixed(2)),
      elapsedMinutes: Number((elapsedMs / 60000).toFixed(1)),
      distanceShare,
      timeShare,
    },
  };
}

/**
 * Take the settlement for this ride, or learn that someone else has it.
 * Returns the ride as claimed, or null when there is nothing to do.
 */
async function claimSettlement(rideId, quoteFields) {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  return RideModel.findOneAndUpdate(
    {
      _id: rideId,
      $or: [
        { "midTripCancellation.status": null },
        { "midTripCancellation.status": "failed" },
        {
          "midTripCancellation.status": "processing",
          "midTripCancellation.claimedAt": { $lt: staleBefore },
        },
      ],
    },
    [
      {
        $set: {
          midTripCancellation: {
            // A retry keeps the numbers it was first given.
            $cond: [
              { $isNumber: "$midTripCancellation.share" },
              {
                $mergeObjects: [
                  "$midTripCancellation",
                  {
                    status: "processing",
                    claimedAt: "$$NOW",
                    errorMessage: null,
                    attempts: {
                      $add: [
                        { $ifNull: ["$midTripCancellation.attempts", 0] },
                        1,
                      ],
                    },
                  },
                ],
              },
              {
                $mergeObjects: [
                  { $literal: quoteFields },
                  {
                    status: "processing",
                    claimedAt: "$$NOW",
                    errorMessage: null,
                    attempts: {
                      $add: [
                        { $ifNull: ["$midTripCancellation.attempts", 0] },
                        1,
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ],
    { new: true },
  ).lean();
}

async function refundCard({ ride, riderDebit, quote }) {
  if (quote.riderRefund <= 0) return null;

  const paymentIntentId = riderDebit?.stripeIds?.paymentIntent;
  if (!paymentIntentId) throw new Error("PAYMENT_INTENT_NOT_FOUND");

  const refund = await StripeService.refundPayment(
    paymentIntentId,
    Math.round(quote.riderRefund * 100),
    {
      idempotencyKey: refundKey(ride._id),
      metadata: {
        rideId: ride._id.toString(),
        reason: "mid_trip_cancellation",
      },
    },
  );

  return { refundId: refund.id, paymentIntentId };
}

async function writeLedger({ ride, quote, paymentMethod, stripeRefund }) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const current = await RideModel.findById(ride._id)
        .select("midTripCancellation.status")
        .session(session)
        .lean();
      if (current?.midTripCancellation?.status === "completed") return;

      const metadata = {
        rideId: ride._id,
        paymentMethod,
        reason: "mid_trip_cancellation",
        share: quote.share,
      };

      if (quote.riderRefund > 0) {
        await TransactionModel.create(
          [
            {
              user: ride.user,
              userType: "User",
              amount: quote.riderRefund,
              type: "Credit",
              status: "success",
              identifierKey: refundKey(ride._id),
              rewardedAmount: quote.riderRewardedRefund,
              isRewarded: quote.riderRewardedRefund > 0,
              balanceSource:
                quote.riderRewardedRefund <= 0
                  ? "regular"
                  : quote.riderRegularRefund <= 0
                    ? "rewarded"
                    : "mixed",
              ...(stripeRefund
                ? { stripeIds: { paymentIntent: stripeRefund.paymentIntentId } }
                : {}),
              metadata: {
                ...metadata,
                ...(stripeRefund
                  ? { stripeRefundId: stripeRefund.refundId }
                  : {}),
              },
            },
          ],
          { session, ordered: true },
        );

        // A card refund goes back to the card. Only wallet money returns here.
        if (paymentMethod === "wallet") {
          await UserModel.findByIdAndUpdate(
            ride.user,
            {
              $inc: {
                balance: quote.riderRegularRefund,
                rewardedBalance: quote.riderRewardedRefund,
              },
            },
            { session },
          );
        }
      }

      if (quote.driverClawback > 0 && ride.driver) {
        // The balance may go negative if the driver was already paid out; the
        // next ride settles it.
        await DriverModel.findByIdAndUpdate(
          ride.driver,
          { $inc: { balance: -quote.driverClawback } },
          { session },
        );

        await TransactionModel.create(
          [
            {
              user: ride.driver,
              userType: "Driver",
              amount: quote.driverClawback,
              type: "Debit",
              status: "success",
              identifierKey: clawbackKey(ride._id),
              metadata,
            },
          ],
          { session, ordered: true },
        );
      }

      if (quote.platformReversal > 0) {
        await TransactionModel.create(
          [
            {
              userType: "Platform",
              amount: quote.platformReversal,
              type: "Credit",
              status: "success",
              metadata: {
                ...metadata,
                reason: "promo_discount_absorbed_reversed",
              },
            },
          ],
          { session, ordered: true },
        );
      }

      await RideModel.findByIdAndUpdate(
        ride._id,
        {
          $set: {
            "midTripCancellation.status": "completed",
            "midTripCancellation.stripeRefundId":
              stripeRefund?.refundId || null,
            "midTripCancellation.settledAt": new Date(),
            "midTripCancellation.errorMessage": null,
          },
        },
        { session },
      );

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "ride",
          journeyId: ride._id,
          rideId: ride._id,
          eventType: "ride.mid_trip_cancellation_settled",
          phase: "ended",
          actor: { type: "system", id: null },
          source: "service",
          amount: { value: quote.riderRefund, currency: "USD" },
          references: {
            paymentIntentId: stripeRefund?.paymentIntentId || null,
          },
          dedupeKey: `ride:${ride._id}:mid_trip_cancellation_settled`,
          metadata: {
            paymentMethod,
            cancelledBy: ride.cancelledBy,
            share: quote.share,
            distanceShare: quote.distanceShare,
            timeShare: quote.timeShare,
            travelledMiles: quote.travelledMiles,
            riderCharged: quote.riderCharged,
            riderRefund: quote.riderRefund,
            driverKept: quote.driverKept,
            driverClawback: quote.driverClawback,
            platformReversal: quote.platformReversal,
            stripeRefundId: stripeRefund?.refundId || null,
          },
        },
        ride.driver,
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
}

async function notifyParties(ride, quote) {
  const [rider, driver] = await Promise.all([
    UserModel.findById(ride.user).select("locale").lean(),
    ride.driver
      ? DriverModel.findById(ride.driver).select("locale").lean()
      : null,
  ]);

  const riderLocale = rider?.locale || "en";
  const driverLocale = driver?.locale || "en";
  const money = (value) => `$${Number(value).toFixed(2)}`;

  const notifications = [
    sendNotificationToSpecificUser({
      title: t("NOTIFICATION_MID_TRIP_REFUND_TITLE", riderLocale),
      description: t("NOTIFICATION_MID_TRIP_REFUND_DESC", riderLocale)
        .replace("${charged}", money(quote.riderCharged))
        .replace("${refund}", money(quote.riderRefund)),
      userIds: [ride.user],
      metadata: { type: "RIDE_MID_TRIP_SETTLED", rideId: ride._id },
      role: "user",
    }),
  ];

  if (ride.driver) {
    notifications.push(
      sendNotificationToSpecificUser({
        title: t("NOTIFICATION_MID_TRIP_EARNINGS_TITLE", driverLocale),
        description: t(
          "NOTIFICATION_MID_TRIP_EARNINGS_DESC",
          driverLocale,
        ).replace("${earned}", money(quote.driverKept)),
        userIds: [ride.driver],
        metadata: { type: "RIDE_MID_TRIP_SETTLED", rideId: ride._id },
        role: "driver",
      }),
    );
  }

  const results = await Promise.allSettled(notifications);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        `Failed to send mid-trip settlement notification for ride ${ride._id}:`,
        result.reason,
      );
    }
  }
}

/**
 * Settle a ride that was cancelled after Start Ride.
 *
 * Runs after the ride is already "cancelled", so a completion racing the
 * cancellation can never be refunded: only the transition that won gets here.
 * Safe to call again: a completed settlement is returned as is, a failed or
 * crashed one is retried with its frozen quote, and the Stripe refund and the
 * ledger writes are keyed so neither can happen twice.
 *
 * Returns the settlement summary, or null when the ride had not started or had
 * collected nothing.
 */
async function settleMidTripCancellation(rideId) {
  const ride = await RideModel.findById(rideId).lean();
  if (!ride) return null;

  if (
    ride.rideStatus !== RIDE_STATUS.CANCELLED ||
    !ride.startedAt ||
    ride.paymentStatus !== "completed"
  ) {
    return null;
  }

  if (ride.midTripCancellation?.status === "completed") {
    return ride.midTripCancellation;
  }

  const { riderDebit, quote: freshQuote } = await buildQuote(ride);
  const paymentMethod = freshQuote.riderPaid > 0 ? ride.paymentMethod : "free";

  const claimed = await claimSettlement(ride._id, {
    ...freshQuote,
    cancelledBy: ride.cancelledBy || null,
    paymentMethod,
  });

  if (!claimed) {
    // Another call holds it, or already finished it.
    const latest = await RideModel.findById(ride._id)
      .select("midTripCancellation")
      .lean();
    return latest?.midTripCancellation || null;
  }

  const quote = claimed.midTripCancellation;

  try {
    const stripeRefund =
      quote.paymentMethod === "attached_card"
        ? await refundCard({ ride, riderDebit, quote })
        : null;

    await writeLedger({
      ride: claimed,
      quote,
      paymentMethod: quote.paymentMethod,
      stripeRefund,
    });
  } catch (error) {
    await RideModel.findByIdAndUpdate(ride._id, {
      $set: {
        "midTripCancellation.status": "failed",
        "midTripCancellation.errorMessage": error.message,
      },
    });

    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType: "ride.mid_trip_cancellation_failed",
        phase: "ended",
        actor: { type: "system", id: null },
        source: "service",
        amount: { value: quote.riderRefund, currency: "USD" },
        reasonCode: error.code || error.message,
        dedupeKey: `ride:${ride._id}:mid_trip_cancellation_failed:${Date.now()}`,
        metadata: { paymentMethod: quote.paymentMethod },
      },
      ride.driver,
    ).catch(() => {});

    throw error;
  }

  const settled = await RideModel.findById(ride._id)
    .select("midTripCancellation")
    .lean();

  await notifyParties(ride, settled.midTripCancellation);

  return settled.midTripCancellation;
}

/**
 * Pick up settlements that failed or crashed and try them again. Runs from the
 * ride cron. Each ride is retried with its frozen quote, so nothing is
 * refunded twice however many times this runs.
 */
async function retryPendingMidTripSettlements({ limit = 20 } = {}) {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);

  const rides = await RideModel.find({
    rideStatus: RIDE_STATUS.CANCELLED,
    "midTripCancellation.attempts": { $lt: MAX_SETTLEMENT_ATTEMPTS },
    $or: [
      { "midTripCancellation.status": "failed" },
      {
        "midTripCancellation.status": "processing",
        "midTripCancellation.claimedAt": { $lt: staleBefore },
      },
    ],
  })
    .select("_id")
    .limit(limit)
    .lean();

  // A settlement that crashed on its last allowed attempt is never picked up
  // above. Close it as failed so it shows up as needing manual action.
  const abandoned = await RideModel.find({
    rideStatus: RIDE_STATUS.CANCELLED,
    "midTripCancellation.status": "processing",
    "midTripCancellation.claimedAt": { $lt: staleBefore },
    "midTripCancellation.attempts": { $gte: MAX_SETTLEMENT_ATTEMPTS },
  })
    .limit(limit)
    .lean();

  for (const ride of abandoned) {
    await RideModel.findOneAndUpdate(
      { _id: ride._id, "midTripCancellation.status": "processing" },
      {
        $set: {
          "midTripCancellation.status": "failed",
          "midTripCancellation.errorMessage": "SETTLEMENT_ABANDONED",
        },
      },
      { new: true },
    ).lean();
  }

  for (const { _id } of rides) {
    try {
      await settleMidTripCancellation(_id);
    } catch (error) {
      console.error(
        `Retry of mid-trip settlement failed for ride ${_id}:`,
        error.message,
      );
    }
  }

  return rides.length;
}

/**
 * Stripe accepted a mid-trip refund and the card issuer later bounced it
 * (closed card, lost card...). The money is back in our Stripe balance and the
 * rider has nothing. This is not retried: the same card would bounce again.
 * The ride is marked "refund_failed" and the payments channel is told, so a
 * person can return the money another way.
 */
async function handleMidTripRefundFailed(refund) {
  const rideId = refund?.metadata?.rideId;
  if (!rideId || !mongoose.isValidObjectId(rideId)) return null;

  const failureReason = refund.failure_reason || "unknown";

  const ride = await RideModel.findOneAndUpdate(
    { _id: rideId, "midTripCancellation.stripeRefundId": refund.id },
    {
      $set: {
        "midTripCancellation.status": "refund_failed",
        "midTripCancellation.errorMessage": `STRIPE_REFUND_FAILED:${failureReason}`,
      },
    },
    { new: true },
  ).lean();

  await TransactionModel.findOneAndUpdate(
    { identifierKey: refundKey(rideId), userType: "User", type: "Credit" },
    {
      $set: {
        status: "failed",
        errorMessage: `Stripe refund failed: ${failureReason}`,
      },
    },
  );

  if (ride) {
    await recordJourneyEventWithDriverLocation(
      {
        journeyType: "ride",
        journeyId: ride._id,
        rideId: ride._id,
        eventType: "ride.mid_trip_refund_failed",
        phase: "ended",
        actor: { type: "stripe", id: null },
        source: "webhook",
        amount: { value: refund.amount / 100, currency: "USD" },
        references: { paymentIntentId: refund.payment_intent || null },
        reasonCode: failureReason,
        dedupeKey: `ride:${ride._id}:mid_trip_refund_failed:${refund.id}`,
        metadata: { stripeRefundId: refund.id },
      },
      ride.driver,
    ).catch(() => {});
  }

  return ride;
}

module.exports = {
  MAX_SETTLEMENT_ATTEMPTS,
  handleMidTripRefundFailed,
  retryPendingMidTripSettlements,
  settleMidTripCancellation,
};
