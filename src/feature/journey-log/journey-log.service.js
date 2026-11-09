const JourneyEventModel = require("./model/journey-event.model");
const JourneyLocationModel = require("./model/journey-location.model");
const RideModel = require("../ride/model/ride.model");
const CarpoolRouteModel = require("../carpool/model/carpool-route.model");
const CarpoolBookingModel = require("../carpool/model/carpool-booking.model");
const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const { NotFoundError } = require("../../core/common/exceptions");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const { JOURNEY_LOGGING } = require("../../../config");
const { normalizeLocation } = require("./journey-log.helpers");
const {
  buildJourneyTimelineResponse,
} = require("./journey-timeline.presenter");
const {
  getInternalIdentityEmailFilter,
  shouldRestrictInternalData,
} = require("../admin/admin-data-visibility.helper");

const redis = getRedisConnection();

async function getLatestDriverLocation(driverId) {
  if (!driverId) return null;
  const positions = await redis.geopos(
    REDIS_CONSTANTS.DRIVER_GEO_KEY,
    driverId.toString(),
  );
  if (!positions?.[0]) return null;

  return normalizeLocation({ coordinates: positions[0] });
}

async function recordJourneyEvent(data, options = {}) {
  const document = {
    ...data,
    occurredAt: data.occurredAt || new Date(),
    receivedAt: new Date(),
    location: normalizeLocation(data.location),
  };

  try {
    if (options.session) {
      const [event] = await JourneyEventModel.create([document], {
        session: options.session,
      });
      return event;
    }
    return await JourneyEventModel.create(document);
  } catch (error) {
    if (error?.code === 11000 && document.dedupeKey) {
      return JourneyEventModel.findOne({ dedupeKey: document.dedupeKey });
    }
    throw error;
  }
}

async function recordJourneyEventWithDriverLocation(
  data,
  driverId,
  options = {},
) {
  let location = normalizeLocation(data.location);
  let locationSource = data.locationSource || null;

  if (!location && driverId) {
    location = await getLatestDriverLocation(driverId);
    if (location) locationSource = "latest_driver_location";
  }

  return recordJourneyEvent(
    {
      ...data,
      location,
      locationSource,
    },
    options,
  );
}

function sampleKey(journeyType, journeyId) {
  return `journey:location:sample:${journeyType}:${journeyId}`;
}

async function recordSampledJourneyLocation({
  journeyType,
  journeyId,
  driverId,
  location,
  observedAt,
  phase,
  accuracyM,
  speedMps,
  heading,
}) {
  const normalizedLocation = normalizeLocation(location);
  if (!normalizedLocation || !journeyId || !driverId) return null;

  const key = sampleKey(journeyType, journeyId);
  const acquired = await redis.set(
    key,
    new Date().toISOString(),
    "EX",
    JOURNEY_LOGGING.LOCATION_SAMPLE_INTERVAL_SECONDS,
    "NX",
  );
  if (!acquired) return null;

  try {
    let resolvedPhase = phase;

    if (journeyType === "ride" && !resolvedPhase) {
      // This read only happens after the three-minute gate is acquired. It
      // keeps the route-to-pickup separate from the passenger's actual trip.
      const RideModel = require("../ride/model/ride.model");
      const ride = await RideModel.findById(journeyId)
        .select("rideStatus")
        .lean();
      resolvedPhase = {
        accepted: "to_pickup",
        arrived: "waiting_pickup",
        coming: "waiting_pickup",
        "in-progress": "on_trip",
      }[ride?.rideStatus];
      if (!resolvedPhase) return null;
    }

    if (journeyType === "carpool") {
      const cachedRoute = await redis.get(
        REDIS_CONSTANTS.keys.carpoolRoute(journeyId.toString()),
      );
      let routeStatus = cachedRoute ? JSON.parse(cachedRoute).status : null;

      // Redis is the fast path. A missing snapshot should not create a gap in
      // the audit trail when the route is still active in MongoDB.
      if (!routeStatus) {
        const CarpoolRouteModel = require("../carpool/model/carpool-route.model");
        const route = await CarpoolRouteModel.findById(journeyId)
          .select("status")
          .lean();
        routeStatus = route?.status;
      }

      if (routeStatus !== "in_progress") return null;
      resolvedPhase = resolvedPhase || "on_trip";
    }

    return await JourneyLocationModel.create({
      journeyType,
      journeyId,
      driverId,
      observedAt: observedAt || new Date(),
      ingestedAt: new Date(),
      location: normalizedLocation,
      phase: resolvedPhase,
      accuracyM,
      speedMps,
      heading,
      sampleReason: "interval",
    });
  } catch (error) {
    // If MongoDB is temporarily unavailable, let the next live update retry
    // immediately instead of losing the entire sampling window.
    await redis.del(key);
    throw error;
  }
}

async function clearJourneyLocationSample(journeyType, journeyId) {
  if (!journeyId) return;
  await redis.del(sampleKey(journeyType, journeyId));
}

function loadJourneyContext(journeyType, journeyId, restrictedIdentityIds) {
  const { userIds = [], driverIds = [] } = restrictedIdentityIds;
  if (journeyType === "ride") {
    return RideModel.findOne({
      _id: journeyId,
      ...(userIds.length > 0 && { user: { $nin: userIds } }),
      ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
    })
      .select(
        "user driver rideType pickupPoint.placeName pickupPoint.location dropOffPointRequested.placeName dropOffPointRequested.location dropOffPoint.placeName dropOffPoint.location",
      )
      .lean()
      .then((ride) => ({ ride, route: null, bookings: [] }));
  }

  return Promise.all([
    CarpoolRouteModel.findOne({
      _id: journeyId,
      ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
    })
      .select(
        "driver startingPoint.placeName startingPoint.location destination.placeName destination.location routes._id routes.placeName routes.location",
      )
      .lean(),
    CarpoolBookingModel.find({
      carpool: journeyId,
      ...(userIds.length > 0 && { passenger: { $nin: userIds } }),
      ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
    })
      .select(
        "passenger pickupStop.placeName pickupStop.location dropOffStop.placeName dropOffStop.location",
      )
      .lean(),
  ]).then(([route, bookings]) => ({ ride: null, route, bookings }));
}

function addId(target, value) {
  if (value) target.add(value.toString());
}

async function loadTimelineRelations(events, context) {
  const userIds = new Set();
  const driverIds = new Set();

  addId(userIds, context.ride?.user);
  addId(driverIds, context.ride?.driver);
  addId(driverIds, context.route?.driver);

  for (const booking of context.bookings) {
    addId(userIds, booking.passenger);
  }

  for (const event of events) {
    if (event.actor?.type === "user") addId(userIds, event.actor.id);
    if (event.actor?.type === "driver") addId(driverIds, event.actor.id);
  }

  const [users, drivers] = await Promise.all([
    userIds.size
      ? UserModel.find({ _id: { $in: [...userIds] } })
          .select("firstName lastName email phone profilePicture")
          .lean()
      : [],
    driverIds.size
      ? DriverModel.find({ _id: { $in: [...driverIds] } })
          .select("firstName lastName email phone profilePicture vehicleType")
          .lean()
      : [],
  ]);

  return { users, drivers };
}

async function getJourneyTimeline(journeyType, journeyId, options = {}) {
  const restrictInternalData = shouldRestrictInternalData(options.adminUser);
  const restrictedIdentityIds = { userIds: [], driverIds: [] };

  if (restrictInternalData) {
    const internalEmailFilter = getInternalIdentityEmailFilter();
    const [users, drivers] = await Promise.all([
      UserModel.find(internalEmailFilter).select("_id").lean(),
      DriverModel.find(internalEmailFilter).select("_id").lean(),
    ]);
    restrictedIdentityIds.userIds = users.map((user) => user._id);
    restrictedIdentityIds.driverIds = drivers.map((driver) => driver._id);
  }

  const eventQuery = JourneyEventModel.find({ journeyType, journeyId })
    .select(
      "eventType actor transition occurredAt location locationSource locationAccuracyM references.routeStopId amount reasonCode metadata.stopName bookingId",
    )
    .sort({ occurredAt: -1, _id: -1 })
    .lean();

  const locationQuery = JourneyLocationModel.find({ journeyType, journeyId })
    .select("observedAt location accuracyM")
    .sort({ observedAt: -1, _id: -1 })
    .lean();

  const [rawEvents, locations, context, restrictedBookings] = await Promise.all(
    [
      eventQuery,
      locationQuery,
      loadJourneyContext(journeyType, journeyId, restrictedIdentityIds),
      restrictInternalData && journeyType === "carpool"
        ? CarpoolBookingModel.find({
            carpool: journeyId,
            $or: [
              { passenger: { $in: restrictedIdentityIds.userIds } },
              { driver: { $in: restrictedIdentityIds.driverIds } },
            ],
          })
            .select("_id")
            .lean()
        : [],
    ],
  );

  if (restrictInternalData && !context.ride && !context.route) {
    throw new NotFoundError("Journey not found");
  }

  const restrictedUsers = new Set(restrictedIdentityIds.userIds.map(String));
  const restrictedDrivers = new Set(
    restrictedIdentityIds.driverIds.map(String),
  );
  const restrictedBookingIds = new Set(
    restrictedBookings.map(({ _id }) => String(_id)),
  );
  const events = rawEvents.filter((event) => {
    if (
      event.actor?.type === "user" &&
      restrictedUsers.has(event.actor.id?.toString())
    ) {
      return false;
    }
    if (
      event.actor?.type === "driver" &&
      restrictedDrivers.has(event.actor.id?.toString())
    ) {
      return false;
    }
    return !restrictedBookingIds.has(event.bookingId?.toString());
  });

  if (
    !context.ride &&
    !context.route &&
    events.length === 0 &&
    locations.length === 0
  ) {
    throw new NotFoundError("Journey not found");
  }

  const relations = events.length
    ? await loadTimelineRelations(events, context)
    : { users: [], drivers: [] };

  return buildJourneyTimelineResponse({
    events,
    locations,
    context,
    relations,
    groupRadiusM: JOURNEY_LOGGING.EVENT_LOCATION_GROUP_RADIUS_METERS,
  });
}

module.exports = {
  clearJourneyLocationSample,
  getJourneyTimeline,
  getLatestDriverLocation,
  normalizeLocation,
  recordJourneyEvent,
  recordJourneyEventWithDriverLocation,
  recordSampledJourneyLocation,
};
