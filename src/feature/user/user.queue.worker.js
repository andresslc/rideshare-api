const { QUEUES } = require("../../core/common/constants");
const queueService = require("../../core/queues/queue.service");

class UserQueue {
  async add(name, data) {
    const queue = queueService.getQueue(QUEUES.USER);
    await queue.add(name, data, {
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}

module.exports = new UserQueue();
