const { Worker } = require("bullmq");
const { getRedisConnection } = require("../../common/redis.connection");
const UserService = require("./user.service");
const { QUEUES } = require("../../core/common/constants");

class UserWorker {
  constructor() {
    this.queueName = QUEUES.USER;
    this.connection = getRedisConnection();

    this.worker = new Worker(this.queueName, async (job) => this.process(job), {
      connection: this.connection,
      concurrency: 5,
    });

    this.worker.on("completed", (job) =>
      console.log(`✅ USER job completed: ${job.id}`),
    );
    this.worker.on("failed", (job, err) =>
      console.error(`❌ USER job failed: ${job.id}`, err),
    );
  }

  async process(job) {
    switch (job.name) {
      case "create_user":
      // return await UserService.createUser(job.data);
      case "update_user":
      // return await UserService.updateUser(job.data);
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }
}

module.exports = new UserWorker();
