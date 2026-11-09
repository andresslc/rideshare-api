const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RIDE_STATUS,
  RIDE_STARTABLE_STATUSES,
  allowedTransitions,
} = require("../src/core/common/constants/ride-constants");

test("a ride can be started from accepted, arrived or coming", () => {
  assert.deepEqual(RIDE_STARTABLE_STATUSES, [
    RIDE_STATUS.ACCEPTED,
    RIDE_STATUS.ARRIVED,
    RIDE_STATUS.COMING,
  ]);
});

test("a ride that has not been accepted yet cannot be started", () => {
  for (const status of [
    RIDE_STATUS.REQUESTED,
    RIDE_STATUS.EXPIRED,
    RIDE_STATUS.CANCELLED,
    RIDE_STATUS.COMPLETED,
    RIDE_STATUS.IN_PROGRESS,
  ]) {
    assert.equal(
      RIDE_STARTABLE_STATUSES.includes(status),
      false,
      `${status} must not be a startable state`,
    );
  }
});

test("accepted still has to pass through arrived to reach in-progress", () => {
  // The start gate records the arrival itself. If this transition were ever
  // opened up directly, that step — and `driverArrivedAt` with it — would
  // silently stop happening.
  assert.equal(
    allowedTransitions[RIDE_STATUS.ACCEPTED].includes(RIDE_STATUS.IN_PROGRESS),
    false,
  );
  assert.equal(
    allowedTransitions[RIDE_STATUS.ACCEPTED].includes(RIDE_STATUS.ARRIVED),
    true,
  );
});

test("every startable state reaches in-progress, directly or through arrived", () => {
  for (const status of RIDE_STARTABLE_STATUSES) {
    const direct = allowedTransitions[status].includes(RIDE_STATUS.IN_PROGRESS);
    const viaArrival =
      allowedTransitions[status].includes(RIDE_STATUS.ARRIVED) &&
      allowedTransitions[RIDE_STATUS.ARRIVED].includes(RIDE_STATUS.IN_PROGRESS);

    assert.ok(
      direct || viaArrival,
      `${status} is startable but cannot reach in-progress`,
    );
  }
});

test("only a ride in progress can be completed", () => {
  assert.deepEqual(allowedTransitions[RIDE_STATUS.IN_PROGRESS], [
    RIDE_STATUS.COMPLETED,
    RIDE_STATUS.CANCELLED,
  ]);

  for (const status of [
    RIDE_STATUS.ACCEPTED,
    RIDE_STATUS.ARRIVED,
    RIDE_STATUS.COMING,
  ]) {
    assert.equal(
      allowedTransitions[status].includes(RIDE_STATUS.COMPLETED),
      false,
      `${status} must not be completable without starting the ride`,
    );
  }
});
