const fs = require("fs");
const path = require("path");

class WorkerLoader {
  constructor() {
    this.workers = [];
  }

  loadWorkersFromFeatures(featuresPath) {
    const featureDirs = fs.readdirSync(featuresPath);

    featureDirs.forEach((feature) => {
      const featurePath = path.join(featuresPath, feature);
      if (fs.statSync(featurePath).isDirectory()) {
        fs.readdirSync(featurePath).forEach((file) => {
          if (file.endsWith(".worker.js")) {
            const worker = require(path.join(featurePath, file));
            this.workers.push(worker);
            console.log(`📦 Loaded worker: ${feature}/${file}`);
          }
        });
      }
    });

    return this.workers;
  }
}

module.exports = new WorkerLoader();
