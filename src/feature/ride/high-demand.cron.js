const cron = require('node-cron');
const { runHighDemandCheck } = require('./high-demand.service');
const { CRON_SCHEDULE } = require('./high-demand-constants');

const init = () => {
  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      let io = null;
      try {
        const { socketService } = require('../../../app');
        io = socketService?.io || null;
      } catch (_) {}

      // await runHighDemandCheck(io);
    } catch (err) {
      console.error('[HIGH-DEMAND CRON] Error:', err?.message);
    }
  });
};

module.exports = { init };
