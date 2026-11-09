const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  RIDE_SOCKET_EVENTS,
  RIDE_STATUS,
  USER,
  SOCKET,
  RIDE,
  SESSION,
  PENDING,
  PICKUP,
  DESTINATION_PROXIMITY_THRESHOLD,
  DRIVER,
  COMMON_SOCKET_EVENTS,
  DISPATCHABLE_CATEGORIES,
} = require("../../core/common/constants/ride-constants");
const { UnauthorizedError } = require("../../core/common/exceptions");
const {
  parseRide,
  toMidTripSummary,
  t,
  validateOrFail,
  ok,
  fail,
  isUserOnAuthenticatedDevice,
} = require("../../core/common/helpers");
const asyncSocketWrapper = require("../../core/common/socket-async");
const { measureAsync } = require("../../core/common/performance-timing");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  rideIdValidator,
  rideStartValidator,
  rideCancellationValidator,
  rideArriveValidator,
  driverLocationUpdateValidator,
} = require("../driver/dto/driverSocket.validator");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { rideRequestValidator } = require("../ride/dto/ride.validator");
const {
  rideUpgradeDecisionValidator,
} = require("../ride/dto/ride-upgrade.validator");
const {
  acceptCategoryUpgrade,
  declineCategoryUpgrade,
  getPendingUpgradeOffer,
} = require("./ride-upgrade.service");
const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const mongoose = require("mongoose");
const {
  assertRiderCanPayFare,
  createRideRequestService,
  acceptRideService,
  updateRideStatusService,
  verifyRideOTPService,
  getActiveRideForUser,
  getActiveRideForDriver,
  chargeUserForRide,
  cancelRideService,
  chargeCancellationFee,
  handleDriverSuspension,
  cancelRidePendingRequest,
  refreshDriverRequestList,
  prepareRideForStart,
  getRideWithRelations,
} = require("./ride.service");
const RideModel = require("./model/ride.model");
const {
  settleMidTripCancellation,
} = require("./ride-mid-trip-cancellation.service");
const RideOfferModel = require("./model/ride-offer.model");
const { applyCode } = require("../promo-code/promo-code-campaign.service");
const { trackPassengerPresence } = require("./high-demand.service");
const { getAppMessage } = require("../config/ride-configuration.service");
const {
  previewReferralDiscount,
} = require("../driver-referral/driver-referral.service");
const {
  resolveFullRequestFare,
} = require("../driver-referral/driver-referral.helper");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");

const redis = getRedisConnection();

// What a rider is told when they cannot pay a fare — the same sentences whether
// the fare was rejected at request time or when an upgrade raised it.
const PAYMENT_PROBLEM_MESSAGES = {
  INSUFFICIENT_WALLET_BALANCE: "Insufficient wallet balance",
  NO_ACTIVE_CARD: "No active card attached. Please attach a card to proceed.",
  NOT_YOUR_RIDE: "This ride does not belong to you.",
  OFFER_NOT_PENDING: "This offer is no longer available.",
  OFFER_EXPIRED: "This offer has expired.",
  RIDE_ALREADY_ACCEPTED: "A driver has already accepted your ride.",
};

const withRideDriverFare = (ride) => {
  if (!ride) return ride;

  const serialized =
    typeof ride.toObject === "function" ? ride.toObject() : ride;

  return {
    ...serialized,
    driverFare: getRideDriverFare(serialized),
  };
};

module.exports = async (io, socket) => {
  /**
   * Announce a status change to everyone in the ride room.
   *
   * Every update carries `rideId` and the ride itself, because the apps merge
   * what they receive into the ride they are holding: an update without the
   * ride leaves their copy frozen on the previous status, and one built from
   * the document `updateRideStatusService` returns — which comes back
   * unpopulated — would blank out the driver's name, photo and plate.
   */
  const emitRideStatusUpdate = async (rideId, payload) => {
    let ride = null;

    try {
      ride = parseRide(await getRideWithRelations(rideId));
    } catch (error) {
      console.error(
        "Could not load the ride for a status update:",
        String(rideId),
        error.message,
      );
    }

    io.to(`${RIDE}:${rideId}`).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
      rideId,
      ...(ride ? { ride } : {}),
      ...payload,
    });
  };

  const userId = socket.user._id.toString();
  const role = socket.user.role;
  let locale = socket.user.locale;
  const loggedId = socket.loggedId;

  socket.use(async ([event, ...args], next) => {
    const isAuthenticated = await isUserOnAuthenticatedDevice(userId, loggedId);
    if (!isAuthenticated) {
      socket.emit("error", {
        message: "Unauthorized - Please re-login on a valid device",
      });
      return socket.disconnect();
    }
    const Model = role === "driver" ? DriverModel : UserModel;
    const user = await Model.findById(userId).select("locale");
    locale = user?.locale || locale; // Update locale in case it changed since connection

    next();
  });
  /*
  ========================================
  SESSION RECOVERY ON CONNECT
  ========================================
  */
  (async () => {
    let ride;

    ride =
      role === "user"
        ? await getActiveRideForUser(userId)
        : await getActiveRideForDriver(userId);

    console.log("Resume triggered for user:", userId);

    if (ride) {
      const rideId = ride._id;
      socket.join(`${RIDE}:${rideId}`);

      socket.emit(RIDE_SOCKET_EVENTS.RESUME, {
        type: ride.rideStatus,
        rideId,
        driverFare: getRideDriverFare(ride),
      });

      return;
    } else if (role === "driver") {
      console.log(
        "No active ride found for driver. Checking for pending offers...",
        {
          driverId: userId,
        },
      );

      const pendingOffers = await RideOfferModel.countDocuments({
        driver: new mongoose.Types.ObjectId(userId),
        status: "pending",
      });
      console.log("🚀 ~ pendingOffers:", pendingOffers);

      if (pendingOffers > 0) {
        socket.emit(RIDE_SOCKET_EVENTS.RESUME, {
          type: "offers_pending",
          count: pendingOffers,
        });

        console.log(
          "Pending offers found for driver. Emitting resume with offers_pending.",
        );
        return;
      }
    }

    if (role !== "user") return;

    const pendingKey = `${USER}:${userId}:${RIDE}:${PENDING}`;
    const pendingRequest = await redis.get(pendingKey);
    if (!pendingRequest) return;

    const sessionKey = `${RIDE}:${SESSION}:${pendingRequest}`;
    const sessionExists = await redis.exists(sessionKey);
    if (!sessionExists) return;

    // Rejoin the room, or a rider who reconnects mid-search stops receiving the
    // dispatch progress and is left watching a spinner that never moves.
    socket.join(`${RIDE}:${pendingRequest}`);

    // The search may not be running at all: it may be waiting on an upgrade the
    // rider never answered. Re-sending it with the seconds that are actually
    // left is what stops that reconnection landing on a frozen screen.
    const pendingOffer = await getPendingUpgradeOffer(pendingRequest);

    socket.emit(RIDE_SOCKET_EVENTS.RESUME, {
      type: RIDE_STATUS.REQUESTED,
      rideId: pendingRequest,
      ...(pendingOffer ? { upgradeOffer: pendingOffer } : {}),
    });

    if (pendingOffer) {
      socket.emit(RIDE_SOCKET_EVENTS.UPGRADE_OFFER, pendingOffer);
    }
  })();

  socket.on(
    RIDE_SOCKET_EVENTS.RESUME,
    asyncSocketWrapper(socket, async (_, callback) => {
      let ride =
        role === "user"
          ? await getActiveRideForUser(userId)
          : await getActiveRideForDriver(userId);

      if (ride) {
        const rideId = ride._id;

        socket.join(`${RIDE}:${rideId}`);

        return ok(callback, "Ride resumed", {
          rideId,
          type: ride.rideStatus,
          ride: withRideDriverFare(ride),
        });
      }

      const pendingKey = `${USER}:${userId}:${RIDE}:${PENDING}`;
      const pendingRequest = await redis.get(pendingKey);

      if (!pendingRequest) {
        return callback({
          success: false,
          message: "No pending ride found",
        });
      }

      const sessionKey = `${RIDE}:${SESSION}:${pendingRequest}`;
      const sessionExists = await redis.exists(sessionKey);

      if (!sessionExists) {
        return callback({
          success: false,
          message: "Ride session expired",
        });
      }

      // Same reason as the connect-time resume: the search is still running and
      // its progress is emitted to the room.
      socket.join(`${RIDE}:${pendingRequest}`);

      const pendingOffer = await getPendingUpgradeOffer(pendingRequest);

      if (pendingOffer) {
        socket.emit(RIDE_SOCKET_EVENTS.UPGRADE_OFFER, pendingOffer);
      }

      return ok(callback, "Ride resumed", {
        rideId: pendingRequest,
        type: RIDE_STATUS.REQUESTED,
        ...(pendingOffer ? { upgradeOffer: pendingOffer } : {}),
      });
    }),
  );

  socket.on(
    RIDE_SOCKET_EVENTS.REQUEST,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(rideRequestValidator, payload, callback);
      if (!data) return;

      // `category` is the current spelling; `rideType` is what older clients
      // send. The validator guarantees at least one of them is present.
      const category = data.category || data.rideType;

      // Carpool is matched against routes drivers have already published, so it
      // never enters the dispatch ladder. Accepting the category here and
      // pointing at the right endpoint keeps one entry point for the app
      // without changing anything about how carpool works.
      if (!DISPATCHABLE_CATEGORIES.includes(category)) {
        return callback({
          success: false,
          message: await getAppMessage("USE_CARPOOL_MATCHING", locale),
          data: { category, endpoint: "POST /carpool/user/matches" },
        });
      }

      const user = await UserModel.findById(userId);
      if (!user) {
        return callback({ success: false, message: "User not found" });
      }

      // A saved driver referral lowers what the rider will be charged, so the
      // rider is cleared for that amount, not the full fare the app sent.
      const referralPreview = await previewReferralDiscount(
        user._id,
        resolveFullRequestFare(data),
      );

      // Shared with the upgrade path, which has to run the identical check
      // against a higher fare than the one cleared here.
      const paymentProblem = await assertRiderCanPayFare(user, {
        rideFare: referralPreview ? referralPreview.rideFare : data.rideFare,
        paymentMethod: data.paymentMethod,
      });

      if (paymentProblem) {
        return callback({
          success: false,
          message: PAYMENT_PROBLEM_MESSAGES[paymentProblem],
          data: { reason: paymentProblem },
        });
      }

      const { rideRequestId, dispatch, fare } = await createRideRequestService(
        user,
        { ...data, rideType: category },
        io,
        {
          // Join before the first ring opens, so the rider can watch the search
          // widen instead of staring at a spinner with nothing behind it.
          onRideCreated: (rideId) => socket.join(`${RIDE}:${rideId}`),
        },
      );

      return ok(
        callback,
        await getAppMessage("RIDE_REQUESTED_FINDING_DRIVERS", locale),
        {
          rideId: rideRequestId,
          category,
          search: dispatch ?? null,
          fare,
        },
      );
    }),
  );

  // The rider answering an upgrade offer: search again in the pricier category,
  // or let the request go. Accepting restarts the whole ladder on the same ride.
  socket.on(
    RIDE_SOCKET_EVENTS.UPGRADE_DECIDE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      if (role !== "user") {
        return fail(callback, "Only a rider can answer an upgrade offer");
      }

      const data = validateOrFail(
        rideUpgradeDecisionValidator,
        payload,
        callback,
      );
      if (!data) return;

      const { rideId, decision } = data;

      if (decision === "decline") {
        const declined = await declineCategoryUpgrade({
          rideId,
          userId,
          io,
          locale,
        });

        if (declined.stopped) {
          // Every refusal on this event carries `data.reason`, so the app can
          // branch on one shape instead of parsing sentences.
          return callback({
            success: false,
            message: PAYMENT_PROBLEM_MESSAGES.OFFER_NOT_PENDING,
            data: { reason: "OFFER_NOT_PENDING" },
          });
        }

        return ok(
          callback,
          await getAppMessage("RIDE_SEARCH_EXHAUSTED", locale),
          {
            rideId,
            outcome: "declined",
          },
        );
      }

      const result = await acceptCategoryUpgrade({
        rideId,
        userId,
        io,
        locale,
      });

      if (!result.accepted) {
        return callback({
          success: false,
          message:
            PAYMENT_PROBLEM_MESSAGES[result.reason] ??
            (await getAppMessage("RIDE_UPGRADE_UNAVAILABLE", locale)),
          data: { reason: result.reason },
        });
      }

      return ok(
        callback,
        // The category is interpolated here too, or the rider reads a literal
        // `{{toCategory}}` in the acknowledgement.
        await getAppMessage("RIDE_UPGRADE_SEARCHING", locale, {
          toCategory: t(
            `RIDE_CATEGORY_${String(result.rideType).toUpperCase()}`,
            locale,
          ),
        }),
        {
          rideId,
          rideType: result.rideType,
          rideFare: result.rideFare,
          searchAttempt: result.searchAttempt,
          search: result.search ?? null,
        },
      );
    }),
  );

  socket.on(
    RIDE_SOCKET_EVENTS.ACCEPT,
    asyncSocketWrapper(socket, async (payload, callback) => {
      console.log("ACCEPT event received", { userId, payload });
      const data = validateOrFail(rideIdValidator, payload, callback);
      if (!data) {
        console.log("Validation failed for ACCEPT event");
        return;
      }

      const { rideId: rideRequestId } = data;

      try {
        console.log("Accepting ride", { userId, rideRequestId });
        const { ride, rideOTP, passenger } = await acceptRideService(
          userId,
          rideRequestId,
        );
        console.log("Ride accepted successfully", {
          rideId: ride._id,
          passenger,
        });

        const rideRoom = `${RIDE}:${ride._id}`;

        socket.join(rideRoom);
        console.log("Driver socket joined room", { rideRoom });

        const userSocket = await redis.get(`${USER}:${passenger}:${SOCKET}`);
        if (userSocket) {
          io.sockets.sockets.get(userSocket)?.join(rideRoom);
          console.log("Passenger socket joined room", { rideRoom, userSocket });
        }

        io.to(rideRoom).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
          rideId: ride._id,
          type: RIDE_STATUS.ACCEPTED,
          ride: parseRide(ride),
          driverFare: getRideDriverFare(ride),
          rideOTP,
        });
        console.log("Status update emitted", { rideId: ride._id });

        const passengerLocale =
          await UserModel.findById(passenger).select("locale");
        console.log(
          "🎉 [RIDE ACCEPTANCE] Sending ride acceptance notification to passenger:",
          {
            rideId: ride._id,
            passengerId: passenger,
            driverId: userId,
            locale: passengerLocale?.locale || "en",
          },
        );
        const notification = await sendNotificationToSpecificUser({
          title: t("RIDE_ACCEPTED", passengerLocale?.locale || "en"),
          description: t("RIDE_ACCEPTED_DESC", passengerLocale?.locale || "en"),
          userIds: [passenger],
          role: "user",
          metadata: {
            type: "RIDE_ACCEPTED",
          },
        });

        console.log("✅ [RIDE ACCEPTANCE] Notification sent to passenger:", {
          rideId: ride._id,
          passengerId: passenger,
          notificationResult: notification,
        });

        return ok(callback, t("RIDE_ACCEPTED", locale), parseRide(ride));
      } catch (error) {
        console.error("Error accepting ride", {
          userId,
          rideRequestId,
          error: error.message,
        });
        // Losing the race is normal, not an error condition: every driver in
        // the ring is offered the ride and only one can win. Tell them plainly
        // and hand back a fresh list, so the dead request leaves their screen
        // in the same round trip.
        const lostTheRide = [
          "RIDE_ALREADY_TAKEN",
          "UNABLE_TO_ACCEPT_RIDE",
          "ASSIGNMENT_IN_PROGRESS",
        ].includes(error.message);

        if (lostTheRide) {
          const availableRides = await refreshDriverRequestList(userId);

          socket.emit(RIDE_SOCKET_EVENTS.REQUEST_TAKEN, {
            rideId: rideRequestId,
            reason: error.message,
            availableRides,
          });

          return fail(callback, t(error.message, locale));
        }

        if (
          [
            "DRIVER_ALREADY_ON_RIDE",
            "DRIVER_ALREADY_HAS_ACTIVE_CARPOOL",
          ].includes(error.message)
        ) {
          return fail(callback, t(error.message, locale));
        }

        if (error.message === "RIDE_EXPIRED") {
          return fail(callback, t("RIDE_EXPIRED", locale));
        }

        if (error.message === "SHIFT_EXCEEDED_ONLINE") {
          return fail(callback, t("SHIFT_EXCEEDED_ONLINE", locale));
        }

        throw error;
      }
    }),
  );

  socket.on(
    RIDE_SOCKET_EVENTS.ARRIVE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(rideArriveValidator, payload, callback);
      if (!data) return;

      const { rideId, location } = data;
      const [lng, lat] = location.coordinates;

      const result = await redis.geosearch(
        `${RIDE}:${rideId}:${PICKUP}`,
        REDIS_CONSTANTS.FROMLONLAT,
        lng,
        lat,
        REDIS_CONSTANTS.BYRADIUS,
        DESTINATION_PROXIMITY_THRESHOLD,
        REDIS_CONSTANTS.KM,
      );

      if (result.length === 0) {
        return fail(callback, t("NOT_AT_PICKUP_LOCATION", locale || "en"));
      }

      const ride = await updateRideStatusService(
        rideId,
        RIDE_STATUS.ARRIVED,
        null,
        {
          actorType: "driver",
          actorId: userId,
          source: "socket",
          location,
        },
      );

      await emitRideStatusUpdate(ride._id, {
        type: ride.rideStatus,
        driverFare: getRideDriverFare(ride),
      });

      const passengerLocale = await UserModel.findById(ride.user).select(
        "locale",
      );

      console.log(
        "🚗 [RIDE ARRIVAL] Sending driver arrival notification to passenger:",
        {
          rideId,
          passengerId: ride.user,
          driverId: userId,
          locale: passengerLocale?.locale || "en",
        },
      );
      await sendNotificationToSpecificUser({
        title: t("DRIVER_ARRIVED", passengerLocale?.locale || "en"),
        description: t("DRIVER_ARRIVED_DESC", passengerLocale?.locale || "en"),
        userIds: [ride.user],
        role: "user",
        metadata: {
          type: "RIDE_ARRIVED",
        },
      });

      console.log("✅ [RIDE ARRIVAL] Notification sent to passenger:", {
        rideId,
        passengerId: ride.user,
      });

      return ok(callback, t("DRIVER_ARRIVED", locale), parseRide(ride));
    }),
  );

  socket.on(
    RIDE_SOCKET_EVENTS.START,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(rideStartValidator, payload, callback);
      if (!data) return;

      const { rideId, otp } = data;
      await measureAsync(
        "ride.start.otp_verification",
        { rideId, driverId: userId },
        () =>
          verifyRideOTPService(rideId, otp, {
            actorType: "driver",
            actorId: userId,
            source: "socket",
          }),
      );

      // The state gate runs before the charge, never after it. A ride that
      // cannot reach "in-progress" must fail here, with the rider's money still
      // where it was, and a driver who skipped the arrival gets it recorded
      // rather than the ride refused.
      await prepareRideForStart(rideId, {
        actorId: userId,
        source: "socket",
      });

      const r = await measureAsync(
        "ride.start.payment",
        { rideId, driverId: userId },
        () => chargeUserForRide(rideId),
      );

      // The ride starts as soon as the money is settled. Wallet and free rides
      // settle inside the charge above; so does a card, unless Stripe asked for
      // 3-D Secure — the one case that still has to wait for the webhook.
      // Without this the ride stays in "arrived": the rider is never told it
      // began and the driver cannot complete it, because "arrived" ->
      // "completed" is not a legal transition.
      const paymentSettled =
        r.paymentMethod === "wallet" ||
        r.paymentMethod === "free" ||
        r.settled === true ||
        r.alreadyProcessed === true;

      if (paymentSettled) {
        const ride = await updateRideStatusService(
          rideId,
          RIDE_STATUS.IN_PROGRESS,
          "completed",
          {
            actorType: "driver",
            actorId: userId,
            source: "socket",
          },
        );
        await emitRideStatusUpdate(ride._id, {
          type: ride.rideStatus,
          driverFare: getRideDriverFare(ride),
        });

        const passengerLocale = await UserModel.findById(ride.user).select(
          "locale",
        );

        console.log(
          "🏁 [RIDE START] Sending ride started notification to passenger:",
          {
            rideId,
            passengerId: ride.user,
            driverId: userId,
            locale: passengerLocale?.locale || "en",
          },
        );

        sendNotificationToSpecificUser({
          title: t("RIDE_STARTED", passengerLocale?.locale || "en"),
          description: t("RIDE_STARTED_DES", passengerLocale?.locale || "en"),
          userIds: [ride.user],
          metadata: {
            type: "RIDE_STARTED",
          },
          role: "user",
        });

        sendNotificationToSpecificUser({
          title: t("NOTIFICATION_VERIFICATION_SUCCESS_TITLE", locale || "en"),
          description: t(
            "NOTIFICATION_VERIFICATION_SUCCESS_DESC",
            locale || "en",
          ).replace("{{amount}}", getRideDriverFare(ride).toFixed(2)),
          userIds: [ride.driver],
          metadata: {
            type: "RIDE_STARTED",
            driverFare: getRideDriverFare(ride),
          },
        });

        if (ride.codeId && ride.campaignId && ride.discountAmount > 0) {
          const applied = await applyCode({
            promoCode: ride.codeId,
            campaign: ride.campaignId,
            user: ride.user,
            appliedTo: rideId,
            appliedToType: "Ride",
            discountApplied: ride.discountAmount,
          });
          if (!applied) {
            console.error("[ride:payment] Redemption record failed", {
              rideId,
            });
          }
        }

        console.log("✅ [RIDE START] Notification sent to passenger:", {
          rideId,
          passengerId: ride.user,
        });

        return ok(callback, t("RIDE_STARTED", locale), parseRide(ride));
      }

      if (r.requiresAction) {
        const rideRoom = `${RIDE}:${rideId}`;

        io.to(rideRoom).emit(RIDE_SOCKET_EVENTS.PAYMENT_VERIFICATION, {
          requiresAction: r.requiresAction,
          clientSecret: r.clientSecret ?? null,
          paymentIntentId: r.paymentIntentId,
        });
      }

      return ok(callback, t("RIDE_STARTED_PAYMENT_PENDING", locale), {
        requiresAction: r.requiresAction,
      });
    }),
  );

  socket.on(
    RIDE_SOCKET_EVENTS.COMPLETE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(rideIdValidator, payload, callback);
      if (!data) return;

      const { rideId } = data;

      const ride = await updateRideStatusService(
        rideId,
        RIDE_STATUS.COMPLETED,
        null,
        {
          actorType: "driver",
          actorId: userId,
          source: "socket",
          io,
        },
      );

      await emitRideStatusUpdate(ride._id, {
        type: RIDE_STATUS.COMPLETED,
        driverFare: getRideDriverFare(ride),
      });

      const passengerLocale = await UserModel.findById(ride.user).select(
        "locale",
      );

      console.log(
        "🎊 [RIDE COMPLETION] Sending ride completed notification to passenger:",
        {
          rideId,
          passengerId: ride.user,
          driverId: userId,
          locale: passengerLocale?.locale || "en",
        },
      );

      sendNotificationToSpecificUser({
        title: t("RIDE_COMPLETED", passengerLocale?.locale || "en"),
        description: t("RIDE_COMPLETED_DESC", passengerLocale?.locale || "en"),
        userIds: [ride.user],
        metadata: {
          type: "RIDE_COMPLETED",
          id: ride._id,
        },
        role: "user",
      });

      console.log("✅ [RIDE COMPLETION] Notification sent to passenger:", {
        rideId,
        passengerId: ride.user,
      });

      return ok(callback, t("RIDE_COMPLETED", locale), parseRide(ride));
    }),
  );

  socket.on(
    RIDE_SOCKET_EVENTS.CANCEL,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(rideCancellationValidator, payload, callback);
      if (!data) return;

      const { rideId, cancellationReason, isPendingRequestCancelled } = data;
      const oldRide = await RideModel.findById(rideId).select("rideStatus");

      if (oldRide.rideStatus === RIDE_STATUS.CANCELLED) {
        return fail(callback, t("RIDE_ALREADY_CANCELLED", locale));
      }

      if (isPendingRequestCancelled) {
        const ride = await cancelRidePendingRequest(rideId, userId);
        return ok(callback, t("RIDE_CANCELLED", locale), parseRide(ride));
      }

      if (role === "user") {
        await chargeCancellationFee(rideId, userId);
      }

      const [ride] = await Promise.all([
        updateRideStatusService(rideId, RIDE_STATUS.CANCELLED, null, {
          actorType: role,
          actorId: userId,
          source: "socket",
          reasonCode: cancellationReason || "CANCELLED",
          io,
        }),
        cancelRideService(rideId, role, cancellationReason),
      ]);

      if (role === "driver") {
        await handleDriverSuspension(userId);
      }

      // The full fare was taken at Start Ride. Whoever cancels, the rider pays
      // only for the delivered share and the rest goes back. The ride is
      // already cancelled here, so a failed refund cannot undo that; it is
      // recorded as "failed" on the ride and can be retried.
      let midTripCancellation = null;
      if (oldRide.rideStatus === RIDE_STATUS.IN_PROGRESS) {
        try {
          midTripCancellation = await settleMidTripCancellation(rideId);
        } catch (error) {
          console.error(
            `Mid-trip cancellation settlement failed for ride ${rideId}:`,
            error,
          );
          midTripCancellation = { status: "failed" };
        }
      }

      await emitRideStatusUpdate(rideId, {
        type: RIDE_STATUS.CANCELLED,
        message: "Ride has been cancelled",
        driverFare:
          midTripCancellation?.status === "completed"
            ? midTripCancellation.driverKept
            : getRideDriverFare(ride),
        ...(midTripCancellation
          ? { midTripCancellation: toMidTripSummary(midTripCancellation) }
          : {}),
      });

      const passengerLocale = await UserModel.findById(ride.user).select(
        "locale",
      );
      const driverLocale = await DriverModel.findById(ride.driver).select(
        "locale",
      );
      const notificationLocale =
        role === "user"
          ? driverLocale?.locale || "en"
          : passengerLocale?.locale || "en";
      const recipientId = role === "user" ? ride.driver : ride.user;
      const recipientRole = role === "user" ? "driver" : "user";

      sendNotificationToSpecificUser({
        title: t("RIDE_CANCELLED", notificationLocale),
        description: t("RIDE_CANCELLED_DESC", notificationLocale),
        userIds: [recipientId],
        metadata: {
          type: "RIDE_CANCELLED",
        },
        role: recipientRole,
      });

      return ok(callback, t("RIDE_CANCELLED", locale), {
        ...parseRide(ride),
        ...(midTripCancellation
          ? { midTripCancellation: toMidTripSummary(midTripCancellation) }
          : {}),
      });
    }),
  );

  // ── Retired: rider-picked driver offers ─────────────────────────────────────
  // The rider no longer chooses from a list of drivers. A request goes out to
  // the nearest drivers and the first to accept is assigned, so these three
  // events have no counterpart in the current flow. They stay wired up only to
  // answer older clients with something clearer than silence. The services
  // behind them, and every RideOffer already written, are left untouched.
  for (const retiredOfferEvent of [
    RIDE_SOCKET_EVENTS.SEND_OFFER,
    RIDE_SOCKET_EVENTS.ACCEPT_OFFER,
    RIDE_SOCKET_EVENTS.REJECT_OFFER,
  ]) {
    socket.on(retiredOfferEvent, async (_payload, callback) => {
      if (typeof callback !== "function") return;
      return fail(
        callback,
        await getAppMessage("RIDE_OFFERS_DISABLED", locale),
        "FEATURE_DISABLED",
      );
    });
  }

  // ── UPDATE_USER_LOC — user broadcasts live location to Redis GEO ────────────────
  if (role === "user") {
    socket.on(
      RIDE_SOCKET_EVENTS.UPDATE_USER_LOC,
      asyncSocketWrapper(socket, async (payload, callback) => {
        const parsed = driverLocationUpdateValidator.safeParse(payload);

        if (!parsed.success) {
          if (callback) {
            return callback({
              success: false,
              message: parsed.error.errors[0].message,
            });
          }
          return;
        }

        const { location } = parsed.data;
        const [lng, lat] = location.coordinates;

        await trackPassengerPresence(userId, lat, lng); // lat, lng
        await redis.geoadd(REDIS_CONSTANTS.USER_GEO_KEY, lng, lat, userId);

        if (callback) {
          return callback({
            success: true,
            message: "User location updated",
            data: null,
          });
        }
      }),
    );

    // Remove user from GEO index on disconnect to avoid stale entries
    socket.on(COMMON_SOCKET_EVENTS.DISCONNECT, async () => {
      try {
        await redis.zrem(REDIS_CONSTANTS.USER_GEO_KEY, userId);
        console.log("User removed from GEO index on disconnect:", userId);
      } catch (error) {
        console.error("Error removing user from GEO index:", error);
      }
    });
  }
};
