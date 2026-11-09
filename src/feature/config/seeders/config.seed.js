const mongoose = require("mongoose");
const dotenv = require("dotenv");
const ConfigModel = require("../model/config.model");

dotenv.config();

// The apps read this document from GET /api/config to decide whether the build
// on the phone is still allowed to run. Nothing else in the backend writes it,
// so this seeder is how a store release gets recorded.
//
//   node src/feature/config/seeders/config.seed.js \
//     --appVersion=3.0.2 --minSupportedVersion=3.0.2

const SEMVER = /^\d+\.\d+\.\d+$/;

const parseArgs = () => {
  const args = {};

  for (const raw of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(raw);
    if (match) args[match[1]] = match[2];
  }

  return args;
};

const run = async () => {
  const { appVersion, minSupportedVersion } = parseArgs();

  if (!SEMVER.test(appVersion || "")) {
    console.error("❌ Missing or invalid --appVersion (expected e.g. 3.0.2)");
    process.exit(1);
  }

  // Required on purpose. This is the value that locks older builds out, so it
  // is never defaulted on the operator's behalf.
  if (!SEMVER.test(minSupportedVersion || "")) {
    console.error(
      "❌ Missing or invalid --minSupportedVersion (expected e.g. 3.0.2)",
    );
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);

    const dbName = mongoose.connection.name;
    console.log(`✅ MongoDB connected → ${dbName}`);

    const total = await ConfigModel.countDocuments();

    if (total > 1) {
      console.error(
        `❌ Found ${total} config documents. The API reads whichever one ` +
          `findOne() returns, so this must be resolved by hand before seeding.`,
      );
      process.exit(1);
    }

    const existing = await ConfigModel.findOne().lean();

    console.log(
      "Before:",
      existing
        ? {
            appVersion: existing.appVersion,
            minSupportedVersion: existing.minSupportedVersion,
          }
        : "(no config document)",
    );

    // $set only the two version fields, so baseUrls, features and anything else
    // already configured survive a re-run.
    const updated = await ConfigModel.findOneAndUpdate(
      existing ? { _id: existing._id } : {},
      {
        $set: { appVersion, minSupportedVersion },
        $setOnInsert: { maintenanceMode: false },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();

    console.log("After: ", {
      appVersion: updated.appVersion,
      minSupportedVersion: updated.minSupportedVersion,
      maintenanceMode: updated.maintenanceMode,
    });

    console.log(existing ? "✅ Config updated" : "✅ Config created");
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
};

run();
