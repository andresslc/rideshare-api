const normalizeFare = (value) => {
  const fare = Number(value);
  return Number.isFinite(fare) ? fare : 0;
};

const getDriverFare = (chargedFare, originalFare, discountAmount = 0) => {
  const original = normalizeFare(originalFare);

  if (original > 0) return original;

  const charged = normalizeFare(chargedFare);
  const discount = Math.max(normalizeFare(discountAmount), 0);

  return Number((charged + discount).toFixed(2));
};

const getRideDriverFare = (ride) =>
  getDriverFare(ride?.rideFare, ride?.originalRideFare, ride?.discountAmount);

const getCarpoolDriverFare = (booking) =>
  getDriverFare(
    booking?.fareCharged,
    booking?.originalFare,
    booking?.discountAmount,
  );

module.exports = {
  getDriverFare,
  getRideDriverFare,
  getCarpoolDriverFare,
};
