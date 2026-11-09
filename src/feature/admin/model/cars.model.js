const { Schema, models, model } = require("mongoose");

const carSchema = new Schema({
  type: {
    type: String,
    required: true,
    lowercase: true,
  },
  ride: {
    type: String,
    required: true,
    lowercase: true,
    enum: ["economy", "luxury"],
  },
});
