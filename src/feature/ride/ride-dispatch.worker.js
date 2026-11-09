const { Worker } = require("bullmq");
const { QUEUES } = require("../../core/common/constants");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const { dispatchRing } = require("./ride-dispatch.service");
const { JOB_NAME, UPGRADE_JOB_NAME } = require("./ride-dispatch.producer");

const baseConnection = getRedisConnection();
const connection = baseConnection.duplicate({
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  QUEUES.RIDE_DISPATCH,
  async (job) => {
    // `attempt` defaults to 0 so jobs queued by the previous release — which
    // carry no generation at all — keep draining correctly through a deploy.
    const attempt = job.data.attempt ?? 0;

    // `io` is resolved inside the handlers: a Socket.IO server cannot travel
    // through the queue.
    if (job.name === JOB_NAME) {
      return dispatchRing({
        rideId: job.data.rideId,
        ringIndex: job.data.ringIndex,
        attempt,
      });
    }

    if (job.name === UPGRADE_JOB_NAME) {
      // Required late: the upgrade service reaches back into the dispatcher.
      const { expireCategoryUpgrade } = require("./ride-upgrade.service");
      return expireCategoryUpgrade({ rideId: job.data.rideId, attempt });
    }

    throw new Error(`Unknown ride-dispatch job: ${job.name}`);
  },
  { connection, concurrency: 10 },
);

worker.on("failed", (job, error) => {
  console.error(
    `Ride-dispatch job failed: ${job?.id} (ride ${job?.data?.rideId}, ring ${job?.data?.ringIndex})`,
    error,
  );
});

module.exports = worker;
