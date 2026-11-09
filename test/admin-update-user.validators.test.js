const assert = require("node:assert/strict");
const test = require("node:test");

const {
  updateUserOrDriverValidator,
} = require("../src/feature/admin/dto/user.validators");
const { maskSsn } = require("../src/core/common/helpers/ssn.helper");

const USER_ID = "64b7f0c2a1b2c3d4e5f60718";
const asRequest = (body) => ({ body, query: {}, params: { id: USER_ID } });
const parse = (body) => updateUserOrDriverValidator.safeParse(asRequest(body));

test("phone is normalized to digits with country code", () => {
  const result = parse({ type: "driver", phone: "+1 (305) 555-1234" });

  assert.equal(result.success, true);
  assert.equal(result.data.body.phone, "13055551234");
});

test("phoneNumber is accepted as an alias of phone", () => {
  const result = parse({ phoneNumber: "13055551234" });

  assert.equal(result.success, true);
  assert.equal(result.data.body.phone, "13055551234");
  assert.equal("phoneNumber" in result.data.body, false);
});

test("phone wins when phone and phoneNumber are both sent", () => {
  const result = parse({ phone: "13055551234", phoneNumber: "13055559999" });

  assert.equal(result.data.body.phone, "13055551234");
});

test("a phone number that is too short is rejected", () => {
  assert.equal(parse({ phone: "555-1234" }).success, false);
});

test("SSN is stored as nine digits", () => {
  const result = parse({ type: "driver", ssn: "123-45-6789" });

  assert.equal(result.success, true);
  assert.equal(result.data.body.ssn, "123456789");
});

test("an SSN without nine digits is rejected", () => {
  assert.equal(parse({ type: "driver", ssn: "12345678" }).success, false);
  assert.equal(parse({ type: "driver", ssn: "12345678a" }).success, false);
});

test("SSN cannot be set on a rider", () => {
  const result = parse({ type: "rider", ssn: "123456789" });

  assert.equal(result.success, false);
  assert.deepEqual(result.error.issues[0].path, ["body", "ssn"]);
});

test("SSN cannot be set when type is missing, which means rider", () => {
  assert.equal(parse({ ssn: "123456789" }).success, false);
});

test("address fields are trimmed and an empty string is allowed", () => {
  const result = parse({
    address: "  100 Main St  ",
    city: "Miami",
    state: "",
  });

  assert.equal(result.success, true);
  assert.equal(result.data.body.address, "100 Main St");
  assert.equal(result.data.body.state, "");
});

test("fields outside the allow-list are dropped", () => {
  const result = parse({
    firstName: "Ana",
    stripeCustomerId: "cus_123",
    rating: 5,
    isDeactivatedByAdmin: true,
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.body, { firstName: "Ana" });
});

test("a body with nothing to update is rejected", () => {
  assert.equal(parse({}).success, false);
  assert.equal(parse({ type: "driver" }).success, false);
  assert.equal(parse({ rating: 5 }).success, false);
});

test("an invalid user id is rejected", () => {
  const result = updateUserOrDriverValidator.safeParse({
    body: { firstName: "Ana" },
    query: {},
    params: { id: "not-an-id" },
  });

  assert.equal(result.success, false);
});

test("maskSsn only shows the last four digits", () => {
  assert.equal(maskSsn("123456789"), "***-**-6789");
  assert.equal(maskSsn("123-45-6789"), "***-**-6789");
  assert.equal(maskSsn(null), null);
  assert.equal(maskSsn(""), null);
  assert.equal(maskSsn("12"), null);
});
