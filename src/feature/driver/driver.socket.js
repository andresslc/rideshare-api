const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  DRIVER_SOCKET_EVENTS,
  COMMON_SOCKET_EVENTS,
  DRIVER,
  RIDE_SOCKET_EVENTS,
  SOCKET,
  STATUS,
  RIDE,
  ACTIVE,
  DESTINATION,
  DESTINATION_PROXIMITY_THRESHOLD,
  PICKUP,
} = require("../../core/common/constants/ride-constants");
const {
  ensureShiftRecordOnOnline,
  handleGoOffline,
} = require("./driver-shift.service");
const asyncSocketWrapper = require("../../core/common/socket-async");
const { t, isUserOnAuthenticatedDevice } = require("../../core/common/helpers");
const {
  driverLocationUpdateValidator,
} = require("./dto/driverSocket.validator");
const DriverModel = require("./models/driver.model");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const RideOfferModel = require("../ride/model/ride-offer.model");
const { default: mongoose } = require("mongoose");
const {
  recordSampledJourneyLocation,
} = require("../journey-log/journey-log.service");
const {
  acquireAssignmentLock,
  releaseAssignmentLock,
} = require("../ride/assignment-lock.helper");
const {
  cancelPendingOffersForDriver,
} = require("../ride/ride-offer-state.helper");

const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");

const redis = getRedisConnection();
const DRIVER_GEO_KEY = "drivers:geo";

module.exports = (io, socket) => {
  const driverId = socket.user._id.toString();
  const driverType = socket.user.vehicleType;
  const locale = socket.user.locale;
  const loggedId = socket.loggedId;
  const driverHashKey = `${DRIVER}:${driverId}`;

  const getActiveAssignment = async () => {
    const [activeRideId, activeCarpoolRideId] = await Promise.all([
      redis.get(`${DRIVER}:${driverId}:${RIDE}:${ACTIVE}`),
      redis.get(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId)),
    ]);

    return { activeRideId, activeCarpoolRideId };
  };

  // A reconnect can overlap the previous socket's disconnect. The connection
  // key is authoritative until the driver hash is refreshed by driver:online.
  const isCurrentDriverSocket = async () => {
    const [connectionSocketId, presenceSocketId] = await Promise.all([
      redis.get(`${DRIVER}:${driverId}:${SOCKET}`),
      redis.hget(driverHashKey, "socket"),
    ]);

    if (connectionSocketId) return connectionSocketId === socket.id;
    return !presenceSocketId || presenceSocketId === socket.id;
  };

  socket.use(async ([event, ...args], next) => {
    const isAuthenticated = await isUserOnAuthenticatedDevice(
      driverId,
      loggedId,
    );
    if (!isAuthenticated) {
      socket.emit("error", {
        message: "Unauthorized - Please re-login on a valid device",
      });
      return socket.disconnect();
    }
    next();
  });

  // ─── SET_ONLINE ──────────────────────────────────────────────────────────────
  socket.on(
    DRIVER_SOCKET_EVENTS.SET_ONLINE,
    asyncSocketWrapper(socket, async (payload, callback) => {
      console.log("HIT:" + DRIVER_SOCKET_EVENTS.SET_ONLINE);

      if (!(await isCurrentDriverSocket())) {
        return callback?.({
          success: true,
          message: "Driver session has been superseded",
          data: null,
        });
      }

      // Enforce shift rules before bringing driver online
      const { allowed, reason, breakEndTimestamp } =
        await ensureShiftRecordOnOnline(driverId, locale);
      if (!allowed) {
        io.to(driverId).emit("SHIFT_EXCEEDED", {
          success: false,
          forceLogout: true,
          message: reason || t("SHIFT_EXCEEDED_FORCED_OFFLINE", locale),
          breakEndTimestamp,
        });
        return callback({
          success: false,
          message: reason,
          data: { breakEndTimestamp },
        });
      }

      const pipeline = redis.pipeline();

      // Write socket id, status, and vehicle type together into one hash.
      // SET_OFFLINE reads/updates this same hash key — they must stay consistent.
      pipeline.hset(`${DRIVER}:${driverId}`, {
        socket: socket.id,
        status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
        vehicleType: driverType,
      });

      await pipeline.exec();

      return callback({
        success: true,
        message: "Driver is online",
        data: null,
      });
    }),
  );

  /*
        DRIVER LOCATION UPDATE
    */
  socket.on(
    DRIVER_SOCKET_EVENTS.UPDATE_DRIVER_LOC,
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
      let reachedDestination = false;
      const { location } = parsed.data;
      const [lng, lat] = location.coordinates;

      const { activeRideId, activeCarpoolRideId } = await getActiveAssignment();
      const pipeline = redis.pipeline();
      pipeline.geoadd(DRIVER_GEO_KEY, lng, lat, driverId);

      // An in-ride location update also restores live-map presence after the
      // mobile client reconnects.
      if (activeRideId || activeCarpoolRideId) {
        pipeline.hset(driverHashKey, {
          socket: socket.id,
          status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
          vehicleType: driverType,
        });
      }

      await pipeline.exec();

      if (activeRideId) {
        const rideRoom = `${RIDE}:${activeRideId}`;

        // Check if driver has reached the destination
        const result = await redis.geosearch(
          `${RIDE}:${activeRideId}:${DESTINATION}`,
          REDIS_CONSTANTS.FROMLONLAT,
          lng,
          lat,
          REDIS_CONSTANTS.BYRADIUS,
          DESTINATION_PROXIMITY_THRESHOLD,
          REDIS_CONSTANTS.KM,
        );

        const pickupResult = await redis.geosearch(
          `${RIDE}:${activeRideId}:${PICKUP}`,
          REDIS_CONSTANTS.FROMLONLAT,
          lng,
          lat,
          REDIS_CONSTANTS.BYRADIUS,
          DESTINATION_PROXIMITY_THRESHOLD,
          REDIS_CONSTANTS.KM,
        );

        if (pickupResult.length > 0) {
          // Guard: only send once per ride — NX means "set only if Not eXists"
          const pickupNotifKey = `${RIDE}:${activeRideId}:driver:${driverId}:pickup_notif_sent`;
          const alreadySent = await redis.set(
            pickupNotifKey,
            "1",
            "EX",
            3600,
            "NX",
          );
          if (alreadySent) {
            sendNotificationToSpecificUser({
              title: t("ARRIVED_AT_STOP", locale),
              description: t("ARRIVED_AT_STOP_DESC", locale),
              userIds: [driverId],
              metadata: {
                type: "RIDE_PICKUP_REACHED",
                id: activeRideId,
              },
            });
          }
        }

        if (result.length > 0) {
          reachedDestination = true;

          // Guard: only send once per ride — NX means "set only if Not eXists"
          const destNotifKey = `${RIDE}:${activeRideId}:driver:${driverId}:dest_notif_sent`;
          const alreadySent = await redis.set(
            destNotifKey,
            "1",
            "EX",
            3600,
            "NX",
          );
          if (alreadySent) {
            sendNotificationToSpecificUser({
              title: t("ARRIVED_AT_DESTINATION", locale),
              description: t("ARRIVED_AT_DESTINATION_DESC", locale),
              userIds: [driverId],
              metadata: {
                type: "RIDE_DESTINATION_REACHED",
                id: activeRideId,
              },
            });
          }
        }

        io.to(rideRoom).emit(DRIVER_SOCKET_EVENTS.UPDATE_DRIVER_LOC, {
          driver: driverId,
          coordinates: [lng, lat],
          eta: parsed.data?.eta || null,
          timestamp: Date.now(),
        });
      }

      if (activeCarpoolRideId) {
        const carpoolRoom = `carpool:${activeCarpoolRideId}`;

        io.to(carpoolRoom).emit(DRIVER_SOCKET_EVENTS.UPDATE_DRIVER_LOC, {
          driver: driverId,
          coordinates: [lng, lat],
          eta: parsed.data?.eta || null,
          timestamp: Date.now(),
        });
      }

      // Persist a low-frequency breadcrumb without changing the client update
      // contract. Redis gates each active journey to one MongoDB write every
      // configured interval (three minutes by default).
      const journeyLocationWrites = [];
      if (activeRideId) {
        journeyLocationWrites.push(
          recordSampledJourneyLocation({
            journeyType: "ride",
            journeyId: activeRideId,
            driverId,
            location,
          }),
        );
      }
      if (activeCarpoolRideId) {
        journeyLocationWrites.push(
          recordSampledJourneyLocation({
            journeyType: "carpool",
            journeyId: activeCarpoolRideId,
            driverId,
            location,
          }),
        );
      }

      if (journeyLocationWrites.length > 0) {
        // Do not make the existing live-location acknowledgement wait for
        // audit persistence. Rejections are contained and reported here.
        void Promise.allSettled(journeyLocationWrites).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error(
                "Journey location sampling failed:",
                result.reason?.message || result.reason,
              );
            }
          }
        });
      }

      if (callback) {
        return callback({
          success: true,
          message: "Driver's location caught!",
          data: {
            reachedDestination,
          },
        });
      }
    }),
  );

  /*
      DRIVER DISCONNECT
    */
  // ─── SET_OFFLINE ─────────────────────────────────────────────────────────────
  socket.on(DRIVER_SOCKET_EVENTS.SET_OFFLINE, async (_, callback) => {
    let assignmentLock;
    try {
      if (!(await isCurrentDriverSocket())) {
        return callback?.({
          success: true,
          message: "Driver session has been superseded",
          data: null,
        });
      }

      assignmentLock = await acquireAssignmentLock(redis, driverId);
      if (!assignmentLock) {
        return callback?.({
          success: false,
          message: t("ASSIGNMENT_IN_PROGRESS", locale),
          data: null,
        });
      }

      // This must be checked while holding the same lock used by offer
      // acceptance. If acceptance won, going offline is deferred; if offline
      // won, its pending-offer cancellations win the compare-and-set race.
      const { activeRideId, activeCarpoolRideId } = await getActiveAssignment();
      if (activeRideId || activeCarpoolRideId) {
        await redis.hset(driverHashKey, {
          socket: socket.id,
          status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
          vehicleType: driverType,
        });

        return callback?.({
          success: true,
          message: "Driver remains online while an assignment is active",
          data: {
            activeRideId: activeRideId || null,
            activeCarpoolRideId: activeCarpoolRideId || null,
          },
        });
      }

      // Decide all pending offers before changing presence. A simultaneous
      // acceptance either already owns the offer (and is detected below) or
      // loses its pending -> accepted compare-and-set.
      await cancelPendingOffersForDriver(
        RideOfferModel,
        new mongoose.Types.ObjectId(driverId),
      );

      const acceptedOfferInProgress = await RideOfferModel.exists({
        driver: new mongoose.Types.ObjectId(driverId),
        status: "accepted",
      });
      if (acceptedOfferInProgress) {
        await redis.hset(driverHashKey, {
          socket: socket.id,
          status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
          vehicleType: driverType,
        });
        return callback?.({
          success: true,
          message: "Driver remains online while an assignment is active",
          data: null,
        });
      }

      const shiftTransition = await handleGoOffline(driverId, io);
      if (shiftTransition?.deferred) {
        await redis.hset(driverHashKey, {
          socket: socket.id,
          status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
          vehicleType: driverType,
        });
        return callback?.({
          success: true,
          message: "Driver remains online while an assignment is active",
          data: null,
        });
      }

      // Get last location BEFORE removing from GEO
      const position = await redis.geopos(DRIVER_GEO_KEY, driverId);

      const pipeline = redis.pipeline();

      // Remove from the geo index so the driver no longer appears in geosearch
      // pipeline.zrem(DRIVER_GEO_KEY, driverId);

      // Update the SAME hash that createRideRequestService reads via hgetall.
      // Previously this wrote to a separate string key (`DRIVER:id:STATUS`)
      // which hgetall never sees — the hash status was never updated to "offline",
      // so drivers kept receiving rides after going offline.
      pipeline.hset(`${DRIVER}:${driverId}`, {
        status: "offline",
        socket: "", // clear socket id so stale emit targets are dead
      });

      await pipeline.exec();

      // Persist last known location to DB
      if (position && position[0]) {
        console.log("Updating driver location in DB for driver:", driverId);

        const [lng, lat] = position[0];

        await DriverModel.findByIdAndUpdate(driverId, {
          currentLocation: {
            type: "Point",
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
        });
      }

      console.log("Driver offline:", driverId);

      return callback({
        success: true,
        message: "Driver is offline",
        data: null,
      });
    } catch (error) {
      console.error("Driver offline error:", error);
      return callback({
        success: false,
        message: "Failed to set driver offline",
        data: null,
      });
    } finally {
      await releaseAssignmentLock(redis, assignmentLock);
    }
  });

  socket.on(COMMON_SOCKET_EVENTS.DISCONNECT, async () => {
    try {
      if (!(await isCurrentDriverSocket())) {
        console.log("Ignoring stale driver disconnect:", driverId, socket.id);
        return;
      }

      const { activeRideId, activeCarpoolRideId } = await getActiveAssignment();
      if (activeRideId || activeCarpoolRideId) {
        // Keep the last known geo point visible for the active assignment. A
        // reconnect or the next location update replaces the socket id.
        await redis.hset(driverHashKey, {
          socket: "",
          status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
          vehicleType: driverType,
        });
        return;
      }

      const shiftTransition = await handleGoOffline(driverId, io);
      if (shiftTransition?.deferred) {
        await redis.hset(driverHashKey, {
          socket: "",
          status: DRIVER_SOCKET_EVENTS.ONLINE_STATUS,
          vehicleType: driverType,
        });
        return;
      }

      // Get last location BEFORE removing from GEO
      const position = await redis.geopos(DRIVER_GEO_KEY, driverId);

      const pipeline = redis.pipeline();

      // Remove from the geo index so the driver no longer appears in geosearch
      pipeline.zrem(DRIVER_GEO_KEY, driverId);

      // Update the SAME hash that createRideRequestService reads via hgetall.
      // Previously this wrote to a separate string key (`DRIVER:id:STATUS`)
      // which hgetall never sees — the hash status was never updated to "offline",
      // so drivers kept receiving rides after going offline.
      pipeline.hset(`${DRIVER}:${driverId}`, {
        status: "offline",
        socket: "", // clear socket id so stale emit targets are dead
      });

      await pipeline.exec();

      // Persist last known location to DB
      if (position && position[0]) {
        console.log("Updating driver location in DB for driver:", driverId);

        const [lng, lat] = position[0];

        await DriverModel.findByIdAndUpdate(driverId, {
          currentLocation: {
            type: "Point",
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
        });
      }

      console.log("Driver offline:", driverId);
    } catch (error) {
      console.error("Driver offline error:", error);
    }
  });
};
