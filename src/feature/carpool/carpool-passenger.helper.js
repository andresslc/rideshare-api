const HIDDEN_PASSENGER_STATUSES = new Set(["cancelled", "rejected"]);

const getPassengerUserId = (passenger) =>
  passenger?.user?._id ?? passenger?.user ?? null;

const getUniqueVisiblePassengers = (passengers = []) => {
  const passengersByUser = new Map();

  for (const passenger of passengers) {
    const userId = getPassengerUserId(passenger);
    if (!userId || HIDDEN_PASSENGER_STATUSES.has(passenger?.status)) continue;

    const key = userId.toString();

    // Route entries are appended chronologically. If legacy data contains
    // duplicates, retain the most recent visible entry for that passenger.
    if (passengersByUser.has(key)) passengersByUser.delete(key);
    passengersByUser.set(key, passenger);
  }

  return [...passengersByUser.values()];
};

module.exports = {
  getUniqueVisiblePassengers,
};
