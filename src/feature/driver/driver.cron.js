const { processActiveShifts } = require("./driver-shift.service");

class DriverShiftCron {
  static schedule() {
    // Get io from running app instance
    let io = null;
    try {
      const { socketService } = require("../../../app");
      io = socketService?.io || null;
    } catch (e) {
      // ignore; will retry emit safeguards inside service
    }

    setInterval(async () => {
      try {
        if (!io) {
          const { socketService } = require("../../../app");
          io = socketService?.io || null;
        }
        if (io) {
          await processActiveShifts(io);
        }
      } catch (err) {
        console.error("DriverShiftCron error:", err?.message);
      }
    }, 60 * 1000); // every 1 minute
  }
}

module.exports = {
  init: () => DriverShiftCron.schedule(),
};

