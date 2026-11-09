const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_CARPOOL_MATCH_RADIUS_MILES,
} = require("../src/core/common/constants/carpool-constants");
const {
  DEFAULT_NEARBY_RADIUS_MILES,
} = require("../src/core/common/constants/ride-constants");
const {
  getRideConfigurationValidator,
  updateRideConfigurationValidator,
} = require("../src/feature/admin/dto/ride-configuration.validators");
const {
  RideConfigurationModel,
} = require("../src/feature/config/model/ride-configuration.model");
const {
  milesToKilometers,
  milesToMeters,
} = require("../src/feature/config/ride-configuration.service");

const emptyRequest = { body: {}, query: {}, params: {} };

test("ride configuration has independent ride and carpool radius defaults", () => {
  const configuration = new RideConfigurationModel();

  assert.equal(configuration.nearbyRadius, DEFAULT_NEARBY_RADIUS_MILES);
  assert.equal(
    configuration.carpoolNearbyRadius,
    DEFAULT_CARPOOL_MATCH_RADIUS_MILES,
  );
  assert.equal(milesToMeters(configuration.carpoolNearbyRadius), 500);
  assert.equal(configuration.validateSync(), undefined);
});

test("distance miles are converted for MongoDB and Redis queries", () => {
  assert.equal(milesToMeters(5), 8046.72);
  assert.equal(milesToKilometers(5), 8.04672);
});

test("admin can update either radius independently or both together", () => {
  for (const body of [
    { nearbyRadius: 7.5 },
    { carpoolNearbyRadius: 0.75 },
    { nearbyRadius: 7.5, carpoolNearbyRadius: 0.75 },
  ]) {
    assert.equal(
      updateRideConfigurationValidator.safeParse({
        ...emptyRequest,
        body,
      }).success,
      true,
    );
  }
});

test("admin configuration rejects empty, unknown, and invalid updates", () => {
  for (const body of [
    {},
    { unsupportedDistance: 10 },
    { carpoolNearbyRadius: 0 },
  ]) {
    assert.equal(
      updateRideConfigurationValidator.safeParse({
        ...emptyRequest,
        body,
      }).success,
      false,
    );
  }

  assert.equal(
    getRideConfigurationValidator.safeParse(emptyRequest).success,
    true,
  );
});
