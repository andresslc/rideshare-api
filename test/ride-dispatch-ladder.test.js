const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_DISPATCH_RADIUS_LADDER_MILES,
  DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS,
  MAX_DISPATCH_RADIUS_MILES,
  MAX_DISPATCH_RINGS,
  REQUEST_CATEGORIES,
  DISPATCHABLE_CATEGORIES,
  RIDE_TYPE,
  allowedTransitions,
} = require("../src/core/common/constants/ride-constants");
const {
  updateRideConfigurationValidator,
} = require("../src/feature/admin/dto/ride-configuration.validators");
const {
  RideConfigurationModel,
} = require("../src/feature/config/model/ride-configuration.model");
const {
  isUsableDispatchLadder,
  milesToKilometers,
} = require("../src/feature/config/ride-configuration.service");
const {
  rideRequestValidator,
} = require("../src/feature/ride/dto/ride.validator");

const emptyRequest = { body: {}, query: {}, params: {} };

const validRequest = {
  pickupPoint: {
    placeName: "Brickell",
    location: { type: "Point", coordinates: [-80.19, 25.76] },
  },
  dropOffPoint: {
    placeName: "Wynwood",
    location: { type: "Point", coordinates: [-80.2, 25.8] },
  },
  rideFare: 18.5,
  rideDistance: 4.2,
  averageTime: 12,
  paymentMethod: "wallet",
};

test("a new configuration starts on the 1-2-3-5 ladder", () => {
  const configuration = new RideConfigurationModel();

  assert.deepEqual(
    configuration.dispatchRadiusLadderMiles,
    DEFAULT_DISPATCH_RADIUS_LADDER_MILES,
  );
  assert.equal(
    configuration.dispatchRingTimeoutSeconds,
    DEFAULT_DISPATCH_RING_TIMEOUT_SECONDS,
  );
  assert.equal(configuration.validateSync(), undefined);
});

test("the default ladder starts tight and ends at the reach cap", () => {
  const ladder = DEFAULT_DISPATCH_RADIUS_LADDER_MILES;

  assert.equal(ladder[0], 1, "the first ring must be the closest drivers");
  assert.equal(
    ladder[ladder.length - 1],
    MAX_DISPATCH_RADIUS_MILES,
    "the last ring must not exceed the reach cap",
  );
});

test("a usable ladder is ascending, bounded and non-empty", () => {
  for (const ladder of [[1], [1, 2, 3, 5], [0.5, 2, 5]]) {
    assert.equal(isUsableDispatchLadder(ladder), true, JSON.stringify(ladder));
  }

  for (const ladder of [
    [], // nothing to search
    [2, 1], // descending
    [1, 1, 2], // a repeat is not a wider ring
    [1, 2, 6], // past the reach cap
    [1, 0], // non-positive
    [1, "2"], // not a number
    null,
    undefined,
    5,
    Array.from({ length: MAX_DISPATCH_RINGS + 1 }, (_, i) => (i + 1) * 0.1),
  ]) {
    assert.equal(
      isUsableDispatchLadder(ladder),
      false,
      JSON.stringify(ladder ?? String(ladder)),
    );
  }
});

test("admin may reconfigure the ladder but not past the reach cap", () => {
  const accepted = [
    { dispatchRadiusLadderMiles: [0.5, 1, 2] },
    { dispatchRadiusLadderMiles: [1, 2, 3, 5] },
    { dispatchRingTimeoutSeconds: 8 },
    { dispatchRadiusLadderMiles: [1, 3], dispatchRingTimeoutSeconds: 15 },
  ];

  for (const body of accepted) {
    assert.equal(
      updateRideConfigurationValidator.safeParse({ ...emptyRequest, body })
        .success,
      true,
      JSON.stringify(body),
    );
  }

  const rejected = [
    { dispatchRadiusLadderMiles: [1, 2, 10] }, // past the cap
    { dispatchRadiusLadderMiles: [5, 2] }, // descending
    { dispatchRadiusLadderMiles: [] }, // no rings
    { dispatchRingTimeoutSeconds: 1 }, // too impatient to be answerable
    { dispatchRingTimeoutSeconds: 120 }, // longer than the rider will wait
    { dispatchRingTimeoutSeconds: 7.5 }, // not whole seconds
  ];

  for (const body of rejected) {
    assert.equal(
      updateRideConfigurationValidator.safeParse({ ...emptyRequest, body })
        .success,
      false,
      JSON.stringify(body),
    );
  }
});

test("ladder miles convert to the kilometres GEOSEARCH expects", () => {
  assert.equal(milesToKilometers(1), 1.609344);
  assert.equal(milesToKilometers(5), 8.04672);
});

test("a request must name a dispatchable category", () => {
  for (const category of DISPATCHABLE_CATEGORIES) {
    assert.equal(
      rideRequestValidator.safeParse({ ...validRequest, category }).success,
      true,
      category,
    );
  }

  // Carpool is a valid thing to ask for; the handler redirects it to route
  // matching rather than the ladder.
  assert.equal(
    rideRequestValidator.safeParse({ ...validRequest, category: "carpool" })
      .success,
    true,
  );

  // Retired: the rider no longer picks a driver from a list of offers.
  assert.equal(
    rideRequestValidator.safeParse({ ...validRequest, category: "private" })
      .success,
    false,
  );
  assert.equal(REQUEST_CATEGORIES.includes("private"), false);

  // ...but the value still exists for rides already stored with it.
  assert.equal(RIDE_TYPE.includes("private"), true);
});

test("older clients sending only rideType still pass validation", () => {
  assert.equal(
    rideRequestValidator.safeParse({ ...validRequest, rideType: "economy" })
      .success,
    true,
  );

  // Neither field is a request for nothing in particular, and is refused.
  assert.equal(rideRequestValidator.safeParse(validRequest).success, false);
});

test("an exhausted search can close a request that was never taken", () => {
  assert.equal(
    allowedTransitions.requested.includes("expired"),
    true,
    "requested must be able to reach expired, or exhausted searches leak",
  );
  assert.deepEqual(allowedTransitions.expired, []);
});
