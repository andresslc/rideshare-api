const fs = require("fs");
const path = require("path");
class CronService {
  static instance;
  crons = [];

  constructor() {
    if (CronService.instance) return CronService.instance;
    CronService.instance = this;
  }

  /**
   * Auto-load cron files from features
   * @param {*} featuresPath
   */
  loadCrons(featuresPath) {
    const featureDirs = fs.readdirSync(featuresPath);

    featureDirs.forEach((feature) => {
      const featurePath = path.join(featuresPath, feature);
      if (fs.statSync(featurePath).isDirectory()) {
        fs.readdirSync(featurePath).forEach((file) => {
          if (file.endsWith(".cron.js")) {
            const cronModule = require(path.join(featurePath, file));
            if (cronModule.init) {
              cronModule.init(); // init function should register cron tasks
              this.crons.push(cronModule);
              console.log(`⏰ Loaded cron: ${feature}/${file}`);
            }
          }
        });
      }
    });

    return this.crons;
  }
}

module.exports = new CronService();
