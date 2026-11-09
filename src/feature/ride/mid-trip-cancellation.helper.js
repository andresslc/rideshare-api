const { getDistanceInMeters } = require("../../core/common/helpers");
const { normalizeMoney } = require("./ride-settlement.helper");

const METERS_PER_MILE = 1609.344;

/**
 * A ride cancelled after it started was already paid in full: the charge runs
 * on Start Ride, before the ride reaches "in-progress". The rule is that the
 * rider pays for exactly the part of the trip that was delivered and gets the
 * rest back, whoever cancelled. There is no multiplier, no minimum and no grace
 * window: cancelling at mile zero already costs zero.
 */

/**
 * Length of a GPS trace in miles.
 *
 * `points` are GeoJSON coordinate pairs, `[lng, lat]`, in the order they were
 * observed. Samples land every few minutes, so the sum of straight segments
 * undercounts a trip through city streets; that is why the delivered share
 * also looks at elapsed time and keeps whichever is larger.
 */
function traceLengthInMiles(points = []) {
  const valid = points.filter(
    (point) =>
      Array.isArray(point) &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]),
  );

  let meters = 0;
  for (let index = 1; index < valid.length; index += 1) {
    const [lng1, lat1] = valid[index - 1];
    const [lng2, lat2] = valid[index];
    meters += getDistanceInMeters(lat1, lng1, lat2, lng2);
  }

  return meters / METERS_PER_MILE;
}

const clampShare = (value) =>
  Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;

/**
 * Share of the trip already delivered, from 0 to 1.
 *
 * Two independent readings, each against what the rider was quoted: GPS miles
 * over quoted miles, and minutes since Start Ride over quoted minutes. The
 * larger one wins, so a sparse GPS trace cannot hand back money for distance
 * the driver actually covered. A reading whose quote is missing is ignored.
 */
function getDeliveredShare({
  travelledMiles,
  quotedMiles,
  elapsedMs,
  quotedMinutes,
}) {
  const distanceShare =
    Number(quotedMiles) > 0
      ? clampShare(Number(travelledMiles) / Number(quotedMiles))
      : 0;
  const timeShare =
    Number(quotedMinutes) > 0 && Number(elapsedMs) > 0
      ? clampShare(Number(elapsedMs) / 60000 / Number(quotedMinutes))
      : 0;

  return {
    distanceShare: Number(distanceShare.toFixed(4)),
    timeShare: Number(timeShare.toFixed(4)),
    share: Number(Math.max(distanceShare, timeShare).toFixed(4)),
  };
}

/**
 * Split what was collected at Start Ride into what stays and what goes back.
 *
 * Every party keeps `share` of what it put in or took out: the rider pays
 * `share` of the fare, the driver keeps `share` of their payout, and the
 * platform absorbs `share` of any promo discount. The rider's refund goes back
 * to the same wallet buckets it came from, rewarded credit in proportion.
 */
function splitMidTripSettlement({
  share,
  riderPaid,
  riderRewardedPaid = 0,
  driverPaid,
  platformAbsorbed = 0,
}) {
  const delivered = clampShare(share);
  const paid = normalizeMoney(riderPaid);
  const driverAmount = normalizeMoney(driverPaid);
  const absorbed = normalizeMoney(platformAbsorbed);

  const riderCharged = normalizeMoney(paid * delivered);
  const riderRefund = normalizeMoney(paid - riderCharged);

  const rewardedPaid = Math.min(normalizeMoney(riderRewardedPaid), paid);
  const riderRewardedRefund =
    paid > 0
      ? Math.min(
          normalizeMoney((rewardedPaid * riderRefund) / paid),
          riderRefund,
        )
      : 0;
  const riderRegularRefund = normalizeMoney(riderRefund - riderRewardedRefund);

  const driverKept = normalizeMoney(driverAmount * delivered);
  const driverClawback = normalizeMoney(driverAmount - driverKept);

  const platformKept = normalizeMoney(absorbed * delivered);
  const platformReversal = normalizeMoney(absorbed - platformKept);

  return {
    share: delivered,
    riderPaid: paid,
    riderCharged,
    riderRefund,
    riderRegularRefund,
    riderRewardedRefund,
    driverPaid: driverAmount,
    driverKept,
    driverClawback,
    platformAbsorbed: absorbed,
    platformKept,
    platformReversal,
  };
}

module.exports = {
  METERS_PER_MILE,
  traceLengthInMiles,
  getDeliveredShare,
  splitMidTripSettlement,
};
