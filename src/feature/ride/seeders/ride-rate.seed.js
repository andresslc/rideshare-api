const RideRate = require("../model/ride-rate.model");
const PeakWindow = require("../model/peak-window.model");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

const seedRates = async () => {
  await RideRate.deleteMany({});

  await RideRate.create([
    {
      rideType: "luxury",
      peakSurchargePerMile: 0.25,
      brackets: [
        { minMiles: 0, maxMiles: 5, ratePerMile: 2.75 },
        { minMiles: 5, maxMiles: 10, ratePerMile: 1.83 },
        { minMiles: 10, maxMiles: 15, ratePerMile: 1.79 },
        { minMiles: 15, maxMiles: 20, ratePerMile: 1.5 },
        { minMiles: 20, maxMiles: null, ratePerMile: 1.3 },
      ],
    },
    {
      rideType: "economy",
      peakSurchargePerMile: 0.25,
      brackets: [
        { minMiles: 0, maxMiles: 5, ratePerMile: 2.45 },
        { minMiles: 5, maxMiles: 10, ratePerMile: 1.47 },
        { minMiles: 10, maxMiles: 15, ratePerMile: 1.45 },
        { minMiles: 15, maxMiles: 20, ratePerMile: 1.22 },
        { minMiles: 20, maxMiles: null, ratePerMile: 1.16 },
      ],
    },
  ]);

  console.log("Rates seeded");
};

const seedPeakWindows = async () => {
  await PeakWindow.deleteMany({});

  await PeakWindow.insertMany([
    { startHour: 6, endHour: 9, isActive: true },
    { startHour: 15, endHour: 19, isActive: true },
  ]);

  console.log("Peak windows seeded");
};

const runSeeder = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");

    await seedRates();
    await seedPeakWindows();

    console.log("All data seeded successfully");
    process.exit(0);
  } catch (error) {
    console.error("Seeding failed:", error);
    process.exit(1);
  }
};

runSeeder();
