const zod = require("zod");
const { default: mongoose } = require("mongoose");

const isValidObjectId = (val) => mongoose.Types.ObjectId.isValid(val);

// Flat, like every other socket validator: `validateOrFail` is handed the raw
// payload, not an express-shaped { body, query, params }.
const rideUpgradeDecisionValidator = zod
  .object({
    rideId: zod.string().refine(isValidObjectId, "Invalid ride ID format"),
    decision: zod.enum(["accept", "decline"], {
      errorMap: () => ({ message: "Decision must be 'accept' or 'decline'" }),
    }),
  })
  .strip();

module.exports = {
  rideUpgradeDecisionValidator,
};
