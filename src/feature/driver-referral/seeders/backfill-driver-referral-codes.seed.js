const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

const DriverModel = require("../../driver/models/driver.model");
const { ensureDriverReferralCode } = require("../driver-referral.service");

// Gives every driver created before the driver-referral feature their code.
// Safe to re-run: drivers who already have one are skipped, and a driver who
// opens "My referral code" first is given one on the spot anyway.
//
//   npm run seed:driver-referral-codes

const run = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log(`✅ MongoDB connected → ${mongoose.connection.name}`);

    // The unique index must exist before any code is written, or two drivers
    // could be handed the same one. createIndexes, not syncIndexes: the latter
    // drops any index missing from the schema.
    await DriverModel.createIndexes();

    const cursor = DriverModel.find({ referralCode: { $exists: false } })
      .select("_id")
      .lean()
      .cursor();

    let assigned = 0;
    let failed = 0;

    for await (const driver of cursor) {
      try {
        await ensureDriverReferralCode(driver._id);
        assigned += 1;
      } catch (error) {
        failed += 1;
        console.error(`❌ ${driver._id}:`, error.message);
      }
    }

    console.log(`✅ Codes assigned: ${assigned}. Failed: ${failed}.`);
    process.exit(failed ? 1 : 0);
  } catch (error) {
    console.error("❌ Backfill failed:", error);
    process.exit(1);
  }
};

run();
