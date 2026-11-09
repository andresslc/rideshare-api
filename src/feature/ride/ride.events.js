const emitter = require("../../core/common/emitters");
const {
  RIDE_STATUS,
  RIDE,
} = require("../../core/common/constants/ride-constants");
const {
  RIDE_SOCKET_EVENTS,
} = require("../../core/common/constants/ride-constants");
const {
  updateRideStatusService,
  chargeCancellationFee,
  cancelRideService,
  getRideWithRelations,
} = require("./ride.service");
const { t, parseRide } = require("../../core/common/helpers");
const DriverModel = require("../driver/models/driver.model");
const UserModel = require("../user/models/user.model");
const RideModel = require("./model/ride.model");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { applyCode } = require("../promo-code/promo-code-campaign.service");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const {
  enqueueJourneyEventWithDriverLocation: recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.producer");

module.exports = function initRidePaymentListeners(io) {
  emitter.on(
    "ride:payment:success",
    async ({ rideId, transactionId, paymentIntentId }) => {
      const paymentRide = await RideModel.findById(rideId);

      // The charge may already have been settled inline, in which case the ride
      // is running — or, on a short trip, already finished. Driving it back to
      // "in-progress" would throw INVALID_RIDE_STATUS_TRANSITION inside this
      // listener, where nothing catches it.
      if (
        [
          RIDE_STATUS.IN_PROGRESS,
          RIDE_STATUS.COMPLETED,
          RIDE_STATUS.CANCELLED,
        ].includes(paymentRide?.rideStatus)
      ) {
        console.log(
          `[ride:payment:success] ride ${rideId} is already ${paymentRide.rideStatus}; nothing left for the webhook to do`,
        );
        return;
      }

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "ride",
          journeyId: rideId,
          rideId,
          eventType: "ride.payment_succeeded",
          phase: "waiting_pickup",
          actor: { type: "stripe", id: null },
          source: "webhook",
          amount: {
            value: paymentRide?.rideFare,
            currency: "USD",
          },
          references: { transactionId, paymentIntentId },
          dedupeKey: `ride:${rideId}:payment_succeeded:card`,
          metadata: { paymentMethod: "attached_card" },
        },
        paymentRide?.driver,
      );

      const ride = await updateRideStatusService(
        rideId,
        RIDE_STATUS.IN_PROGRESS,
        "completed",
        {
          actorType: "stripe",
          source: "webhook",
        },
      );
      io.to(`${RIDE}:${ride._id}`).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
        rideId: ride._id,
        type: RIDE_STATUS.IN_PROGRESS,
        ride: parseRide(await getRideWithRelations(ride._id)),
        driverFare: getRideDriverFare(ride),
      });

      const locale = await DriverModel.findById(ride.driver).select("locale");
      const passengerLocale = await UserModel.findById(ride.user).select(
        "locale",
      );

      sendNotificationToSpecificUser({
        title: t(
          "NOTIFICATION_VERIFICATION_SUCCESS_TITLE",
          locale?.locale || "en",
        ),
        description: t(
          "NOTIFICATION_VERIFICATION_SUCCESS_DESC",
          locale?.locale || "en",
        ).replace("{{amount}}", getRideDriverFare(ride).toFixed(2)),
        userIds: [ride.driver],
        metadata: {
          type: "RIDE_STARTED",
          driverFare: getRideDriverFare(ride),
        },
        role: "user",
      });

      sendNotificationToSpecificUser({
        title: t("RIDE_STARTED", passengerLocale?.locale || "en"),
        description: t("RIDE_STARTED_DES", passengerLocale?.locale || "en"),
        userIds: [ride.user],
        metadata: {
          type: "RIDE_STARTED",
        },
        role: "user",
      });

      if (ride.codeId && ride.campaignId && ride.discountAmount > 0) {
        const applied = await applyCode({
          promoCode: ride.codeId,
          campaign: ride.campaignId,
          user: ride.user,
          appliedTo: ride._id,
          appliedToType: "Ride",
          discountApplied: ride.discountAmount,
        });
        console.log("🚀 ~ initRidePaymentListeners ~ applied:", applied);
        if (!applied) {
          console.error("[ride:payment] Redemption record failed", {
            rideId: ride._id,
          });
        }
      }
    },
  );

  emitter.on(
    "ride:payment:failed",
    async ({ rideId, message, transactionId, paymentIntentId }) => {
      const paymentRide = await RideModel.findById(rideId);
      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "ride",
          journeyId: rideId,
          rideId,
          eventType: "ride.payment_failed",
          phase: "waiting_pickup",
          actor: { type: "stripe", id: null },
          source: "webhook",
          amount: {
            value: paymentRide?.rideFare,
            currency: "USD",
          },
          references: { transactionId, paymentIntentId },
          reasonCode: "PAYMENT_FAILED",
          dedupeKey: `ride:${rideId}:payment_failed:card`,
          metadata: { paymentMethod: "attached_card" },
        },
        paymentRide?.driver,
      );

      const ride = await updateRideStatusService(
        rideId,
        RIDE_STATUS.CANCELLED,
        "failed",
        {
          actorType: "stripe",
          source: "webhook",
          reasonCode: "PAYMENT_FAILED",
        },
      );

      await Promise.all([
        chargeCancellationFee(rideId, ride.user),
        cancelRideService(rideId, "user", "Payment failed"),
      ]);

      const locale = await DriverModel.findById(ride.driver).select("locale");
      const passengerLocale = await UserModel.findById(ride.user).select(
        "locale",
      );

      sendNotificationToSpecificUser({
        title: t("RIDE_CANCELLED_PAYMENT_FAILED", locale?.locale || "en"),
        description: t(
          "RIDE_CANCELLED_PAYMENT_FAILED_DESC",
          locale?.locale || "en",
        ),
        userIds: [ride.driver],
        metadata: {
          type: "RIDE_CANCELLED",
        },
        role: "user",
      });

      sendNotificationToSpecificUser({
        title: t(
          "RIDE_CANCELLED_PAYMENT_FAILED",
          passengerLocale?.locale || "en",
        ),
        description: t(
          "RIDE_CANCELLED_PAYMENT_FAILED_DESC",
          passengerLocale?.locale || "en",
        ),
        userIds: [ride.user],
        metadata: {
          type: "RIDE_CANCELLED",
        },
        role: "user",
      });

      io.to(`${RIDE}:${ride._id}`).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
        rideId: ride._id,
        type: RIDE_STATUS.CANCELLED,
        ride: parseRide(await getRideWithRelations(ride._id)),
        message,
        driverFare: getRideDriverFare(ride),
      });
    },
  );
};
