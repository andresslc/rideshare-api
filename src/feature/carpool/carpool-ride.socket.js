const {
  createCarpoolRouteValidator,
  findCarpoolRoutesValidator,
  joinCarpoolValidator,
  carpoolRespondValidator,
  carpoolStartValidator,
  carpoolPickPassengerValidator,
  carpoolCompleteValidator,
  cancelCarpoolRouteValidator,
  carpoolArriveValidator,
} = require("./dto/carpool.validator");

const asyncSocketWrapper = require("../../core/common/socket-async");
const { measureAsync } = require("../../core/common/performance-timing");
const {
  validateOrFail,
  ok,
  resolveErrorMessage,
  fail,
  t,
  isUserOnAuthenticatedDevice,
} = require("../../core/common/helpers");
const {
  CARPOOL_SOCKET_EVENTS,
  CARPOOL_BOOKING_STATUS_ENUM,
  CARPOOL_STATUS_ENUM,
  CARPOOL_PAYMENT_ERROR_KEYS,
} = require("../../core/common/constants/carpool-constants");

const {
  createCarpoolRouteService,
  findMatchingCarpoolRoutes,
  joinCarpoolService,
  respondToPassengerService,
  startCarpoolService,
  pickPassengerService,
  completeCarpoolRideService,
  cancelCarpoolRouteService,
  arriveAtStopService,
  getActiveCarpoolForDriver,
  getActiveCarpoolForPassenger,
} = require("./carpool.services");
const CarpoolBookingModel = require("./model/carpool-booking.model");
const DriverModel = require("../driver/models/driver.model");
const UserModel = require("../user/models/user.model");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const {
  getCarpoolDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");
const {
  recordJourneyEventWithDriverLocation,
} = require("../journey-log/journey-log.service");
const { handleAssignmentEnded } = require("../driver/driver-shift.service");

const withCarpoolDriverFare = (booking) => {
  const serialized =
    typeof booking?.toObject === "function" ? booking.toObject() : booking;

  return serialized
    ? { ...serialized, driverFare: getCarpoolDriverFare(serialized) }
    : serialized;
};

/* ─────────────────────────────────────────────────────────────
   Socket Handler Factory
   Each socket gets its own handler scope.
───────────────────────────────────────────────────────────── */
module.exports = (io, socket) => {
  const userId = socket.user._id.toString();
  const role = socket.user.role; // "driver" | "passenger"
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

  (async () => {
    try {
      if (role === "driver") {
        const route = await getActiveCarpoolForDriver(userId);
        if (!route) return;

        const bookingDocuments = await CarpoolBookingModel.find({
          carpool: route._id,
        });
        const bookings = bookingDocuments.map(withCarpoolDriverFare);

        /* Rejoin the carpool room so the driver receives all events */
        socket.join(`carpool:${route._id}`);
        bookingDocuments.forEach((booking) =>
          socket.join(`carpool:${booking._id.toString()}`),
        );

        socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, {
          role: "driver",
          type: route.status, // "open" | "full" | "in_progress"
          carpoolId: route._id,
          carpoolRoute: {
            _id: route._id,
            status: route.status,
            availableSeats: route.availableSeats,
            maxPassengers: route.maxPassengers,
            graceTime: route.graceTime,
            avgTime: route.avgTime ?? 0,
            distance: route.distance ?? 0,
            routes: route.routes,
            startingPoint: route.startingPoint,
            destination: route.destination,
            passengers: route.passengers,
            bookings,
          },
        });

        return;
      }

      /* ── Passenger ──────────────────────────────────────── */
      const booking = await getActiveCarpoolForPassenger(userId);
      if (!booking) return;

      const carpoolRoute = booking.carpool;
      const carpoolId = carpoolRoute._id.toString();
      const bookingId = booking._id.toString();

      if (booking.status === CARPOOL_BOOKING_STATUS_ENUM.PENDING) {
        /*
         * Still awaiting driver response — rejoin the booking room
         * so the accept/reject notification reaches this socket.
         */
        socket.join(`booking:${bookingId}`);

        socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, {
          role: "passenger",
          type: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
          carpoolId,
          bookingId,
          fareCharged: booking.fareCharged,
          driverFare: getCarpoolDriverFare(booking),
          requiredSeats: booking.requiredSeats ?? 1,
          avgTime: booking.avgTime ?? 0,
          distance: booking.distance ?? 0,
        });

        return;
      }

      if (booking.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED) {
        if (carpoolRoute.status === CARPOOL_STATUS_ENUM.IN_PROGRESS) {
          /*
           * Ride is underway — passenger should be in the shared
           * carpool room (migrated during startCarpoolService).
           */
          socket.join(`carpool:${carpoolId}`);
          socket.join(`carpool:${bookingId}`);

          socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, {
            role: "passenger",
            type: CARPOOL_STATUS_ENUM.IN_PROGRESS,
            carpoolId,
            bookingId,
            otp: booking.otp, // don't re-send if already used
            otpVerified: booking.otpVerified,
            pickupStop: booking.pickupStop,
            dropOffStop: booking.dropOffStop,
            fareCharged: booking.fareCharged,
            driverFare: getCarpoolDriverFare(booking),
            requiredSeats: booking.requiredSeats ?? 1,
            avgTime: booking.avgTime ?? 0,
            distance: booking.distance ?? 0,
            driver: booking.driver,
          });
        } else {
          /*
           * Accepted but ride hasn't started yet — stay in booking
           * room until startCarpoolService migrates them.
           */
          socket.join(`booking:${bookingId}`);
          socket.join(`carpool:${bookingId}`);

          socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, {
            role: "passenger",
            type: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
            carpoolId,
            bookingId,
            otp: booking.otp,
            pickupStop: booking.pickupStop,
            dropOffStop: booking.dropOffStop,
            fareCharged: booking.fareCharged,
            driverFare: getCarpoolDriverFare(booking),
            requiredSeats: booking.requiredSeats ?? 1,
            avgTime: booking.avgTime ?? 0,
            distance: booking.distance ?? 0,
            driver: booking.driver,
          });
        }
      }
    } catch (err) {
      console.error("[carpool:resume] Error during session resume:", err);
      /* Silent fail — don't crash the socket; client can retry */
    }
  })();

  socket.on(
    CARPOOL_SOCKET_EVENTS.RESUME,
    asyncSocketWrapper(socket, async (payload, callback) => {
      try {
        if (role === "driver") {
          const route = await getActiveCarpoolForDriver(userId);
          if (!route) {
            return callback({
              success: false,
              message: "No active carpool",
            });
          }

          const bookingDocuments = await CarpoolBookingModel.find({
            carpool: route._id,
          });
          const bookings = bookingDocuments.map(withCarpoolDriverFare);

          socket.join(`carpool:${route._id}`);

          bookingDocuments.forEach((booking) =>
            socket.join(`carpool:${booking._id.toString()}`),
          );

          const response = {
            role: "driver",
            type: route.status,
            carpoolId: route._id,
            carpoolRoute: {
              _id: route._id,
              status: route.status,
              availableSeats: route.availableSeats,
              maxPassengers: route.maxPassengers,
              graceTime: route.graceTime,
              avgTime: route.avgTime ?? 0,
              distance: route.distance ?? 0,
              routes: route.routes,
              startingPoint: route.startingPoint,
              destination: route.destination,
              passengers: route.passengers,
              bookings,
            },
          };

          socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, response);

          return callback({
            success: true,
            ...response,
          });
        }

        /* ── Passenger ───────────────────────────── */

        const booking = await getActiveCarpoolForPassenger(userId);
        if (!booking) {
          return callback({
            success: false,
            message: "No active booking",
          });
        }

        const carpoolRoute = booking.carpool;
        const carpoolId = carpoolRoute._id.toString();
        const bookingId = booking._id.toString();

        let response;

        if (booking.status === CARPOOL_BOOKING_STATUS_ENUM.PENDING) {
          socket.join(`booking:${bookingId}`);

          response = {
            role: "passenger",
            type: CARPOOL_BOOKING_STATUS_ENUM.PENDING,
            carpoolId,
            bookingId,
            fareCharged: booking.fareCharged,
            driverFare: getCarpoolDriverFare(booking),
            requiredSeats: booking.requiredSeats ?? 1,
            avgTime: booking.avgTime ?? 0,
            distance: booking.distance ?? 0,
          };

          socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, response);

          return callback({ success: true, ...response });
        }

        if (booking.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED) {
          if (carpoolRoute.status === CARPOOL_STATUS_ENUM.IN_PROGRESS) {
            socket.join(`carpool:${carpoolId}`);
            socket.join(`carpool:${bookingId}`);

            response = {
              role: "passenger",
              type: CARPOOL_STATUS_ENUM.IN_PROGRESS,
              carpoolId,
              bookingId,
              otp: booking.otp,
              otpVerified: booking.otpVerified,
              pickupStop: booking.pickupStop,
              dropOffStop: booking.dropOffStop,
              fareCharged: booking.fareCharged,
              driverFare: getCarpoolDriverFare(booking),
              requiredSeats: booking.requiredSeats ?? 1,
              avgTime: booking.avgTime ?? 0,
              distance: booking.distance ?? 0,
              driver: booking.driver,
            };
          } else {
            socket.join(`booking:${bookingId}`);
            socket.join(`carpool:${bookingId}`);

            response = {
              role: "passenger",
              type: CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
              carpoolId,
              bookingId,
              otp: booking.otp,
              pickupStop: booking.pickupStop,
              dropOffStop: booking.dropOffStop,
              fareCharged: booking.fareCharged,
              driverFare: getCarpoolDriverFare(booking),
              requiredSeats: booking.requiredSeats ?? 1,
              avgTime: booking.avgTime ?? 0,
              distance: booking.distance ?? 0,
              driver: booking.driver,
            };
          }

          socket.emit(CARPOOL_SOCKET_EVENTS.RESUME, response);

          return callback({
            success: true,
            ...response,
          });
        }

        return callback({
          success: false,
          message: "Unhandled carpool state",
        });
      } catch (err) {
        console.error("[carpool:resume] Error:", err);

        return callback({
          success: false,
          message: "Internal server error",
        });
      }
    }),
  );

  /* ── [DRIVER] Create Route ────────────────────────────────── */
  socket.on(
    CARPOOL_SOCKET_EVENTS.CREATE_ROUTE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(
        createCarpoolRouteValidator,
        payload,
        callback,
      );
      if (!data) return;

      try {
        const carpoolRoute = await createCarpoolRouteService(userId, data);

        /* Driver joins the carpool room to receive all passenger events */
        socket.join(`carpool:${carpoolRoute._id}`);

        return ok(
          callback,
          "Carpool route created! Waiting for passengers...",
          { carpoolRoute },
        );
      } catch (err) {
        console.error("Error creating carpool route:", err);
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [DRIVER] Cancel Route ────────────────────────────────── */
  socket.on(
    CARPOOL_SOCKET_EVENTS.CANCEL_ROUTE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(
        cancelCarpoolRouteValidator,
        payload,
        callback,
      );
      if (!data) return;

      try {
        const result = await cancelCarpoolRouteService(userId, data, io);
        socket.leave(`carpool:${data.carpoolId}`);
        return ok(callback, t("CARPOOL_CANCELLED", locale), result);
      } catch (err) {
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [PASSENGER] Find Matching Routes ─────────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.INCOMING_MATCHES,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(
        findCarpoolRoutesValidator,
        payload,
        callback,
      );
      if (!data) return;

      try {
        const matches = await findMatchingCarpoolRoutes(userId, data);

        if (!matches.length) {
          return ok(callback, "No carpool routes found nearby.", {
            routes: [],
          });
        }

        return ok(callback, "Matching carpool routes found.", {
          routes: matches,
        });
      } catch (err) {
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [PASSENGER] Join a Specific Carpool ──────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.JOIN,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(joinCarpoolValidator, payload, callback);
      if (!data) return;

      try {
        /*
         * joinCarpoolService handles socket.join(`booking:<bookingId>`)
         * internally so the passenger receives accept/reject updates
         * scoped to this booking only.
         */
        const booking = await joinCarpoolService(userId, data, io, socket);

        return ok(callback, t("CARPOOL_JOINED_SUCCESS", locale), {
          bookingId: booking._id,
        });
      } catch (err) {
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [PASSENGER] Cancel Booking Request ───────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.CANCEL_REQUEST,
    asyncSocketWrapper(socket, async (payload, callback) => {
      console.log(
        `[CANCEL_REQUEST] User ${userId} attempting to cancel booking`,
        payload,
      );

      const { bookingId } = payload ?? {};
      if (!bookingId) {
        console.log(`[CANCEL_REQUEST] Missing bookingId`);
        return fail(callback, "bookingId is required.");
      }

      try {
        console.log(`[CANCEL_REQUEST] Fetching models and constants`);
        const CarpoolBookingModel = require("./model/carpool-booking.model");
        const CarpoolRouteModel = require("./model/carpool-route.model");
        const {
          CARPOOL_BOOKING_STATUS_ENUM,
          CARPOOL_STATUS_ENUM,
          CARPOOL_SOCKET_EVENTS,
        } = require("../../core/common/constants/carpool-constants");
        const {
          REDIS_CONSTANTS,
        } = require("../../core/common/constants/redis-constants");
        const {
          getRedisConnection,
        } = require("../../core/services/redis/redis.service");
        const {
          chargeCarpoolCancellationFee,
        } = require("./carpool.payment.service");

        const redis = getRedisConnection();
        console.log(`[CANCEL_REQUEST] Redis connection established`);

        const booking = await CarpoolBookingModel.findById(bookingId);

        console.log(
          `[CANCEL_REQUEST] Booking found:`,
          booking?._id,
          `Status: ${booking?.status}`,
        );

        if (!booking) {
          console.log(`[CANCEL_REQUEST] Booking ${bookingId} not found`);
          return fail(callback, "Booking not found.");
        }

        if (booking.passenger.toString() !== userId) {
          console.log(
            `[CANCEL_REQUEST] Unauthorized: booking passenger ${booking.passenger} !== user ${userId}`,
          );
          return fail(callback, "Unauthorized.");
        }

        if (
          ![
            CARPOOL_BOOKING_STATUS_ENUM.PENDING,
            CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
          ].includes(booking.status)
        ) {
          console.log(
            `[CANCEL_REQUEST] Invalid booking status: ${booking.status}`,
          );
          return fail(
            callback,
            "Only pending/accepted bookings can be cancelled by the passenger.",
          );
        }

        console.log(`[CANCEL_REQUEST] Fetching carpool route`);
        const carpoolRoute = await CarpoolRouteModel.findById(
          booking.carpool,
        ).populate("driver", "locale");

        console.log(
          `[CANCEL_REQUEST] Carpool route found:`,
          carpoolRoute?._id,
          `Status: ${carpoolRoute?.status}`,
        );

        if (!carpoolRoute) {
          console.log(`[CANCEL_REQUEST] Carpool route not found`);
          return fail(callback, "Carpool route not found.");
        }

        // if (
        //   [
        //     CARPOOL_STATUS_ENUM.COMPLETED,
        //     CARPOOL_STATUS_ENUM.IN_PROGRESS,
        //   ].includes(carpoolRoute.status) &&
        //   booking.status !== CARPOOL_BOOKING_STATUS_ENUM.PENDING
        // ) {
        //   console.log(
        //     `[CANCEL_REQUEST] Cannot cancel: carpool is ${carpoolRoute.status} and booking is ${booking.status}`,
        //   );
        //   return fail(
        //     callback,
        //     "Cannot cancel booking after the carpool has completed.",
        //   );
        // }

        const driverLocale = carpoolRoute.driver?.locale || locale;
        console.log(`[CANCEL_REQUEST] Driver locale: ${driverLocale}`);

        const originalStatus = booking.status;
        console.log(
          `[CANCEL_REQUEST] Original booking status: ${originalStatus}`,
        );

        booking.status = CARPOOL_BOOKING_STATUS_ENUM.CANCELLED;
        booking.cancelledAt = new Date();
        await booking.save();

        await recordJourneyEventWithDriverLocation(
          {
            journeyType: "carpool",
            journeyId: carpoolRoute._id,
            carpoolId: carpoolRoute._id,
            bookingId: booking._id,
            eventType: "carpool.booking_cancelled",
            phase: "ended",
            actor: { type: "user", id: userId },
            source: "socket",
            transition: {
              from: originalStatus,
              to: CARPOOL_BOOKING_STATUS_ENUM.CANCELLED,
            },
            occurredAt: booking.cancelledAt,
            reasonCode: "PASSENGER_CANCELLED",
            dedupeKey: `carpool:${carpoolRoute._id}:booking:${booking._id}:cancelled`,
          },
          carpoolRoute.driver._id,
        );

        console.log(`[CANCEL_REQUEST] Booking status updated to CANCELLED`);

        let cancellationFee = 0;

        if (originalStatus === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED) {
          console.log(
            `[CANCEL_REQUEST] Processing cancellation fee for accepted booking`,
          );
          try {
            const feeResult = await chargeCarpoolCancellationFee(
              bookingId,
              userId,
            );
            cancellationFee = feeResult?.cancellationFee ?? 0;

            console.log(
              `[CANCEL_REQUEST] Cancellation fee charged:`,
              cancellationFee,
            );

            carpoolRoute.availableSeats += booking.requiredSeats ?? 1;
            console.log(
              `[CANCEL_REQUEST] Available seats updated to: ${carpoolRoute.availableSeats}`,
            );
          } catch (feeErr) {
            console.error(
              `[CANCEL_REQUEST] WARNING: Booking ${bookingId} cancelled but fee charge failed.`,
              feeErr,
            );
          }
        }

        console.log(
          `[CANCEL_REQUEST] Current passengers count: ${carpoolRoute.passengers.length}`,
        );
        const passengerIdx = carpoolRoute.passengers.findIndex(
          (p) => p.bookingId?.toString() === booking._id.toString(),
        );

        if (passengerIdx !== -1) {
          console.log(
            `[CANCEL_REQUEST] Removing passenger at index ${passengerIdx} from the active route roster`,
          );
          carpoolRoute.passengers.splice(passengerIdx, 1);
        } else {
          console.log(
            `[CANCEL_REQUEST] Passenger not found in passengers array`,
          );
        }

        console.log(
          `[CANCEL_REQUEST] Route status before update: ${carpoolRoute.status}`,
        );
        if (carpoolRoute.status === CARPOOL_STATUS_ENUM.FULL) {
          carpoolRoute.status = CARPOOL_STATUS_ENUM.OPEN;
          console.log(`[CANCEL_REQUEST] Route status changed: FULL -> OPEN`);
        } else if (carpoolRoute.status === CARPOOL_STATUS_ENUM.IN_PROGRESS) {
          const totals = carpoolRoute.passengers.filter(
            (passenger) =>
              passenger.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
          ).length;
          console.log(
            `[CANCEL_REQUEST] In-progress route, remaining passengers: ${totals}`,
          );

          if (totals === 0) {
            carpoolRoute.status = CARPOOL_STATUS_ENUM.CANCELLED;
            carpoolRoute.cancelledBy = "user";
            carpoolRoute.cancellationReason = "last_passenger_cancelled";
            carpoolRoute.cancelledAt = new Date();
            console.log(
              `[CANCEL_REQUEST] Route status changed to CANCELLED (no passengers left)`,
            );

            sendNotificationToSpecificUser({
              title: t("CARPOOL_ENDED_TITLE", driverLocale),
              description: t("CARPOOL_ENDED_DESC", driverLocale),
              userIds: [carpoolRoute.driver._id],
              role: "driver",
              metadata: {
                type: "CARPOOL_ENDED",
              },
            });

            await redis.del(
              REDIS_CONSTANTS.keys.driverCarpoolActive(carpoolRoute.driver._id),
            );

            console.log("✅ [CARPOOL ENDED] Notification sent to driver:", {
              carpoolRouteId: carpoolRoute._id,
              driverId: carpoolRoute.driver._id,
            });
          }
        }

        await carpoolRoute.save();
        console.log(`[CANCEL_REQUEST] Carpool route saved successfully`);

        if (carpoolRoute.cancellationReason === "last_passenger_cancelled") {
          await recordJourneyEventWithDriverLocation(
            {
              journeyType: "carpool",
              journeyId: carpoolRoute._id,
              carpoolId: carpoolRoute._id,
              eventType: "carpool.route_cancelled",
              phase: "ended",
              actor: { type: "user", id: userId },
              source: "socket",
              transition: {
                from: CARPOOL_STATUS_ENUM.IN_PROGRESS,
                to: CARPOOL_STATUS_ENUM.CANCELLED,
              },
              occurredAt: carpoolRoute.cancelledAt,
              reasonCode: "last_passenger_cancelled",
              dedupeKey: `carpool:${carpoolRoute._id}:route_cancelled`,
            },
            carpoolRoute.driver._id,
          );
          await handleAssignmentEnded(carpoolRoute.driver._id, io);
        }

        console.log(`[CANCEL_REQUEST] Syncing Redis cache`);
        try {
          const redisPassengerKey =
            REDIS_CONSTANTS.keys.passengerActiveCarpool(userId);
          const redisSeatsKey = REDIS_CONSTANTS.keys.carpoolSeats(
            carpoolRoute._id.toString(),
          );

          console.log(
            `[CANCEL_REQUEST] Deleting Redis key: ${redisPassengerKey}`,
          );
          await redis.del(redisPassengerKey);

          console.log(
            `[CANCEL_REQUEST] Incrementing Redis key: ${redisSeatsKey}`,
          );
          await redis.incr(redisSeatsKey);

          console.log(`[CANCEL_REQUEST] Redis sync completed`);
        } catch (redisErr) {
          console.error(
            `[CANCEL_REQUEST] WARNING: Redis sync failed for booking ${bookingId}`,
            redisErr,
          );
        }

        console.log(
          `[CANCEL_REQUEST] Removing socket from room: booking:${bookingId}`,
        );
        socket.leave(`booking:${bookingId}`);

        const carpoolRoom = `carpool:${booking.carpool.toString()}`;
        console.log(
          `[CANCEL_REQUEST] Emitting ROUTE_UPDATE to room: ${carpoolRoom}`,
        );
        io.to(carpoolRoom).emit(CARPOOL_SOCKET_EVENTS.ROUTE_UPDATE, {
          carpoolId: booking.carpool,
          cancelledBookingId: bookingId,
          availableSeats: carpoolRoute.availableSeats,
          status: carpoolRoute.status,
          wasLastPassenger:
            carpoolRoute.passengers.filter(
              (passenger) =>
                passenger.status === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED,
            ).length === 0,
          cancelledBy: "user",
          reasonCode: "PASSENGER_CANCELLED",
          reason:
            originalStatus === CARPOOL_BOOKING_STATUS_ENUM.ACCEPTED
              ? "Passenger cancelled accepted booking"
              : "Passenger cancelled their request",
          cancellationFee,
        });

        console.log(`[CANCEL_REQUEST] Sending push notification to driver`);
        const notification = await sendNotificationToSpecificUser({
          title: t("NOTIFICATION_USER_CANCELLED_BOOKING_TITLE", driverLocale),
          description: t(
            "NOTIFICATION_USER_CANCELLED_BOOKING_DESC",
            driverLocale,
          ),
          userIds: [carpoolRoute.driver._id],
          role: "driver",
          metadata: {
            type: "CARPOOL_CANCELLED",
          },
        });

        console.log(
          "✅ [NOTIFICATION] Driver notified of cancellation:",
          notification,
        );

        console.log(
          `[CANCEL_REQUEST] Completed successfully for booking ${bookingId}`,
        );

        return ok(callback, t("BOOKING_CANCELLED_SUCCESS", locale), {
          bookingId,
          cancellationFee,
        });
      } catch (err) {
        console.error(`[CANCEL_REQUEST] Error for user ${userId}:`, err);
        console.error(`[CANCEL_REQUEST] Error stack:`, err.stack);
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [DRIVER] Accept / Reject Passenger ───────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.RESPOND,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(carpoolRespondValidator, payload, callback);
      if (!data) return;

      try {
        const result = await respondToPassengerService(
          userId,
          data,
          io,
          socket,
        );
        const actionLabel =
          result.action === "accepted" ? "accepted" : "rejected";
        return ok(callback, `Passenger ${actionLabel}.`, result);
      } catch (err) {
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [DRIVER] Start Carpool ───────────────────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.START,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(carpoolStartValidator, payload, callback);
      if (!data) return;

      try {
        /*
         * Transitions carpool to in_progress and migrates all accepted
         * passengers from their booking rooms into the shared carpool room.
         */
        const result = await startCarpoolService(userId, data, io);
        return ok(
          callback,
          "Carpool started! Passengers have been notified.",
          result,
        );
      } catch (err) {
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [DRIVER] Pick Passenger — OTP Verification ──────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.PICK_PASSENGER,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(
        carpoolPickPassengerValidator,
        payload,
        callback,
      );
      if (!data) return;

      try {
        const result = await measureAsync(
          "carpool.pick_passenger.total",
          { bookingId: data.bookingId, driverId: userId },
          () => pickPassengerService(userId, data, io),
        );
        return ok(callback, "OTP verified. Passenger picked up!", result);
      } catch (err) {
        if (CARPOOL_PAYMENT_ERROR_KEYS.includes(err.message)) {
          return fail(
            callback,
            t("CARPOOL_PASSENGER_PAYMENT_FAILED", locale).replace(
              "${reason}",
              t(err.message, locale),
            ),
          );
        }
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [DRIVER] Complete Ride ───────────────────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.COMPLETE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      const data = validateOrFail(carpoolCompleteValidator, payload, callback);
      if (!data) return;

      try {
        const result = await completeCarpoolRideService(userId, data, io, role);

        /* Once all passengers are done the driver leaves the carpool room */
        if (result.carpoolCompleted) {
          socket.leave(`carpool:${payload.carpoolId}`);
        }

        return ok(
          callback,
          result.carpoolCompleted
            ? "All passengers dropped off. Carpool complete!"
            : "Passenger ride completed.",
          result,
        );
      } catch (err) {
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );

  /* ── [DRIVER] Arrive at Stop ──────────────────────────────── */

  socket.on(
    CARPOOL_SOCKET_EVENTS.ARRIVE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      console.log(`[ARRIVE] User ${userId} arriving at stop`, payload);

      const data = validateOrFail(carpoolArriveValidator, payload, callback);
      if (!data) {
        console.log(`[ARRIVE] Validation failed for payload`, payload);
        return;
      }

      try {
        console.log(`[ARRIVE] Processing arrival for carpool`, data.carpoolId);
        const result = await arriveAtStopService(userId, data, io);

        console.log(`[ARRIVE] Service result:`, result);
        return ok(
          callback,
          result.nextStop
            ? `Arrived at "${result.arrivedStop.placeName}". Next stop: "${result.nextStop.placeName}".`
            : `Arrived at "${result.arrivedStop.placeName}". This is the last stop.`,
          result,
        );
      } catch (err) {
        console.error(`[ARRIVE] Error for user ${userId}:`, err);
        return fail(callback, resolveErrorMessage(err, locale), err.message);
      }
    }),
  );
};
