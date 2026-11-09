const { BUSINESS_TIME_ZONE } = require("../../../config");

const DISPLAY_LOCALE = "en-GB";
const DISPLAY_TIME_ZONE = BUSINESS_TIME_ZONE;
const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function asId(value) {
  return value ? value.toString() : null;
}

function compactName(firstName, lastName, fallback) {
  return [firstName, lastName].filter(Boolean).join(" ").trim() || fallback;
}

function toPerson(document, type) {
  if (!document) return null;

  const fallback = type === "driver" ? "Driver" : "Passenger";
  return {
    id: asId(document._id),
    type,
    name: compactName(document.firstName, document.lastName, fallback),
    firstName: document.firstName || null,
    lastName: document.lastName || null,
    email: document.email || null,
    phone: document.phone || null,
    profilePicture: document.profilePicture || null,
    ...(type === "driver" && {
      vehicleType: document.vehicleType || null,
    }),
  };
}

function mapById(documents, type) {
  return new Map(
    documents.map((document) => [asId(document._id), toPerson(document, type)]),
  );
}

function toPoint(placeName, geoPoint, kind = null) {
  if (!placeName && !geoPoint?.coordinates) return null;

  return {
    name: placeName || null,
    kind,
    coordinates: Array.isArray(geoPoint?.coordinates)
      ? geoPoint.coordinates.map(Number)
      : null,
  };
}

function formatMoney(value, currency = "USD") {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;

  const normalizedCurrency = (currency || "USD").toUpperCase();
  const prefix =
    normalizedCurrency === "USD" ? "US$" : `${normalizedCurrency} `;
  return `${prefix}${numericValue.toFixed(2)}`;
}

function formatTimestamp(value) {
  if (!value) return null;
  const parts = TIMESTAMP_FORMATTER.formatToParts(new Date(value));

  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("day")} ${get("month")}, ${get("hour")}:${get("minute")}`;
}

function coordinatesName(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
  return `${coordinates[1].toFixed(6)}, ${coordinates[0].toFixed(6)}`;
}

function humanize(value) {
  if (!value) return null;
  const result = value
    .toString()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return result.charAt(0).toUpperCase() + result.slice(1);
}

function possessive(name) {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

function getActor(event, userMap, driverMap) {
  const actorType = event.actor?.type || "system";
  const actorId = asId(event.actor?.id);

  if (actorType === "user") {
    return (
      userMap.get(actorId) || {
        id: actorId,
        type: "user",
        name: "Passenger",
      }
    );
  }

  if (actorType === "driver") {
    return (
      driverMap.get(actorId) || {
        id: actorId,
        type: "driver",
        name: "Driver",
      }
    );
  }

  return {
    id: null,
    type: actorType,
    name: actorType === "stripe" ? "Stripe" : "System",
  };
}

function getBookingMap(bookings) {
  return new Map(bookings.map((booking) => [asId(booking._id), booking]));
}

function findRouteStop(route, routeStopId) {
  if (!routeStopId) return null;
  return route?.routes?.find((stop) => asId(stop._id) === asId(routeStopId));
}

function inferNamedPoint(event, context, booking) {
  const eventType = event.eventType;
  const routeStop = findRouteStop(context.route, event.references?.routeStopId);

  if (routeStop) {
    return toPoint(routeStop.placeName, routeStop.location, "route_stop");
  }

  if (event.metadata?.stopName) {
    return toPoint(
      event.metadata.stopName,
      event.metadata.plannedLocation,
      "route_stop",
    );
  }

  if (context.ride) {
    const pickup = toPoint(
      context.ride.pickupPoint?.placeName,
      context.ride.pickupPoint?.location,
      "pickup",
    );
    const dropOffPoint =
      context.ride.dropOffPoint || context.ride.dropOffPointRequested;
    const dropOff = toPoint(
      dropOffPoint?.placeName,
      dropOffPoint?.location,
      "drop_off",
    );

    if (
      [
        "ride.requested",
        "ride.driver_arrived",
        "ride.passenger_coming",
        "ride.otp_failed",
        "ride.otp_verified",
        "ride.payment_initiated",
        "ride.payment_action_required",
        "ride.payment_succeeded",
        "ride.payment_failed",
        "ride.started",
      ].includes(eventType)
    ) {
      return pickup;
    }
    if (eventType === "ride.completed") return dropOff;
  }

  if (context.route) {
    const startingPoint = toPoint(
      context.route.startingPoint?.placeName,
      context.route.startingPoint?.location,
      "route_start",
    );
    const destination = toPoint(
      context.route.destination?.placeName,
      context.route.destination?.location,
      "route_destination",
    );

    if (
      ["carpool.route_created", "carpool.route_started"].includes(eventType)
    ) {
      return startingPoint;
    }
    if (eventType === "carpool.route_completed") return destination;
  }

  if (booking) {
    if (eventType === "carpool.passenger_dropped_off") {
      return toPoint(
        booking.dropOffStop?.placeName,
        booking.dropOffStop?.location,
        "drop_off",
      );
    }
    return toPoint(
      booking.pickupStop?.placeName,
      booking.pickupStop?.location,
      "pickup",
    );
  }

  return null;
}

function buildEventLocation(event, context, booking) {
  const namedPoint = inferNamedPoint(event, context, booking);
  const coordinates = Array.isArray(event.location?.coordinates)
    ? event.location.coordinates.map(Number)
    : namedPoint?.coordinates || null;

  if (!namedPoint && !coordinates) return null;

  return {
    name:
      namedPoint?.name || (coordinates ? coordinatesName(coordinates) : null),
    kind: namedPoint?.kind || "event_location",
    coordinates,
    source: event.locationSource || null,
    accuracyM: event.locationAccuracyM ?? null,
  };
}

function getEventStyle(eventType) {
  if (eventType.includes("payment") || eventType.includes("fee")) {
    if (eventType.includes("failed")) {
      return { category: "payment", icon: "payment", tone: "danger" };
    }
    if (eventType.includes("succeeded")) {
      return { category: "payment", icon: "payment", tone: "success" };
    }
    return { category: "payment", icon: "payment", tone: "warning" };
  }

  if (eventType.includes("otp")) {
    return {
      category: "verification",
      icon: "verification",
      tone: eventType.includes("failed") ? "danger" : "success",
    };
  }

  if (eventType.includes("cancelled") || eventType.includes("rejected")) {
    return { category: "status", icon: "cancelled", tone: "danger" };
  }

  if (eventType.includes("completed") || eventType.includes("dropped_off")) {
    return { category: "status", icon: "completed", tone: "success" };
  }

  if (eventType.includes("arrived") || eventType.includes("coming")) {
    return { category: "location", icon: "location", tone: "info" };
  }

  if (eventType.includes("started") || eventType.includes("picked_up")) {
    return { category: "journey", icon: "vehicle", tone: "success" };
  }

  return { category: "activity", icon: "activity", tone: "info" };
}

function buildEventTitle({
  event,
  actor,
  subject,
  titleContext,
  location,
  amount,
}) {
  const actorName = actor?.name || "System";
  const passengerName =
    subject?.name || titleContext.rider?.name || "Passenger";
  const driverName = titleContext.driver?.name || "Driver";
  const locationName = location?.name;
  const paymentLabel = amount?.formatted
    ? `${amount.formatted} payment`
    : "Payment";
  const cancellationFeeLabel = amount?.formatted
    ? `${amount.formatted} cancellation fee`
    : "Cancellation fee";
  const carpoolPaymentLabel = amount?.formatted
    ? `payment of ${amount.formatted}`
    : "payment";
  const carpoolCancellationFeeLabel = amount?.formatted
    ? `cancellation fee of ${amount.formatted}`
    : "cancellation fee";

  switch (event.eventType) {
    case "ride.requested":
      return `${passengerName} requested a ${titleContext.rideType || "standard"} ride`;
    case "ride.driver_assigned":
      return `${driverName} was assigned to the ride`;
    case "ride.driver_arrived":
      return `${driverName} arrived${locationName ? ` at ${locationName}` : " at the pickup"}`;
    case "ride.passenger_coming":
      return `${passengerName} is coming to the pickup`;
    case "ride.otp_failed":
      return "Ride OTP verification failed";
    case "ride.otp_verified":
      return `Ride OTP was verified by ${actorName}`;
    case "ride.payment_initiated":
      return `${paymentLabel} was initiated`;
    case "carpool.payment_initiated":
      return `${possessive(passengerName)} ${carpoolPaymentLabel} was initiated`;
    case "ride.payment_action_required":
      return `${paymentLabel} verification is required`;
    case "carpool.payment_action_required":
      return `${possessive(passengerName)} ${carpoolPaymentLabel} requires verification`;
    case "ride.payment_succeeded":
      return `${paymentLabel} successfully applied`;
    case "carpool.payment_succeeded":
      return `${possessive(passengerName)} ${carpoolPaymentLabel} was successfully received`;
    case "ride.payment_failed":
      return `${paymentLabel} failed`;
    case "carpool.payment_failed":
      return `${possessive(passengerName)} ${carpoolPaymentLabel} failed`;
    case "ride.cancellation_fee_succeeded":
      return `${cancellationFeeLabel} successfully applied`;
    case "carpool.cancellation_fee_succeeded":
      return `${possessive(passengerName)} ${carpoolCancellationFeeLabel} was successfully applied`;
    case "ride.started":
      return `Ride started${locationName ? ` from ${locationName}` : ""}`;
    case "ride.completed":
      return `Ride completed${locationName ? ` at ${locationName}` : ""}`;
    case "ride.cancelled":
      return `Ride was cancelled by ${actorName}`;
    case "carpool.route_created":
      return `${driverName} created the carpool route`;
    case "carpool.booking_requested":
      return `${passengerName} requested to join the carpool`;
    case "carpool.booking_accepted":
      return `${driverName} accepted ${possessive(passengerName)} request`;
    case "carpool.booking_rejected":
      return `${driverName} rejected ${possessive(passengerName)} request`;
    case "carpool.booking_cancelled":
      return `${possessive(passengerName)} booking was cancelled`;
    case "carpool.route_started":
      return `Carpool started${locationName ? ` from ${locationName}` : ""}`;
    case "carpool.stop_arrived":
      return `${driverName} arrived${locationName ? ` at ${locationName}` : " at a route stop"}`;
    case "carpool.stop_coming":
      return `${driverName} is heading${locationName ? ` to ${locationName}` : " to the next stop"}`;
    case "carpool.otp_failed":
      return `${possessive(passengerName)} OTP verification failed`;
    case "carpool.otp_verified":
      return `${possessive(passengerName)} OTP was verified`;
    case "carpool.passenger_picked_up":
      return `${passengerName} was picked up${locationName ? ` at ${locationName}` : ""}`;
    case "carpool.passenger_dropped_off":
      return `${passengerName} was dropped off${locationName ? ` at ${locationName}` : ""}`;
    case "carpool.route_completed":
      return `Carpool completed${locationName ? ` at ${locationName}` : ""}`;
    case "carpool.route_cancelled":
      return `Carpool was cancelled by ${actorName}`;
    default:
      return humanize(event.eventType);
  }
}

function inferActivityStatus(eventType) {
  if (eventType.includes("failed")) return "failed";
  if (eventType.includes("cancelled") || eventType.includes("rejected")) {
    return "cancelled";
  }
  if (eventType.includes("action_required")) return "action_required";
  if (
    eventType.includes("succeeded") ||
    eventType.includes("completed") ||
    eventType.includes("verified") ||
    eventType.includes("arrived") ||
    eventType.includes("picked_up") ||
    eventType.includes("started")
  ) {
    return "completed";
  }
  return "informational";
}

function distanceMeters(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const [firstLng, firstLat] = first;
  const [secondLng, secondLat] = second;
  const latitudeDelta = toRadians(secondLat - firstLat);
  const longitudeDelta = toRadians(secondLng - firstLng);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(firstLat)) *
      Math.cos(toRadians(secondLat)) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildSampleMarker(sample) {
  const coordinates = Array.isArray(sample.location?.coordinates)
    ? sample.location.coordinates.map(Number)
    : null;

  return {
    id: asId(sample._id),
    recordedAtLabel: formatTimestamp(sample.observedAt),
    timeZone: DISPLAY_TIME_ZONE,
    location: coordinates
      ? {
          name: coordinatesName(coordinates),
          kind: "journey_location",
          coordinates,
          source: "payload",
          accuracyM: sample.accuracyM ?? null,
        }
      : null,
    events: [],
    _recordedAt: new Date(sample.observedAt).getTime(),
    _isSample: true,
  };
}

function findNearestSpatialMarker(markers, location, radiusM) {
  if (!location?.coordinates) return null;

  let nearest = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const marker of markers) {
    const distance = distanceMeters(
      marker.location?.coordinates,
      location.coordinates,
    );
    if (distance <= radiusM && distance < nearestDistance) {
      nearest = marker;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function findNearestTemporalMarker(markers, occurredAt) {
  if (!markers.length || !occurredAt) return null;
  const eventTime = new Date(occurredAt).getTime();

  return markers.reduce((nearest, marker) => {
    if (!nearest) return marker;
    return Math.abs(marker._recordedAt - eventTime) <
      Math.abs(nearest._recordedAt - eventTime)
      ? marker
      : nearest;
  }, null);
}

function stripInternalMarkerFields(marker) {
  const { _recordedAt, _isSample, ...publicMarker } = marker;
  return publicMarker;
}

function buildJourneyTimelineResponse({
  events,
  locations = [],
  context,
  relations,
  groupRadiusM = 50,
}) {
  const userMap = mapById(relations.users, "user");
  const driverMap = mapById(relations.drivers, "driver");
  const bookingMap = getBookingMap(context.bookings);
  const titleContext = {
    rider: userMap.get(asId(context.ride?.user)) || null,
    driver:
      driverMap.get(asId(context.ride?.driver || context.route?.driver)) ||
      null,
    rideType: context.ride?.rideType || null,
  };

  const preparedEvents = events.map((event) => {
    const actor = getActor(event, userMap, driverMap);
    const booking = bookingMap.get(asId(event.bookingId));
    const subject = booking
      ? userMap.get(asId(booking.passenger)) || null
      : null;
    const amount = {
      formatted: formatMoney(
        event.amount?.value,
        event.amount?.currency || "USD",
      ),
    };
    const location = buildEventLocation(event, context, booking);
    const style = getEventStyle(event.eventType);

    return {
      location,
      occurredAt: event.occurredAt,
      activity: {
        id: asId(event._id),
        eventType: event.eventType,
        category: style.category,
        icon: style.icon,
        tone: style.tone,
        status: inferActivityStatus(event.eventType),
        title: buildEventTitle({
          event,
          actor,
          subject,
          titleContext,
          location,
          amount,
        }),
        occurredAtLabel: formatTimestamp(event.occurredAt),
        timeZone: DISPLAY_TIME_ZONE,
        actor,
        transition: {
          from: event.transition?.from || null,
          to: event.transition?.to || null,
        },
        reason: event.reasonCode
          ? { code: event.reasonCode, label: humanize(event.reasonCode) }
          : null,
      },
    };
  });

  // Sample markers are never merged with each other, so every recorded route
  // breadcrumb remains visible on the map.
  const sampleMarkers = locations.map(buildSampleMarker);
  const eventMarkers = [];

  for (const preparedEvent of preparedEvents) {
    let marker = findNearestSpatialMarker(
      sampleMarkers,
      preparedEvent.location,
      groupRadiusM,
    );

    if (!marker && !preparedEvent.location) {
      marker = findNearestTemporalMarker(
        sampleMarkers,
        preparedEvent.occurredAt,
      );
    }

    if (!marker) {
      marker = findNearestSpatialMarker(
        eventMarkers,
        preparedEvent.location,
        groupRadiusM,
      );
    }

    if (!marker) {
      marker = {
        id: asId(preparedEvent.activity.id),
        recordedAtLabel: preparedEvent.activity.occurredAtLabel,
        timeZone: DISPLAY_TIME_ZONE,
        location: preparedEvent.location,
        events: [],
        _recordedAt: new Date(preparedEvent.occurredAt).getTime(),
        _isSample: false,
      };
      eventMarkers.push(marker);
    }

    // Preserve the sampled coordinates, but prefer a useful place name from
    // an event over a generated coordinate label.
    if (
      marker._isSample &&
      preparedEvent.location?.name &&
      preparedEvent.location.kind !== "event_location"
    ) {
      marker.location.name = preparedEvent.location.name;
      marker.location.kind = preparedEvent.location.kind;
    }

    marker.events.push(preparedEvent.activity);
  }

  const timeline = [...sampleMarkers, ...eventMarkers]
    .sort((first, second) => second._recordedAt - first._recordedAt)
    .map(stripInternalMarkerFields);

  return {
    title: "Recent activity",
    order: "newest_first",
    timeZone: DISPLAY_TIME_ZONE,
    total: timeline.length,
    totalEvents: events.length,
    timeline,
  };
}

module.exports = {
  buildJourneyTimelineResponse,
  formatMoney,
  formatTimestamp,
};
