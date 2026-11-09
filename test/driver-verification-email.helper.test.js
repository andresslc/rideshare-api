const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDriverVerificationEmail,
} = require("../src/core/services/email/driver-verification-email.helper");

test("uses the all-approved email when the post-update count reaches four", () => {
  const email = buildDriverVerificationEmail({
    status: "approved",
    reviewedItems: [{ label: "Driver License" }],
    approvedCount: 4,
  });

  assert.equal(email.subject, "All Documents Approved - RideShare");
  assert.match(email.message, /access the RideShare app/);
});

test("uses the single-item progress email when approval remains incomplete", () => {
  const email = buildDriverVerificationEmail({
    status: "approved",
    reviewedItems: [{ label: "Driver License" }],
    approvedCount: 3,
  });

  assert.equal(email.subject, "Driver License Approved - RideShare");
  assert.match(email.message, /Driver License has been approved/);
  assert.match(email.message, /Progress: 3\/4 approved/);
});

test("groups multiple approvals into one progress email", () => {
  const email = buildDriverVerificationEmail({
    status: "approved",
    reviewedItems: [
      { label: "Driver License" },
      { label: "Insurance" },
      { label: "Vehicle" },
    ],
    approvedCount: 3,
  });

  assert.equal(email.subject, "Documents Approved - RideShare");
  assert.match(
    email.message,
    /3 documents \(Driver License, Insurance and Vehicle\) have been approved/,
  );
  assert.match(email.message, /Progress: 3\/4 approved/);
});

test("includes every item and reason in one rejection email", () => {
  const email = buildDriverVerificationEmail({
    status: "rejected",
    reviewedItems: [
      { label: "Insurance", rejectReason: "Policy expired" },
      { label: "Vehicle", rejectReason: "VIN could not be verified" },
    ],
    frontendUrl: "https://example.com",
  });

  assert.equal(email.subject, "Documents Verification Declined - RideShare");
  assert.match(email.message, /- Insurance: Policy expired/);
  assert.match(email.message, /- Vehicle: VIN could not be verified/);
  assert.match(email.message, /Link: https:\/\/example.com/);
});
