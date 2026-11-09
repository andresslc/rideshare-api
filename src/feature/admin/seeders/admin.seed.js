const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Admin = require("../model/admin.model");

dotenv.config();

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");

    const existingAdmin = await Admin.findOne({
      email: "admin@example.com",
    });

    if (existingAdmin) {
      console.log("⚠️ Super admin already exists");
      process.exit();
    }

    const admin = await Admin.create({
      name: "Super Admin",
      email: "admin@example.com",
      password: "Admin@123",
    });

    console.log("✅ Super Admin Created Successfully");
    console.log({
      email: admin.email,
      role: admin.role,
    });

    process.exit();
  } catch (error) {
    console.error("❌ Error seeding admin:", error);
    process.exit(1);
  }
};

seedAdmin();
