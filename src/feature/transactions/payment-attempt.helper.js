function rideStartPaymentKey(rideId) {
  return `ride:${rideId}:start-payment`;
}

function carpoolPickupPaymentKey(bookingId) {
  return `carpool:${bookingId}:pickup-payment`;
}

module.exports = { rideStartPaymentKey, carpoolPickupPaymentKey };
