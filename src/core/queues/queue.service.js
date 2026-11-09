const { Queue } = require("bullmq");
const { getRedisConnection } = require("../services/redis/redis.service");
const { REDIS, BULLMQ } = require("../../../config");
const { QUEUES } = require("../common/constants");

class QueueService {
  static instance;
  queues = {};
  initialized = false;

  constructor() {
    if (QueueService.instance) return QueueService.instance;
    QueueService.instance = this;
  }

  async initialize() {
    if (this.initialized) return this.queues;
    if (!REDIS.IS_ENABLED || !BULLMQ.IS_ENABLED)
      throw new Error(`Redis or BullMQ is disabled in config`);

    const connection = getRedisConnection();

    for (const name of Object.values(QUEUES)) {
      this.queues[name] = new Queue(name, {
        connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
        },
      });
      console.log(`✅ Queue ready: ${name}`);
    }

    this.initialized = true;
    return this.queues;
  }

  getQueue(name) {
    if (!this.queues[name]) throw new Error(`Queue not initialized: ${name}`);
    return this.queues[name];
  }
}

module.exports = new QueueService();
