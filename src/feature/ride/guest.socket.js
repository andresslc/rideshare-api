const { default: mongoose } = require("mongoose");
const {
  RIDE_STATUS,
  RIDE,
  RIDE_SOCKET_EVENTS,
} = require("../../core/common/constants/ride-constants");
const { decodeSharedKey } = require("../../core/common/helpers");
const asyncSocketWrapper = require("../../core/common/socket-async");
const RideService = require("./ride.service");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");

const withRideDriverFare = (ride) => {
  const serialized =
    typeof ride?.toObject === "function" ? ride.toObject() : ride;

  return serialized
    ? { ...serialized, driverFare: getRideDriverFare(serialized) }
    : serialized;
};

module.exports = async (io, socket) => {
  try {
    console.log("Guest socket connection initiated");
    const rideId = socket.metadata?.rideId;

    if (!rideId) {
      console.log("No rideId provided, disconnecting socket");
      socket.disconnect();
      throw new Error("RIDE_ID_REQUIRED");
    }

    console.log(`Decoding rideId: ${rideId}`);
    const decodedRideId = decodeSharedKey(rideId);

    const isValidObjectId = mongoose.Types.ObjectId.isValid(decodedRideId);

    if (!isValidObjectId) {
      console.log(`Invalid Object ID: ${decodedRideId}`);
      return socket.emit(RIDE_SOCKET_EVENTS.ERROR, {
        message: "Invalid Object ID.",
      });
    }

    console.log(`Fetching ride with ID: ${decodedRideId}`);
    const ride = await RideService.getRideWithRelations(
      decodedRideId,
      "en",
      "socket",
    );

    if (!ride) {
      console.log(`Ride not found for ID: ${decodedRideId}`);
      return socket.emit(RIDE_SOCKET_EVENTS.ERROR, {
        message: "Ride Not Found",
      });
    }

    const rideRoom = `${RIDE}:${ride._id}`;
    console.log(`Joining ride room: ${rideRoom}`);
    socket.join(rideRoom);

    if (
      [RIDE_STATUS.COMPLETED, RIDE_STATUS.CANCELLED].includes(ride.rideStatus)
    ) {
      console.log(
        `Ride status is ${ride.rideStatus}, emitting status update and disconnecting`,
      );
      io.to(rideRoom).emit(RIDE_SOCKET_EVENTS.STATUS_UPDATE, {
        rideId: ride._id,
        type: ride.rideStatus,
        driverFare: getRideDriverFare(ride),
      });
      socket.disconnect();
      return;
    }

    console.log("Setting up INITIAL_DATA event listener");
    socket.on(
      RIDE_SOCKET_EVENTS.INITIAL_DATA,
      asyncSocketWrapper(socket, async (payload, callback) => {
        console.log("Handling INITIAL_DATA request");
        return callback({
          success: true,
          message: "Ride data fetched",
          data: { ride: withRideDriverFare(ride) },
        });
      }),
    );
  } catch (err) {
    console.log("Error in Guest Socket", err.message);
    socket.emit(RIDE_SOCKET_EVENTS.ERROR, {
      message: err.message,
    });
  }
};
