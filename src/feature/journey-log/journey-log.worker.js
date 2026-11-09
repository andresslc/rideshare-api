const { Worker } = require("bullmq");
const { QUEUES } = require("../../core/common/constants");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  recordJourneyEventWithDriverLocation,
} = require("./journey-log.service");
const { JOB_NAME } = require("./journey-log.producer");

const baseConnection = getRedisConnection();
const connection = baseConnection.duplicate({
  maxRetriesPerRequest: null,
});

const worker = new Worker(
  QUEUES.JOURNEY_LOG,
  async (job) => {
    if (job.name !== JOB_NAME) {
      throw new Error(`Unknown journey-log job: ${job.name}`);
    }
    return recordJourneyEventWithDriverLocation(
      job.data.data,
      job.data.driverId,
    );
  },
  { connection, concurrency: 10 },
);

worker.on("failed", (job, error) => {
  console.error(`Journey-log job failed: ${job?.id}`, error);
});

module.exports = worker;
