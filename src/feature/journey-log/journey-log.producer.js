const crypto = require("crypto");
const { QUEUES } = require("../../core/common/constants");
const queueService = require("../../core/queues/queue.service");
const {
  recordJourneyEventWithDriverLocation,
} = require("./journey-log.service");

const JOB_NAME = "record_event_with_driver_location";

function makeJobId(dedupeKey) {
  if (!dedupeKey) return undefined;
  // Hashing avoids both BullMQ's ':' restriction and collisions introduced by
  // replacing punctuation in otherwise distinct dedupe keys.
  return `journey-${crypto.createHash("sha256").update(dedupeKey).digest("hex")}`;
}

async function enqueueJourneyEventWithDriverLocation(
  data,
  driverId,
  options = {},
) {
  // Mongo sessions cannot be serialized or moved outside their transaction.
  if (options.session) {
    return recordJourneyEventWithDriverLocation(data, driverId, options);
  }

  try {
    const queue = queueService.getQueue(QUEUES.JOURNEY_LOG);
    return await queue.add(
      JOB_NAME,
      { data, driverId: driverId?.toString() || null },
      {
        jobId: makeJobId(data.dedupeKey),
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  } catch (error) {
    // Preserve audit data during startup or when BullMQ is unavailable.
    console.error(
      "Journey queue unavailable; writing synchronously:",
      error.message,
    );
    return recordJourneyEventWithDriverLocation(data, driverId, options);
  }
}

module.exports = {
  JOB_NAME,
  makeJobId,
  enqueueJourneyEventWithDriverLocation,
};
