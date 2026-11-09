const DriverShiftModel = require("./models/driver-shift.model");
const DriverModel = require("./models/driver.model");
const RideModel = require("../ride/model/ride.model");
const CarpoolRouteModel = require("../carpool/model/carpool-route.model");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  DRIVER,
  SOCKET,
  RIDE_STATUS,
} = require("../../core/common/constants/ride-constants");
const {
  CARPOOL_STATUS_ENUM,
} = require("../../core/common/constants/carpool-constants");
const { t } = require("../../core/common/helpers");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const {
  ELEVEN_HOURS_MIN,
  TWELVE_HOURS_MIN,
  SHIFT_LIMIT_ACTION,
  getShiftLimitAction,
  getBreakEndTimestamp,
} = require("./driver-shift.policy");

const redis = getRedisConnection();

const SIX_HOURS_MIN = 6 * 60;

function nowUtc() {
  return new Date();
}

async function getLatestShift(driverId) {
  return DriverShiftModel.findOne({ driverId }).sort({ lastSyncTime: -1 });
}

function settleElapsedMinutes(shift, now) {
  const lastSync = shift.lastSyncTime || shift.startTime;
  if (!lastSync) return 0;

  const diffMinutes = Math.floor((now - new Date(lastSync)) / (1000 * 60));
  if (diffMinutes > 0) {
    shift.totalMinutes += diffMinutes;
  }
  shift.lastSyncTime = now;
  return Math.max(diffMinutes, 0);
}

async function getActiveAssignment(driverId) {
  // Mongo is authoritative here so a missing or stale Redis cache key cannot
  // interrupt a live assignment or defer offline forever.
  const [activeRide, activeCarpool] = await Promise.all([
    RideModel.findOne({
      driver: driverId,
      rideStatus: {
        $in: [
          RIDE_STATUS.ACCEPTED,
          RIDE_STATUS.ARRIVED,
          RIDE_STATUS.COMING,
          RIDE_STATUS.IN_PROGRESS,
        ],
      },
    })
      .select("_id")
      .lean(),
    CarpoolRouteModel.findOne({
      driver: driverId,
      status: {
        $in: [
          CARPOOL_STATUS_ENUM.OPEN,
          CARPOOL_STATUS_ENUM.FULL,
          CARPOOL_STATUS_ENUM.IN_PROGRESS,
        ],
      },
    })
      .select("_id")
      .lean(),
  ]);

  const activeRideId = activeRide?._id?.toString() || null;
  const activeCarpoolId = activeCarpool?._id?.toString() || null;

  return {
    activeRideId,
    activeCarpoolId,
    hasActiveAssignment: Boolean(activeRideId || activeCarpoolId),
  };
}

async function cacheShiftState(driverId, totalMinutes, status) {
  const pipeline = redis.pipeline();
  pipeline.set(
    REDIS_CONSTANTS.keys.driverShiftMinutes(driverId),
    String(totalMinutes),
  );
  pipeline.set(REDIS_CONSTANTS.keys.driverShiftStatus(driverId), status);
  await pipeline.exec();
}

async function clearOnlinePresence(driverId) {
  const pipeline = redis.pipeline();
  pipeline.zrem(REDIS_CONSTANTS.DRIVER_GEO_KEY, driverId);
  pipeline.del(REDIS_CONSTANTS.keys.driverActive(driverId));
  pipeline.del(REDIS_CONSTANTS.keys.driverCarpoolActive(driverId));
  pipeline.hset(REDIS_CONSTANTS.keys.driverHash(driverId), {
    status: "offline",
  });
  await pipeline.exec();
}

async function sendDriverNotification(driverId, titleKey, descriptionKey) {
  try {
    const driver = await DriverModel.findById(driverId).select("locale");
    const locale = driver?.locale || "en";
    await sendNotificationToSpecificUser({
      title: t(titleKey, locale),
      description: t(descriptionKey, locale),
      userIds: [driverId],
      role: "driver",
      metadata: { type: "DRIVER_SHIFT_LIMIT" },
    });
    return locale;
  } catch (error) {
    console.error("Driver shift notification failed:", error?.message);
    return "en";
  }
}

async function emitForcedOffline(io, driverId, locale = "en", breakStartedAt) {
  const driverSocket = await redis.get(`${DRIVER}:${driverId}:${SOCKET}`);
  const socket = driverSocket ? io?.sockets?.sockets?.get(driverSocket) : null;

  if (socket) {
    socket.emit("SHIFT_EXCEEDED", {
      success: false,
      forceLogout: true,
      message: t("SHIFT_EXCEEDED_FORCED_OFFLINE", locale),
      breakEndTimestamp: getBreakEndTimestamp(breakStartedAt),
    });
  }
}

async function forceDriverOffline(shift, io, now = nowUtc()) {
  // Claim the transition so concurrent cron/completion handlers cannot notify
  // or force the same shift offline more than once.
  const claimedShift = await DriverShiftModel.findOneAndUpdate(
    { _id: shift._id, isActive: true },
    {
      $set: {
        totalMinutes: shift.totalMinutes,
        lastSyncTime: now,
        isExceedsMaxHours: true,
        isPendingForceOffline: false,
        isActive: false,
        endTime: now,
        forcedOfflineAt: now,
        limitReachedAt: shift.limitReachedAt || now,
      },
    },
    { new: true },
  );

  if (!claimedShift) return false;

  const driverId = claimedShift.driverId.toString();
  await clearOnlinePresence(driverId);
  await cacheShiftState(driverId, claimedShift.totalMinutes, "offline");

  const locale = await sendDriverNotification(
    claimedShift.driverId,
    "NOTIFICATION_SAFETY_12_HOUR_LIMIT_TITLE",
    "NOTIFICATION_SAFETY_12_HOUR_LIMIT_DESC",
  );
  await emitForcedOffline(io, driverId, locale, claimedShift.endTime);

  return true;
}

async function markOfflinePending(shift, now) {
  const wasAlreadyPending = shift.isPendingForceOffline === true;
  shift.isExceedsMaxHours = true;
  shift.isPendingForceOffline = true;
  shift.limitReachedAt = shift.limitReachedAt || now;
  shift.endTime = null;
  await shift.save();
  await cacheShiftState(
    shift.driverId.toString(),
    shift.totalMinutes,
    "offline_pending",
  );

  if (!wasAlreadyPending) {
    await sendDriverNotification(
      shift.driverId,
      "NOTIFICATION_SAFETY_12_HOUR_ACTIVE_ASSIGNMENT_TITLE",
      "NOTIFICATION_SAFETY_12_HOUR_ACTIVE_ASSIGNMENT_DESC",
    );
  }
}

async function ensureShiftRecordOnOnline(driverId, locale = "en") {
  const now = nowUtc();
  let shift = await getLatestShift(driverId);

  if (!shift) {
    shift = await DriverShiftModel.create({
      driverId,
      startTime: now,
      isActive: true,
      totalMinutes: 0,
      lastSyncTime: now,
    });
    await cacheShiftState(driverId, 0, "online");
    return { shift, allowed: true };
  }

  let breakMinutes = 0;
  if (shift.endTime) {
    breakMinutes = Math.floor((now - new Date(shift.endTime)) / (1000 * 60));
  }

  if (breakMinutes >= SIX_HOURS_MIN) {
    if (shift.isActive) {
      shift.isActive = false;
      await shift.save();
    }
    const newShift = await DriverShiftModel.create({
      driverId,
      startTime: now,
      isActive: true,
      totalMinutes: 0,
      lastSyncTime: now,
      isExceedsMaxHours: false,
      isPendingForceOffline: false,
    });
    await cacheShiftState(driverId, 0, "online");
    return { shift: newShift, allowed: true };
  }

  // A reconnect must not interrupt the assignment that caused offline to be
  // deferred. The driver remains online only for that existing assignment;
  // the assignment guards still prevent any new work.
  if (shift.isPendingForceOffline) {
    const { hasActiveAssignment } = await getActiveAssignment(driverId);
    if (hasActiveAssignment) {
      shift.isActive = true;
      shift.endTime = null;
      shift.lastSyncTime = now;
      await shift.save();
      await cacheShiftState(driverId, shift.totalMinutes, "offline_pending");
      return { shift, allowed: true, pendingForceOffline: true };
    }

    await forceDriverOffline(shift, null, now);
    shift = (await getLatestShift(driverId)) || shift;
  }

  if (
    shift.totalMinutes >= TWELVE_HOURS_MIN &&
    shift.isExceedsMaxHours === true
  ) {
    return {
      shift,
      allowed: false,
      reason: t("SHIFT_EXCEEDED_ONLINE", locale),
      breakEndTimestamp: getBreakEndTimestamp(shift.endTime),
    };
  }

  shift.isActive = true;
  shift.endTime = null;
  shift.lastSyncTime = now;
  if (!shift.startTime) {
    shift.startTime = now;
  }
  await shift.save();
  await cacheShiftState(driverId, shift.totalMinutes, "online");
  return { shift, allowed: true };
}

async function handleGoOffline(driverId, io) {
  const shift = await getLatestShift(driverId);
  if (!shift || !shift.isActive) return { offline: false };

  const now = nowUtc();
  settleElapsedMinutes(shift, now);

  if (shift.totalMinutes >= TWELVE_HOURS_MIN) {
    shift.isExceedsMaxHours = true;
    shift.limitReachedAt = shift.limitReachedAt || now;
    await shift.save();
  }

  const { hasActiveAssignment } = await getActiveAssignment(driverId);

  if (hasActiveAssignment) {
    if (shift.totalMinutes >= TWELVE_HOURS_MIN) {
      await markOfflinePending(shift, now);
    } else {
      await shift.save();
      await cacheShiftState(driverId, shift.totalMinutes, "online");
    }
    return { offline: false, deferred: true };
  }

  if (shift.totalMinutes >= TWELVE_HOURS_MIN) {
    await forceDriverOffline(shift, io, now);
    return { offline: true, forced: true };
  }

  shift.isActive = false;
  shift.endTime = now;
  shift.lastSyncTime = now;
  await shift.save();
  await cacheShiftState(driverId, shift.totalMinutes, "offline");
  return { offline: true, forced: false };
}

async function canDriverCreateCarpool(driverId, locale = "en") {
  const shift = await getLatestShift(driverId);
  if (!shift) return { allowed: true };

  const now = nowUtc();
  let breakMinutes = 0;
  if (shift.endTime) {
    breakMinutes = Math.floor((now - new Date(shift.endTime)) / (1000 * 60));
  }

  if (shift.isExceedsMaxHours && breakMinutes < SIX_HOURS_MIN) {
    return {
      allowed: false,
      reason: t("SHIFT_EXCEEDED_CARPOOL", locale),
      breakEndTimestamp: getBreakEndTimestamp(shift.endTime),
    };
  }
  return { allowed: true };
}

async function canDriverAcceptAssignment(driverId, locale = "en") {
  const shift = await getLatestShift(driverId);
  if (!shift?.isExceedsMaxHours || shift.totalMinutes < TWELVE_HOURS_MIN) {
    return { allowed: true };
  }

  const breakMinutes = shift.endTime
    ? Math.floor((nowUtc() - new Date(shift.endTime)) / (1000 * 60))
    : 0;

  if (breakMinutes < SIX_HOURS_MIN) {
    return {
      allowed: false,
      reason: t("SHIFT_EXCEEDED_ONLINE", locale),
      breakEndTimestamp: getBreakEndTimestamp(shift.endTime),
    };
  }

  return { allowed: true };
}

async function handleAssignmentEnded(driverId, io) {
  if (!driverId) return false;

  const shift = await getLatestShift(driverId);
  if (!shift?.isActive || !shift.isPendingForceOffline) return false;

  const { hasActiveAssignment } = await getActiveAssignment(driverId);
  if (hasActiveAssignment) return false;

  const now = nowUtc();
  settleElapsedMinutes(shift, now);
  return forceDriverOffline(shift, io, now);
}

async function processActiveShifts(io) {
  const now = nowUtc();
  const activeShifts = await DriverShiftModel.find({ isActive: true });

  for (const shift of activeShifts) {
    if (settleElapsedMinutes(shift, now) <= 0) continue;

    const shouldWarn =
      shift.totalMinutes >= ELEVEN_HOURS_MIN && !shift.isWarned11h;
    const hasReachedLimit = shift.totalMinutes >= TWELVE_HOURS_MIN;

    if (shouldWarn) {
      shift.isWarned11h = true;
    }
    if (hasReachedLimit) {
      shift.isExceedsMaxHours = true;
      shift.limitReachedAt = shift.limitReachedAt || now;
    }
    if (shouldWarn || hasReachedLimit) {
      // Persist the block before checking assignment state so no new work can
      // be accepted in the handoff window.
      await shift.save();
    }

    if (shouldWarn) {
      await sendDriverNotification(
        shift.driverId,
        "NOTIFICATION_SAFETY_11_HOUR_WARNING_TITLE",
        "NOTIFICATION_SAFETY_11_HOUR_WARNING_DESC",
      );
    }

    let action = SHIFT_LIMIT_ACTION.CONTINUE;
    if (hasReachedLimit) {
      const { hasActiveAssignment } = await getActiveAssignment(
        shift.driverId.toString(),
      );
      action = getShiftLimitAction(shift.totalMinutes, hasActiveAssignment);
    }

    if (action === SHIFT_LIMIT_ACTION.DEFER_OFFLINE) {
      await markOfflinePending(shift, now);
      continue;
    }

    if (action === SHIFT_LIMIT_ACTION.FORCE_OFFLINE) {
      shift.isExceedsMaxHours = true;
      shift.limitReachedAt = shift.limitReachedAt || now;
      await forceDriverOffline(shift, io, now);
      continue;
    }

    await shift.save();
    await cacheShiftState(
      shift.driverId.toString(),
      shift.totalMinutes,
      "online",
    );
  }
}

module.exports = {
  ensureShiftRecordOnOnline,
  handleGoOffline,
  canDriverCreateCarpool,
  canDriverAcceptAssignment,
  handleAssignmentEnded,
  processActiveShifts,
};
