const { QUEUES } = require("../../core/common/constants");
const queueService = require("../../core/queues/queue.service");

const JOB_NAME = "dispatch_ride_ring";
const UPGRADE_JOB_NAME = "dispatch_upgrade_timeout";

/**
 * One job id per (ride, search generation, ring). A retry or a duplicate
 * enqueue lands on the same id, so a ring can never be opened twice for the
 * same ride.
 *
 * Generation 0 keeps the old two-part id, so jobs queued by the previous
 * release still resolve during a rolling deploy. Later generations are
 * namespaced because `dispatch-<ride>-0` from the first search is still in the
 * completed set, and a second add under that id is silently dropped — the
 * second search would never leave ring 0.
 */
function makeJobId(rideId, ringIndex, attempt = 0) {
  return attempt > 0
    ? `dispatch-${rideId}-a${attempt}-${ringIndex}`
    : `dispatch-${rideId}-${ringIndex}`;
}

/**
 * The window a rider has to answer an upgrade offer. Namespaced by generation
 * for the same reason the ring ids are, and distinct from every ring id so the
 * two can never collide.
 */
function makeUpgradeJobId(rideId, attempt = 0) {
  return `upgrade-${rideId}-a${attempt}`;
}

/**
 * Schedule the next ring of the ladder.
 *
 * When BullMQ is unavailable the ladder falls back to an in-process timer. That
 * is a real downgrade — a restart loses the pending ring and the request then
 * only ends when its Redis session TTL runs out — but a degraded ladder still
 * beats a request that stops escalating after its first ring.
 */
async function enqueueNextRing({ rideId, ringIndex, delayMs, attempt = 0 }) {
  const jobId = makeJobId(rideId, ringIndex, attempt);

  try {
    const queue = queueService.getQueue(QUEUES.RIDE_DISPATCH);

    return await queue.add(
      JOB_NAME,
      { rideId, ringIndex, attempt },
      {
        jobId,
        delay: delayMs,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  } catch (error) {
    console.error(
      `[DISPATCH] queue unavailable for ride ${rideId} ring ${ringIndex}; using an in-process timer:`,
      error.message,
    );

    const timer = setTimeout(() => {
      // Required late so the fallback cannot create an import cycle.
      const { dispatchRing } = require("./ride-dispatch.service");
      dispatchRing({ rideId, ringIndex, attempt }).catch((dispatchError) =>
        console.error(
          `[DISPATCH] in-process ring ${ringIndex} for ride ${rideId} failed:`,
          dispatchError.message,
        ),
      );
    }, delayMs);

    timer.unref?.();
    return null;
  }
}

/**
 * Close the rider's decision window if they never answer.
 *
 * A bare `setTimeout` is not enough here: the window has to survive a deploy,
 * or a restart mid-offer leaves the ride hanging until its session TTL. The
 * in-process fallback is the same degraded path the ring ladder takes, for the
 * same reason — a window that might be lost on restart still beats no window.
 */
async function enqueueUpgradeDecision({ rideId, attempt = 0, delayMs }) {
  const jobId = makeUpgradeJobId(rideId, attempt);

  try {
    const queue = queueService.getQueue(QUEUES.RIDE_DISPATCH);

    return await queue.add(
      UPGRADE_JOB_NAME,
      { rideId, attempt },
      {
        jobId,
        delay: delayMs,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  } catch (error) {
    console.error(
      `[DISPATCH] queue unavailable for the upgrade window on ride ${rideId}; using an in-process timer:`,
      error.message,
    );

    const timer = setTimeout(() => {
      const { expireCategoryUpgrade } = require("./ride-upgrade.service");
      expireCategoryUpgrade({ rideId, attempt }).catch((expiryError) =>
        console.error(
          `[DISPATCH] in-process upgrade window for ride ${rideId} failed:`,
          expiryError.message,
        ),
      );
    }, delayMs);

    timer.unref?.();
    return null;
  }
}

/**
 * Drop the decision window once the rider has answered. Unlike a stale ring,
 * this one matters: the job would otherwise settle an offer that is already
 * being accepted.
 */
async function cancelUpgradeDecision({ rideId, attempt = 0 }) {
  try {
    const queue = queueService.getQueue(QUEUES.RIDE_DISPATCH);
    const job = await queue.getJob(makeUpgradeJobId(rideId, attempt));
    if (job) await job.remove();
  } catch (error) {
    console.error(
      `[DISPATCH] could not clear the upgrade window for ride ${rideId}:`,
      error.message,
    );
  }
}

/**
 * Drop whatever ring is still queued for a ride. The dispatcher re-checks the
 * ride status and its search generation on every entry, so a leftover job is
 * already harmless — removing it just keeps the queue clean.
 */
async function cancelPendingRings({ rideId, upToRing = 12, attempt = 0 }) {
  try {
    const queue = queueService.getQueue(QUEUES.RIDE_DISPATCH);

    await Promise.all(
      Array.from({ length: upToRing }, async (_, ringIndex) => {
        const job = await queue.getJob(makeJobId(rideId, ringIndex, attempt));
        if (job) await job.remove();
      }),
    );
  } catch (error) {
    console.error(
      `[DISPATCH] could not clear queued rings for ride ${rideId}:`,
      error.message,
    );
  }
}

module.exports = {
  JOB_NAME,
  UPGRADE_JOB_NAME,
  cancelPendingRings,
  cancelUpgradeDecision,
  enqueueNextRing,
  enqueueUpgradeDecision,
  makeJobId,
  makeUpgradeJobId,
};
