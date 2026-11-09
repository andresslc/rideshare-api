const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getUniqueVisiblePassengers,
} = require("../src/feature/carpool/carpool-passenger.helper");

test("removes cancelled and rejected passengers from a carpool roster", () => {
  const passengers = getUniqueVisiblePassengers([
    { user: "user-1", status: "cancelled" },
    { user: "user-2", status: "rejected" },
    { user: "user-3", status: "completed" },
  ]);

  assert.deepEqual(passengers, [{ user: "user-3", status: "completed" }]);
});

test("keeps only the latest visible route entry for each passenger", () => {
  const passengers = getUniqueVisiblePassengers([
    { user: { _id: "user-1" }, bookingId: "booking-1", status: "accepted" },
    { user: { _id: "user-2" }, bookingId: "booking-2", status: "completed" },
    { user: { _id: "user-1" }, bookingId: "booking-3", status: "completed" },
  ]);

  assert.deepEqual(
    passengers.map((passenger) => passenger.bookingId),
    ["booking-2", "booking-3"],
  );
});

test("keeps a rejoined passenger after discarding their cancelled entry", () => {
  const passengers = getUniqueVisiblePassengers([
    { user: "user-1", bookingId: "booking-1", status: "cancelled" },
    { user: "user-1", bookingId: "booking-2", status: "accepted" },
  ]);

  assert.deepEqual(passengers, [
    { user: "user-1", bookingId: "booking-2", status: "accepted" },
  ]);
});
