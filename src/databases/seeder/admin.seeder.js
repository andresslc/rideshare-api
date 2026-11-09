const AppConfigModel = require("../../feature/admin/models/admin-config");

const seedAppConfig = async () => {
  try {
    // Optional: ensure only ONE config exists
    await AppConfigModel.deleteMany({});

    const config = await AppConfigModel.create({
      platformFee: 10,
    });

    console.log("✅ AppConfig seeded successfully:", config);
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeder failed:", error);
    process.exit(1);
  }
};

module.exports = { seedAppConfig };
