const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getRideHistoryVisibilityFilter,
} = require("../src/feature/ride/ride-history.helper");

test("excludes user rides cancelled before a driver was assigned", () => {
  assert.deepEqual(getRideHistoryVisibilityFilter("user"), {
    $nor: [
      {
        rideStatus: "cancelled",
        driver: null,
      },
    ],
  });
});

test("excludes pre-assignment cancellations from admin ride history", () => {
  assert.deepEqual(getRideHistoryVisibilityFilter("admin"), {
    $nor: [
      {
        rideStatus: "cancelled",
        driver: null,
      },
    ],
  });
});

test("does not add the pre-assignment filter to driver history", () => {
  assert.deepEqual(getRideHistoryVisibilityFilter("driver"), {});
});
