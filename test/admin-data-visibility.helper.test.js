const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getEmailDomain,
  isInternalIdentityEmail,
  isInternalAdminEmail,
  shouldRestrictInternalData,
  getVisibleIdentityEmailFilter,
  combineMongoFilters,
  getRideIdentityFilter,
  getCarpoolRouteIdentityFilter,
  getCarpoolBookingIdentityFilter,
  getTransactionIdentityFilter,
  getReportIdentityFilter,
} = require("../src/feature/admin/admin-data-visibility.helper");

test("matches only exact internal identity email domains", () => {
  assert.equal(isInternalIdentityEmail("rider@yopmail.com"), true);
  assert.equal(isInternalIdentityEmail("DRIVER@MAILINATOR.COM"), true);
  assert.equal(isInternalIdentityEmail("rider@sub.yopmail.com"), false);
  assert.equal(isInternalIdentityEmail("rider@yopmail.com.example"), false);
});

test("grants the admin bypass only to exact yopmail.com addresses", () => {
  assert.equal(isInternalAdminEmail("ops@yopmail.com"), true);
  assert.equal(isInternalAdminEmail("ops@mailinator.com"), false);
  assert.equal(isInternalAdminEmail("ops@sub.yopmail.com"), false);
});

test("restricts only ordinary production admins", () => {
  assert.equal(
    shouldRestrictInternalData({ email: "client@example.com" }, "production"),
    true,
  );
  assert.equal(
    shouldRestrictInternalData({ email: "internal@yopmail.com" }, "production"),
    false,
  );
  assert.equal(
    shouldRestrictInternalData({ email: "client@example.com" }, "staging"),
    false,
  );
  assert.equal(
    shouldRestrictInternalData({ email: "client@example.com" }, "development"),
    false,
  );
});

test("builds a production email filter without overwriting existing filters", () => {
  const emailFilter = getVisibleIdentityEmailFilter(
    {
      email: "client@example.com",
    },
    "email",
    "production",
  );
  const combined = combineMongoFilters(
    { isDeleted: false },
    { $or: [{ firstName: /alex/i }, { email: /alex/i }] },
    emailFilter,
  );

  assert.deepEqual(combined, {
    $and: [
      { isDeleted: false },
      { $or: [{ firstName: /alex/i }, { email: /alex/i }] },
      emailFilter,
    ],
  });
});

test("extracts normalized domains from valid emails", () => {
  assert.equal(getEmailDomain(" Person@Example.COM "), "example.com");
  assert.equal(getEmailDomain("invalid"), null);
});

test("hides a ride when either its rider or driver is internal", () => {
  assert.deepEqual(
    getRideIdentityFilter({
      userIds: ["hidden-user"],
      driverIds: ["hidden-driver"],
    }),
    {
      user: { $nin: ["hidden-user"] },
      driver: { $nin: ["hidden-driver"] },
    },
  );
});

test("keeps a visible driver's carpool route while hiding internal bookings", () => {
  const identityIds = {
    userIds: ["hidden-passenger"],
    driverIds: ["hidden-driver"],
  };

  assert.deepEqual(getCarpoolRouteIdentityFilter(identityIds), {
    driver: { $nin: ["hidden-driver"] },
  });
  assert.deepEqual(getCarpoolBookingIdentityFilter(identityIds), {
    passenger: { $nin: ["hidden-passenger"] },
    driver: { $nin: ["hidden-driver"] },
  });
});

test("filters polymorphic money and report associations", () => {
  const identityIds = {
    userIds: ["hidden-user"],
    driverIds: ["hidden-driver"],
  };

  assert.deepEqual(getTransactionIdentityFilter(identityIds), {
    $nor: [
      { userType: "User", user: { $in: ["hidden-user"] } },
      { userType: "Driver", user: { $in: ["hidden-driver"] } },
    ],
  });
  assert.deepEqual(getReportIdentityFilter(identityIds), {
    $nor: [
      { reporterType: "User", reporter: { $in: ["hidden-user"] } },
      { entityType: "User", entityId: { $in: ["hidden-user"] } },
      { reporterType: "Driver", reporter: { $in: ["hidden-driver"] } },
      { entityType: "Driver", entityId: { $in: ["hidden-driver"] } },
    ],
  });
});
