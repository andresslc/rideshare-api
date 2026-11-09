const { RIDE_STATUS } = require("../../core/common/constants/ride-constants");

function getRideHistoryVisibilityFilter(role) {
  if (!["user", "admin"].includes(role)) return {};

  return {
    $nor: [
      {
        rideStatus: RIDE_STATUS.CANCELLED,
        driver: null,
      },
    ],
  };
}

module.exports = { getRideHistoryVisibilityFilter };
