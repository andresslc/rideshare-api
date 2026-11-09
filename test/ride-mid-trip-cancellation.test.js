const assert = require("node:assert/strict");
const test = require("node:test");

const {
  METERS_PER_MILE,
  traceLengthInMiles,
  getDeliveredShare,
  splitMidTripSettlement,
} = require("../src/feature/ride/mid-trip-cancellation.helper");
const { toMidTripSummary, parseRide } = require("../src/core/common/helpers");
const {
  RIDE_STATUS,
  allowedTransitions,
} = require("../src/core/common/constants/ride-constants");

// One degree of latitude is ~69.09 miles anywhere on the globe.
const MILES_PER_DEGREE_LAT = (Math.PI * 6371000) / 180 / METERS_PER_MILE;

test("a ride can be cancelled while it is in progress", () => {
  assert.equal(
    allowedTransitions[RIDE_STATUS.IN_PROGRESS].includes(RIDE_STATUS.CANCELLED),
    true,
  );
});

test("a GPS trace is measured segment by segment", () => {
  const trace = [
    [-80.19, 25.0],
    [-80.19, 25.1],
    [-80.19, 25.2],
  ];

  const miles = traceLengthInMiles(trace);
  assert.ok(Math.abs(miles - 0.2 * MILES_PER_DEGREE_LAT) < 0.01);
});

test("a trace with fewer than two usable points has no length", () => {
  assert.equal(traceLengthInMiles([]), 0);
  assert.equal(traceLengthInMiles([[-80.19, 25.0]]), 0);
  assert.equal(traceLengthInMiles([null, [-80.19, 25.0], ["x", 1]]), 0);
});

test("broken points are skipped instead of breaking the measurement", () => {
  const clean = traceLengthInMiles([
    [-80.19, 25.0],
    [-80.19, 25.1],
  ]);
  const noisy = traceLengthInMiles([
    [-80.19, 25.0],
    null,
    [Number.NaN, 25.05],
    [-80.19, 25.1],
  ]);

  assert.equal(noisy, clean);
});

test("the delivered share is the larger of the distance and time readings", () => {
  const byDistance = getDeliveredShare({
    travelledMiles: 6,
    quotedMiles: 10,
    elapsedMs: 5 * 60000,
    quotedMinutes: 20,
  });
  assert.equal(byDistance.distanceShare, 0.6);
  assert.equal(byDistance.timeShare, 0.25);
  assert.equal(byDistance.share, 0.6);

  const byTime = getDeliveredShare({
    travelledMiles: 1,
    quotedMiles: 10,
    elapsedMs: 15 * 60000,
    quotedMinutes: 20,
  });
  assert.equal(byTime.share, 0.75, "sparse GPS cannot undercount a long ride");
});

test("the delivered share never goes past the whole trip", () => {
  const { share } = getDeliveredShare({
    travelledMiles: 14,
    quotedMiles: 10,
    elapsedMs: 60 * 60000,
    quotedMinutes: 20,
  });

  assert.equal(share, 1);
});

test("a ride cancelled right after starting has delivered nothing", () => {
  const { share } = getDeliveredShare({
    travelledMiles: 0,
    quotedMiles: 10,
    elapsedMs: 0,
    quotedMinutes: 20,
  });

  assert.equal(share, 0);
});

test("a missing quote leaves only the other reading", () => {
  assert.equal(
    getDeliveredShare({
      travelledMiles: 3,
      quotedMiles: 10,
      elapsedMs: 10 * 60000,
      quotedMinutes: null,
    }).share,
    0.3,
  );
  assert.equal(
    getDeliveredShare({
      travelledMiles: 3,
      quotedMiles: 0,
      elapsedMs: 10 * 60000,
      quotedMinutes: 20,
    }).share,
    0.5,
  );
});

test("the rider pays the delivered share and gets the rest back", () => {
  const split = splitMidTripSettlement({
    share: 0.3,
    riderPaid: 20,
    driverPaid: 20,
  });

  assert.equal(split.riderCharged, 6);
  assert.equal(split.riderRefund, 14);
  assert.equal(split.driverKept, 6);
  assert.equal(split.driverClawback, 14);
  assert.equal(split.platformReversal, 0);
});

test("nothing is refunded when the whole trip was delivered", () => {
  const split = splitMidTripSettlement({
    share: 1,
    riderPaid: 18.5,
    driverPaid: 18.5,
  });

  assert.equal(split.riderRefund, 0);
  assert.equal(split.driverClawback, 0);
});

test("everything is refunded when nothing was delivered", () => {
  const split = splitMidTripSettlement({
    share: 0,
    riderPaid: 18.5,
    driverPaid: 18.5,
  });

  assert.equal(split.riderCharged, 0);
  assert.equal(split.riderRefund, 18.5);
  assert.equal(split.driverKept, 0);
  assert.equal(split.driverClawback, 18.5);
});

test("refund and charge always add back up to what was paid", () => {
  for (const share of [0.0001, 0.1234, 0.3333, 0.5, 0.6667, 0.9999]) {
    for (const riderPaid of [0.99, 7.33, 13.37, 18.5, 99.99]) {
      const split = splitMidTripSettlement({
        share,
        riderPaid,
        driverPaid: riderPaid,
      });

      assert.equal(
        Number((split.riderCharged + split.riderRefund).toFixed(2)),
        riderPaid,
        `share ${share} of ${riderPaid} lost a cent`,
      );
      assert.equal(
        Number((split.driverKept + split.driverClawback).toFixed(2)),
        riderPaid,
      );
    }
  }
});

test("a promo ride splits the platform's absorbed discount the same way", () => {
  // Rider paid 12 of an 18.50 fare; the platform absorbed 6.50 for the driver.
  const split = splitMidTripSettlement({
    share: 0.5,
    riderPaid: 12,
    driverPaid: 18.5,
    platformAbsorbed: 6.5,
  });

  assert.equal(split.riderCharged, 6);
  assert.equal(split.riderRefund, 6);
  assert.equal(split.driverKept, 9.25);
  assert.equal(split.driverClawback, 9.25);
  assert.equal(split.platformKept, 3.25);
  assert.equal(split.platformReversal, 3.25);
  assert.equal(
    split.riderCharged + split.platformKept,
    split.driverKept,
    "what the driver keeps is covered by the rider and the platform",
  );
});

test("a free ride refunds the rider nothing but still trims the driver", () => {
  const split = splitMidTripSettlement({
    share: 0.4,
    riderPaid: 0,
    driverPaid: 18.5,
    platformAbsorbed: 18.5,
  });

  assert.equal(split.riderRefund, 0);
  assert.equal(split.driverKept, 7.4);
  assert.equal(split.platformReversal, 11.1);
});

test("rewarded wallet credit goes back in proportion to how it was spent", () => {
  const split = splitMidTripSettlement({
    share: 0.5,
    riderPaid: 20,
    riderRewardedPaid: 5,
    driverPaid: 20,
  });

  assert.equal(split.riderRefund, 10);
  assert.equal(split.riderRewardedRefund, 2.5);
  assert.equal(split.riderRegularRefund, 7.5);
});

test("a fully rewarded payment is refunded to rewarded credit only", () => {
  const split = splitMidTripSettlement({
    share: 0.25,
    riderPaid: 8,
    riderRewardedPaid: 8,
    driverPaid: 8,
  });

  assert.equal(split.riderRewardedRefund, 6);
  assert.equal(split.riderRegularRefund, 0);
});

test("an out-of-range share is clamped rather than refunding more than paid", () => {
  const over = splitMidTripSettlement({
    share: 1.7,
    riderPaid: 10,
    driverPaid: 10,
  });
  assert.equal(over.riderRefund, 0);

  const under = splitMidTripSettlement({
    share: -1,
    riderPaid: 10,
    driverPaid: 10,
  });
  assert.equal(under.riderRefund, 10);

  const nan = splitMidTripSettlement({
    share: Number.NaN,
    riderPaid: 10,
    driverPaid: 10,
  });
  assert.equal(nan.riderRefund, 10);
});

test("rides without a settlement show none to the apps", () => {
  assert.equal(toMidTripSummary(undefined), null);
  assert.equal(toMidTripSummary({ status: null, share: null }), null);

  const ride = parseRide({
    _id: "r1",
    rideFare: 18.5,
    rideStatus: "completed",
  });
  assert.equal(ride.midTripCancellation, null);
  assert.equal(ride.driverFare, 18.5);
});

test("a settled ride tells the apps what each side ended up with", () => {
  const ride = parseRide({
    _id: "r1",
    rideFare: 20,
    rideStatus: "cancelled",
    midTripCancellation: {
      status: "completed",
      cancelledBy: "user",
      paymentMethod: "wallet",
      share: 0.3,
      riderPaid: 20,
      riderCharged: 6,
      riderRefund: 14,
      driverKept: 6,
      driverClawback: 14,
      stripeRefundId: "re_internal",
    },
  });

  assert.equal(ride.driverFare, 6, "the driver keeps only the delivered share");
  assert.equal(ride.midTripCancellation.riderRefund, 14);
  assert.equal(ride.midTripCancellation.driverKept, 6);
  assert.equal(
    "stripeRefundId" in ride.midTripCancellation,
    false,
    "internal references stay off the app payload",
  );
});

test("a settlement still in flight keeps the original driver fare", () => {
  const ride = parseRide({
    _id: "r1",
    rideFare: 20,
    rideStatus: "cancelled",
    midTripCancellation: { status: "failed", driverKept: 6 },
  });

  assert.equal(ride.driverFare, 20);
  assert.equal(ride.midTripCancellation.status, "failed");
});
