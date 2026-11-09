const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDriverFare,
  getRideDriverFare,
} = require("../src/core/common/helpers/driver-fare.helper");
const { getWalletAllocation } = require("../src/feature/wallet/wallet.service");
const {
  isFreeRide,
  normalizeMoney,
} = require("../src/feature/ride/ride-settlement.helper");

test("a ride the rider owes nothing for is recognised as free", () => {
  assert.equal(isFreeRide({ rideFare: 0 }), true);
  assert.equal(isFreeRide({ rideFare: "0.00" }), true);
  assert.equal(isFreeRide({ rideFare: null }), true);
  assert.equal(isFreeRide({}), true);
  assert.equal(isFreeRide(undefined), true);

  assert.equal(isFreeRide({ rideFare: 0.01 }), false);
  assert.equal(isFreeRide({ rideFare: 18.5 }), false);
});

test("the driver is paid the original fare even when the rider pays nothing", () => {
  const ride = {
    rideFare: 0,
    originalRideFare: 18.5,
    discountAmount: 18.5,
  };

  assert.equal(isFreeRide(ride), true);
  assert.equal(
    getRideDriverFare(ride),
    18.5,
    "a 100% discount is the rider's, not the driver's",
  );
});

test("a partly discounted ride pays the driver off the pre-discount fare", () => {
  const ride = { rideFare: 12, originalRideFare: 18.5, discountAmount: 6.5 };

  assert.equal(isFreeRide(ride), false);
  assert.equal(getRideDriverFare(ride), 18.5);
});

test("an undiscounted ride pays the driver exactly what the rider paid", () => {
  const ride = { rideFare: 18.5, discountAmount: 0 };

  assert.equal(getRideDriverFare(ride), 18.5);
});

test("driver pay falls back to charged plus discount when no original is stored", () => {
  assert.equal(getDriverFare(12, undefined, 6.5), 18.5);
  assert.equal(getDriverFare(0, 0, 18.5), 18.5);
});

test("the platform absorbs the whole fare on a free ride", () => {
  const ride = { rideFare: 0, originalRideFare: 18.5, discountAmount: 18.5 };

  const driverAmount = getRideDriverFare(ride);
  const riderPaid = normalizeMoney(0);
  const absorbed =
    normalizeMoney(ride.discountAmount) > 0
      ? normalizeMoney(ride.discountAmount)
      : Math.max(normalizeMoney(driverAmount - riderPaid), 0);

  assert.equal(driverAmount, 18.5);
  assert.equal(riderPaid, 0);
  assert.equal(absorbed, 18.5);
  assert.equal(
    absorbed,
    driverAmount - riderPaid,
    "every cent the driver earns must be accounted for by the platform",
  );
});

test("the wallet allocator cannot settle a zero amount, which is why free rides skip it", () => {
  const richWallet = { balance: 500, rewardedBalance: 0 };

  // This is the trap the free-ride branch exists to avoid: a null here used to
  // be read as an empty balance, and the ride was cancelled instead of started.
  assert.equal(getWalletAllocation(richWallet, 0), null);
  assert.equal(getWalletAllocation(richWallet, -5), null);

  // A real charge against the same wallet still allocates normally.
  assert.notEqual(getWalletAllocation(richWallet, 18.5), null);

  // And a genuinely empty wallet is still refused, so the guard did not make
  // insufficient balance look like a free ride.
  assert.equal(
    getWalletAllocation({ balance: 1, rewardedBalance: 0 }, 18.5),
    null,
  );
});

test("money is rounded to cents rather than carried as float noise", () => {
  assert.equal(normalizeMoney(0.1 + 0.2), 0.3);
  assert.equal(normalizeMoney("18.999"), 19);
  assert.equal(normalizeMoney("not a number"), 0);
  assert.equal(normalizeMoney(undefined), 0);
});
