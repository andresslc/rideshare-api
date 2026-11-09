const mongoose = require("mongoose");

const signupSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: ["user", "driver", "admin"],
    default: "user",
  },
  isDeleted: {
    type: Boolean,
    default: false,
  },
  isDeactivatedByAdmin: {
    type: Boolean,
    default: false,
  },
  isOnboarded: {
    type: Boolean,
    default: false,
  },
});

const SignupModel =
  mongoose.models.Signup || mongoose.model("Signup", signupSchema);
module.exports = SignupModel;
