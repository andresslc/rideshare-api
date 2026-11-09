const emitter = require("../../core/common/emitters");
const {
  CARPOOL_SOCKET_EVENTS,
  CARPOOL_BOOKING_STATUS_ENUM,
  CARPOOL_STATUS_ENUM,
} = require("../../core/common/constants/carpool-constants");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const { t } = require("../../core/common/helpers");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const CarpoolBookingModel = require("./model/carpool-booking.model");
const CarpoolRouteModel = require("./model/carpool-route.model");
const TransactionModel = require("../transactions/model/transaction.model");
const DriverModel = require("../driver/models/driver.model");
const UserModel = require("../user/models/user.model");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { applyCode } = require("../promo-code/promo-code-campaign.service");
const {
  getCarpoolDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const {
  enqueueJourneyEventWithDriverLocation: recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.producer");
const { handleAssignmentEnded } = require("../driver/driver-shift.service");
const redis = getRedisConnection();

module.exports = function initCarpoolPaymentListeners(io) {
  /* ─────────────────────────────────────────────────────────
     CARD PAYMENT SUCCESS (3DS confirmed via Stripe webhook)
     • Credit driver
     • Mark booking otpVerified + paymentStatus completed
     • Emit PASSENGER_PICKED_UP to carpool room
  ───────────────────────────────────────────────────────── */
  emitter.on(
    "carpool:payment:success",
    async ({
      bookingId,
      driverId,
      amount,
      driverAmount,
      discountAmount,
      transactionId,
      paymentIntentId,
    }) => {
      try {
        const booking =
          await CarpoolBookingModel.findById(bookingId).populate("carpool");
        if (!booking) {
          console.error(
            "carpool:payment:success — booking not found:",
            bookingId,
          );
          return;
        }

        const creditAmount = driverAmount || amount;
        const discount = discountAmount ?? booking.discountAmount ?? 0;

        /* Credit driver */
        await DriverModel.findByIdAndUpdate(driverId, {
          $inc: { balance: creditAmount },
        });

        /* Driver Credit transaction */
        await TransactionModel.create({
          user: driverId,
          userType: "Driver",
          amount: creditAmount,
          type: "Credit",
          status: "success",
          metadata: {
            bookingId,
            paymentMethod: "attached_card",
          },
        });

        /* Platform absorbed discount */
        if (discount > 0) {
          await TransactionModel.create({
            userType: "Platform",
            amount: discount,
            type: "Debit",
            status: "success",
            metadata: {
              bookingId,
              reason: "promo_discount_absorbed",
              paymentMethod: "attached_card",
            },
          });
        }

        /* Mark picked up */
        booking.otpVerified = true;
        booking.paymentStatus = "completed";
        booking.paymentCompletedAt = new Date();
        booking.rideStartedAt = booking.paymentCompletedAt;
        await booking.save();

        await recordJourneyEventWithDriverLocation(
          {
            journeyType: "carpool",
            journeyId: booking.carpool._id,
            carpoolId: booking.carpool._id,
            bookingId: booking._id,
            eventType: "carpool.payment_succeeded",
            phase: "waiting_pickup",
            actor: { type: "stripe", id: null },
            source: "webhook",
            occurredAt: booking.paymentCompletedAt,
            amount: { value: booking.fareCharged, currency: "USD" },
            references: { transactionId, paymentIntentId },
            dedupeKey: `carpool:${booking.carpool._id}:booking:${booking._id}:payment_succeeded`,
            metadata: { paymentMethod: "attached_card" },
          },
          driverId,
        );

        await recordJourneyEventWithDriverLocation(
          {
            journeyType: "carpool",
            journeyId: booking.carpool._id,
            carpoolId: booking.carpool._id,
            bookingId: booking._id,
            eventType: "carpool.passenger_picked_up",
            phase: "on_trip",
            actor: { type: "driver", id: driverId },
            source: "webhook",
            occurredAt: booking.rideStartedAt,
            references: { routeStopId: booking.pickupStop?._id },
            dedupeKey: `carpool:${booking.carpool._id}:booking:${booking._id}:picked_up`,
          },
          driverId,
        );

        if (
          booking.codeId &&
          booking.campaignId &&
          booking.discountAmount > 0
        ) {
          const applied = await applyCode({
            promoCode: booking.codeId,
            campaign: booking.campaignId,
            user: booking.passenger._id,
            appliedTo: booking._id,
            appliedToType: "CarpoolBooking",
            discountApplied: booking.discountAmount,
          });
          if (!applied) {
            console.error("[carpool:payment] Redemption record failed", {
              bookingId: booking._id,
            });
          }
        }

        io.to(`carpool:${booking.carpool._id.toString()}`).emit(
          CARPOOL_SOCKET_EVENTS.PASSENGER_PICKED_UP,
          {
            bookingId,
            carpoolId: booking.carpool._id,
            passengerId: booking.passenger.toString(),
            pickedUpAt: booking.rideStartedAt,
            otpVerified: booking.otpVerified,
            driverFare: getCarpoolDriverFare(booking),
          },
        );
      } catch (err) {
        console.error("carpool:payment:success handler error:", err.message);
      }
    },
  );

  /* ─────────────────────────────────────────────────────────
     CARD PAYMENT FAILED (3DS failed or card declined)
     • Cancel the booking and remove it from the active route roster
     • NO seat increment — seat is gone
     • End the carpool when that was the last active passenger
     • Emit booking and route updates to the carpool room
  ───────────────────────────────────────────────────────── */
  const handleCarpoolPaymentFailed = async ({
    bookingId,
    reason = "PAYMENT_FAILED",
    transactionId,
    paymentIntentId,
  }) => {
    console.log(
      "\n============================================================",
    );
    console.log("🚨 [CARPOOL PAYMENT FAILED] Event received");
    console.log("============================================================");
    console.log("📌 bookingId:", bookingId);
    console.log("⏰ timestamp:", new Date().toISOString());

    try {
      console.log("🔍 [1] Fetching booking with populated carpool...");

      const booking =
        await CarpoolBookingModel.findById(bookingId).populate("carpool");

      if (!booking) {
        console.error(
          "❌ [1] carpool:payment:failed — booking not found:",
          bookingId,
        );
        return;
      }

      console.log("✅ [1] Booking found");
      console.log("📋 Booking details:", {
        bookingId: booking._id?.toString(),
        passenger: booking.passenger?.toString(),
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        carpoolId: booking.carpool?._id?.toString(),
      });

      const carpoolRoute = booking.carpool;

      if (!carpoolRoute) {
        console.error(
          "❌ [1] Booking does not have a populated carpool:",
          bookingId,
        );
        return;
      }

      console.log("🚗 [1] Carpool route found");
      console.log("📋 Carpool route details:", {
        carpoolId: carpoolRoute._id?.toString(),
        driver: carpoolRoute.driver?.toString(),
        status: carpoolRoute.status,
        passengerCount: carpoolRoute.passengers?.length || 0,
      });

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("🔄 [2] Cancelling booking due to payment failure");
      console.log(
        "------------------------------------------------------------",
      );

      console.log("📋 Booking status BEFORE:", {
        status: booking.status,
        paymentStatus: booking.paymentStatus,
      });

      /* Cancel booking only */
      booking.status = CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;
      booking.paymentStatus = "failed";
      booking.cancelledAt = new Date();

      console.log("📋 Booking status AFTER modification:", {
        status: booking.status,
        paymentStatus: booking.paymentStatus,
      });

      await booking.save();

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "carpool",
          journeyId: carpoolRoute._id,
          carpoolId: carpoolRoute._id,
          bookingId: booking._id,
          eventType: "carpool.payment_failed",
          phase: "waiting_pickup",
          actor: { type: "stripe", id: null },
          source: "webhook",
          occurredAt: booking.cancelledAt,
          amount: { value: booking.fareCharged, currency: "USD" },
          references: { transactionId, paymentIntentId },
          reasonCode: reason,
          dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:payment_failed`,
          metadata: { paymentMethod: "attached_card" },
        },
        carpoolRoute.driver,
      );

      await recordJourneyEventWithDriverLocation(
        {
          journeyType: "carpool",
          journeyId: carpoolRoute._id,
          carpoolId: carpoolRoute._id,
          bookingId: booking._id,
          eventType: "carpool.booking_cancelled",
          phase: "ended",
          actor: { type: "stripe", id: null },
          source: "webhook",
          transition: {
            from: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
            to: CARPOOL_BOOKING_STATUS_ENUM.CANCELLED,
          },
          occurredAt: booking.cancelledAt,
          reasonCode: reason,
          dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:cancelled`,
        },
        carpoolRoute.driver,
      );

      console.log("✅ [2] Booking saved successfully");
      console.log("📌 Saved bookingId:", booking._id?.toString());

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("👤 [3] Marking passenger as cancelled in carpool roster");
      console.log(
        "------------------------------------------------------------",
      );

      console.log("📊 Passenger roster BEFORE:", {
        totalPassengers: carpoolRoute.passengers?.length || 0,
        passengers: carpoolRoute.passengers?.map((p) => ({
          bookingId: p.bookingId?.toString(),
          status: p.status,
          passengerId: p.passengerId?.toString?.(),
        })),
      });

      const passengerIndex = carpoolRoute.passengers.findIndex(
        (p) => p.bookingId?.toString() === bookingId.toString(),
      );

      console.log("🔎 Passenger index search result:", {
        passengerIndex,
        bookingId: bookingId?.toString(),
      });

      if (passengerIndex !== -1) {
        console.log("📝 Updating passenger status in roster:", {
          passengerIndex,
          bookingId:
            carpoolRoute.passengers[passengerIndex]?.bookingId?.toString(),
          status: carpoolRoute.passengers[passengerIndex]?.status,
        });

        carpoolRoute.passengers[passengerIndex].status =
          CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;

        console.log("✅ Passenger marked as cancelled successfully");

        console.log("📊 Passenger roster AFTER removal:", {
          totalPassengers: carpoolRoute.passengers?.length || 0,
          passengers: carpoolRoute.passengers?.map((p) => ({
            bookingId: p.bookingId?.toString(),
            status: p.status,
            passengerId: p.passengerId?.toString?.(),
          })),
        });
      } else {
        console.warn(
          "⚠️ Passenger entry NOT found in carpool roster:",
          bookingId,
        );
      }

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("🧹 [4] Clearing passenger active booking Redis key");
      console.log(
        "------------------------------------------------------------",
      );

      const passengerId = booking.passenger.toString();
      const passengerActiveKey =
        REDIS_CONSTANTS.keys.passengerActiveCarpool(passengerId);

      console.log("🔑 Redis key:", passengerActiveKey);
      console.log("👤 Passenger ID:", passengerId);

      await redis.del(passengerActiveKey);

      console.log("✅ [4] Passenger active booking Redis key deleted");

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("📡 [5] Emitting booking cancellation socket event");
      console.log(
        "------------------------------------------------------------",
      );

      const carpoolRoom = `carpool:${carpoolRoute._id.toString()}`;

      console.log("📡 Socket room:", carpoolRoom);
      console.log("📡 Socket event:", CARPOOL_SOCKET_EVENTS.BOOKING_STATUS);
      console.log("📦 Socket payload:", {
        bookingId,
        status: "cancelled",
        reason: "payment_failed",
      });

      /* Notify carpool room — driver + passenger both see this */
      io.to(carpoolRoom).emit(CARPOOL_SOCKET_EVENTS.BOOKING_STATUS, {
        bookingId,
        status: "cancelled",
        reason: "payment_failed",
        reasonCode: reason,
        cancelledBy: "payment_failure",
        driverFare: getCarpoolDriverFare(booking),
      });

      const passenger = await UserModel.findById(booking.passenger).select(
        "locale",
      );
      const passengerLocale = passenger?.locale || "en";
      await sendNotificationToSpecificUser({
        title: t("CARPOOL_PAYMENT_FAILED_TITLE", passengerLocale),
        description: t("CARPOOL_PAYMENT_FAILED_DESC", passengerLocale).replace(
          "${reason}",
          t(reason, passengerLocale),
        ),
        userIds: [booking.passenger],
        role: "user",
        metadata: {
          type: "CARPOOL_PAYMENT_FAILED",
          reasonCode: reason,
        },
      });

      console.log("✅ [5] Booking cancellation socket emitted");

      console.log(
        "\n------------------------------------------------------------",
      );
      console.log("🔎 [6] Checking carpool route status");
      console.log(
        "------------------------------------------------------------",
      );

      console.log("🚗 Current route status:", carpoolRoute.status);
      console.log("🚗 Expected IN_PROGRESS:", CARPOOL_STATUS_ENUM.IN_PROGRESS);

      if (carpoolRoute.status === CARPOOL_STATUS_ENUM.IN_PROGRESS) {
        console.log("✅ [6] Route is IN_PROGRESS");

        console.log("🔢 Calculating remaining accepted passengers...");

        const totals = carpoolRoute.passengers.filter(
          (p) => p.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
        ).length;

        console.log(
          `[CARPOOL PAYMENT FAILED] In-progress route, remaining active passengers: ${totals}`,
        );

        console.log("📊 Remaining passenger details:", {
          totalRosterPassengers: carpoolRoute.passengers?.length || 0,
          acceptedPassengers: totals,
          passengers: carpoolRoute.passengers?.map((p) => ({
            bookingId: p.bookingId?.toString(),
            status: p.status,
          })),
        });

        if (totals === 0) {
          console.log(
            "\n============================================================",
          );
          console.log("🛑 [7] NO ACTIVE PASSENGERS LEFT");
          console.log("🛑 Cancelling entire carpool route");
          console.log(
            "============================================================",
          );

          console.log("📋 Route status BEFORE:", carpoolRoute.status);

          carpoolRoute.status = CARPOOL_STATUS_ENUM.CANCELLED;
          carpoolRoute.cancelledBy = "payment_failure";
          carpoolRoute.cancellationReason = reason;
          carpoolRoute.cancelledAt = new Date();

          console.log(
            "📋 Route status AFTER modification:",
            carpoolRoute.status,
          );

          await carpoolRoute.save();

          await recordJourneyEventWithDriverLocation(
            {
              journeyType: "carpool",
              journeyId: carpoolRoute._id,
              carpoolId: carpoolRoute._id,
              eventType: "carpool.route_cancelled",
              phase: "ended",
              actor: { type: "stripe", id: null },
              source: "webhook",
              transition: {
                from: CARPOOL_STATUS_ENUM.IN_PROGRESS,
                to: CARPOOL_STATUS_ENUM.CANCELLED,
              },
              occurredAt: carpoolRoute.cancelledAt,
              reasonCode: reason,
              dedupeKey: `carpool:${carpoolRoute._id}:route_cancelled`,
            },
            carpoolRoute.driver,
          );

          console.log("✅ [7] Carpool route saved as CANCELLED");

          console.log(
            "\n------------------------------------------------------------",
          );
          console.log("🧹 [8] Cleaning carpool Redis keys");
          console.log(
            "------------------------------------------------------------",
          );

          const driverActiveKey = REDIS_CONSTANTS.keys.driverCarpoolActive(
            carpoolRoute.driver,
          );

          const carpoolRouteKey = REDIS_CONSTANTS.keys.carpoolRoute(
            carpoolRoute._id.toString(),
          );

          const carpoolSeatsKey = REDIS_CONSTANTS.keys.carpoolSeats(
            carpoolRoute._id.toString(),
          );

          console.log("🔑 Redis keys to delete:", {
            driverActiveKey,
            carpoolRouteKey,
            carpoolSeatsKey,
          });

          await Promise.all([
            redis.del(driverActiveKey),
            redis.del(carpoolRouteKey),
            redis.del(carpoolSeatsKey),
          ]);
          await handleAssignmentEnded(carpoolRoute.driver, io);

          console.log("✅ [8] All carpool Redis keys deleted");

          console.log(
            "\n------------------------------------------------------------",
          );
          console.log("📡 [9] Emitting route cancellation socket event");
          console.log(
            "------------------------------------------------------------",
          );

          console.log("📡 Socket room:", carpoolRoom);
          console.log("📡 Socket event:", CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE);
          console.log("📦 Socket payload:", {
            carpoolId: carpoolRoute._id,
            status: CARPOOL_STATUS_ENUM.CANCELLED,
            reason: "payment_failed",
            reasonCode: reason,
            cancelledBy: "payment_failure",
          });

          io.to(carpoolRoom).emit(CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE, {
            carpoolId: carpoolRoute._id,
            status: CARPOOL_STATUS_ENUM.CANCELLED,
            reason: "payment_failed",
          });

          console.log("✅ [9] Route cancellation socket emitted");

          console.log(
            "\n------------------------------------------------------------",
          );
          console.log("🔔 [10] Fetching driver for notification");
          console.log(
            "------------------------------------------------------------",
          );

          console.log("👨‍✈️ Driver ID:", carpoolRoute.driver?.toString());

          const driver = await DriverModel.findById(carpoolRoute.driver).select(
            "locale",
          );

          console.log("👨‍✈️ Driver lookup result:", {
            found: !!driver,
            driverId: carpoolRoute.driver?.toString(),
            locale: driver?.locale,
          });

          console.log(
            "\n------------------------------------------------------------",
          );
          console.log("🔔 [11] Sending carpool ended notification");
          console.log(
            "------------------------------------------------------------",
          );

          const driverLocale = driver?.locale || "en";

          console.log("🌐 Driver locale:", driverLocale);
          console.log("🔔 Notification title:", "CARPOOL_ENDED_TITLE");
          console.log("🔔 Notification description:", "CARPOOL_ENDED_DESC");
          console.log("👨‍✈️ Notification recipient:", carpoolRoute.driver);

          await sendNotificationToSpecificUser({
            title: t("CARPOOL_ENDED_PAYMENT_FAILED_TITLE", driverLocale),
            description: t("CARPOOL_ENDED_PAYMENT_FAILED_DESC", driverLocale),
            userIds: [carpoolRoute.driver],
            role: "driver",
            metadata: {
              type: "CARPOOL_ENDED",
            },
          });

          console.log("✅ [11] Notification sent successfully");

          console.log(
            "\n============================================================",
          );
          console.log("✅ [CARPOOL ENDED] Route fully cancelled");
          console.log(
            "============================================================",
          );

          console.log("📋 Final route details:", {
            carpoolRouteId: carpoolRoute._id?.toString(),
            driverId: carpoolRoute.driver?.toString(),
            status: carpoolRoute.status,
            remainingPassengers: carpoolRoute.passengers?.length || 0,
          });

          console.log("📋 Final booking details:", {
            bookingId: booking._id?.toString(),
            passengerId: booking.passenger?.toString(),
            status: booking.status,
            paymentStatus: booking.paymentStatus,
          });

          console.log(
            "============================================================\n",
          );
        } else {
          console.log(
            "\n------------------------------------------------------------",
          );
          console.log("💾 [7] Active passengers still exist");
          console.log(
            "------------------------------------------------------------",
          );

          console.log(
            `ℹ️ Keeping carpool route ACTIVE with ${totals} accepted passenger(s)`,
          );

          console.log("📋 Route status:", carpoolRoute.status);
          console.log(
            "📊 Remaining passengers:",
            carpoolRoute.passengers?.length || 0,
          );

          await carpoolRoute.save();

          console.log("✅ [7] Carpool route saved successfully");

          console.log(
            "============================================================",
          );
          console.log("✅ [CARPOOL PAYMENT FAILED] Booking cancelled");
          console.log("ℹ️ Route remains active because passengers still exist");
          console.log(
            "============================================================\n",
          );
        }
      } else if (
        carpoolRoute.status === CARPOOL_STATUS_ENUM.CANCELLED &&
        carpoolRoute.passengers.every(
          (passenger) =>
            passenger.status !== CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
        )
      ) {
        /*
         * Idempotent recovery: an earlier attempt may have persisted the
         * terminal Mongo status but failed before deleting Redis. Retrying the
         * Stripe event must still release the driver instead of skipping
         * cleanup because the route is already cancelled.
         */
        console.log(
          "[CARPOOL PAYMENT FAILED] Route is already cancelled with no passengers; cleaning stale carpool cache.",
        );

        await Promise.all([
          redis.del(
            REDIS_CONSTANTS.keys.driverCarpoolActive(carpoolRoute.driver),
          ),
          redis.del(
            REDIS_CONSTANTS.keys.carpoolRoute(carpoolRoute._id.toString()),
          ),
          redis.del(
            REDIS_CONSTANTS.keys.carpoolSeats(carpoolRoute._id.toString()),
          ),
        ]);
        await handleAssignmentEnded(carpoolRoute.driver, io);

        io.to(carpoolRoom).emit(CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE, {
          carpoolId: carpoolRoute._id,
          status: CARPOOL_STATUS_ENUM.CANCELLED,
          reason: "payment_failed",
        });

        await carpoolRoute.save();
        console.log(
          "[CARPOOL PAYMENT FAILED] Stale active-carpool cache cleared for already-cancelled route.",
        );
      } else {
        console.log(
          "\n------------------------------------------------------------",
        );
        console.log("💾 [6] Route is NOT IN_PROGRESS");
        console.log(
          "------------------------------------------------------------",
        );

        console.log(
          "ℹ️ Current route status:",
          carpoolRoute.status,
          "— skipping active passenger count / route cancellation logic",
        );

        console.log("💾 Saving modified carpool route...");

        await carpoolRoute.save();

        console.log("✅ Carpool route saved successfully");

        console.log(
          "============================================================",
        );
        console.log("✅ [CARPOOL PAYMENT FAILED] Booking cancelled");
        console.log("ℹ️ Route was not IN_PROGRESS");
        console.log(
          "============================================================\n",
        );
      }
    } catch (err) {
      console.error(
        "\n============================================================",
      );
      console.error("❌ [CARPOOL PAYMENT FAILED] HANDLER ERROR");
      console.error(
        "============================================================",
      );
      console.error("📌 bookingId:", bookingId);
      console.error("📌 Error message:", err?.message);
      console.error("📌 Error name:", err?.name);
      console.error("📌 Error stack:", err?.stack);
      console.error(
        "============================================================\n",
      );
    }
  };

  emitter.on("carpool:payment:failed", handleCarpoolPaymentFailed);
};
