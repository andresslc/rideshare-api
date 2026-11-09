const { default: mongoose } = require("mongoose");

const {
  CARPOOL_SOCKET_EVENTS,
} = require("../../core/common/constants/carpool-constants");
const { decodeSharedKey } = require("../../core/common/helpers");
const CarpoolService = require("./carpool.services");

module.exports = async (io, socket) => {
  try {
    const carpoolIdEncoded = socket.metadata?.carpoolId;

    if (!carpoolIdEncoded) {
      socket.disconnect();
      throw new Error("CARPOOL_ID_REQUIRED");
    }

    const decodedCarpoolId = decodeSharedKey(carpoolIdEncoded);

    const isValidObjectId = mongoose.Types.ObjectId.isValid(
      decodedCarpoolId,
    );

    if (!isValidObjectId) {
      return socket.emit(CARPOOL_SOCKET_EVENTS.ERROR, {
        message: "Invalid Object ID.",
      });
    }

    const { data } = await CarpoolService.getCarpoolById(
      decodedCarpoolId,
    );

    const carpool = data?.carpool;

    if (!carpool) {
      socket.emit(CARPOOL_SOCKET_EVENTS.ERROR, {
        message: "Carpool Not Found",
      });
      socket.disconnect();
      return;
    }

    const carpoolRoom = `carpool:${carpool._id.toString()}`;
    socket.join(carpoolRoom);

    socket.on(
      CARPOOL_SOCKET_EVENTS.INITIAL_DATA,
      async (payload, callback) => {
        return callback({
          success: true,
          message: "Carpool data fetched",
          data: { carpool },
        });
      },
    );
  } catch (err) {
    socket.emit(CARPOOL_SOCKET_EVENTS.ERROR, {
      message: err.message,
    });
    socket.disconnect();
  }
};

