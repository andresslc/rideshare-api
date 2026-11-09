const { QUEUES } = require("../../core/common/constants");
const queueService = require("../../core/queues/queue.service");

class UserCron {
  static schedule() {
    const queue = queueService.getQueue(QUEUES.USER);

    // Add a repeatable job (example: run every 1 minute)
    queue.add(
      "daily_user_report",
      {},
      {
        repeat: { cron: "0 * * * *" }, // every hour
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}

module.exports = {
  init: () => UserCron.schedule(),
};
