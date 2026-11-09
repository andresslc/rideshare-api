const env = require("../../../config");

const INTERNAL_IDENTITY_DOMAINS = Object.freeze([
  "yopmail.com",
  "mailinator.com",
]);
const INTERNAL_ADMIN_BYPASS_DOMAINS = Object.freeze(["yopmail.com"]);

const getEmailDomain = (email) => {
  if (typeof email !== "string") return null;

  const normalizedEmail = email.trim().toLowerCase();
  const separatorIndex = normalizedEmail.lastIndexOf("@");

  if (separatorIndex <= 0 || separatorIndex === normalizedEmail.length - 1) {
    return null;
  }

  return normalizedEmail.slice(separatorIndex + 1);
};

const hasExactEmailDomain = (email, domains) => {
  const domain = getEmailDomain(email);
  return domain !== null && domains.includes(domain);
};

const isInternalIdentityEmail = (email) =>
  hasExactEmailDomain(email, INTERNAL_IDENTITY_DOMAINS);

const isInternalAdminEmail = (email) =>
  hasExactEmailDomain(email, INTERNAL_ADMIN_BYPASS_DOMAINS);

const shouldRestrictInternalData = (adminUser, nodeEnv = env.NODE_ENV) =>
  (nodeEnv === "staging" || nodeEnv === "production") &&
  !isInternalAdminEmail(adminUser?.email);

const INTERNAL_IDENTITY_EMAIL_PATTERN = new RegExp(
  `@(${INTERNAL_IDENTITY_DOMAINS.map((domain) =>
    domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})$`,
  "i",
);

const getVisibleIdentityEmailFilter = (
  adminUser,
  field = "email",
  nodeEnv = env.NODE_ENV,
) =>
  shouldRestrictInternalData(adminUser, nodeEnv)
    ? { [field]: { $not: INTERNAL_IDENTITY_EMAIL_PATTERN } }
    : {};

const getInternalIdentityEmailFilter = () => ({
  email: INTERNAL_IDENTITY_EMAIL_PATTERN,
});

const combineMongoFilters = (...filters) => {
  const populatedFilters = filters.filter(
    (filter) => filter && Object.keys(filter).length > 0,
  );

  if (populatedFilters.length === 0) return {};
  if (populatedFilters.length === 1) return populatedFilters[0];
  return { $and: populatedFilters };
};

const getRideIdentityFilter = ({ userIds, driverIds }) => ({
  ...(userIds.length > 0 && { user: { $nin: userIds } }),
  ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
});

const getCarpoolRouteIdentityFilter = ({ driverIds }) => ({
  ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
});

const getCarpoolBookingIdentityFilter = ({ userIds, driverIds }) => ({
  ...(userIds.length > 0 && { passenger: { $nin: userIds } }),
  ...(driverIds.length > 0 && { driver: { $nin: driverIds } }),
});

const getTransactionIdentityFilter = ({ userIds, driverIds }) => {
  const excludedActors = [];
  if (userIds.length > 0) {
    excludedActors.push({ userType: "User", user: { $in: userIds } });
  }
  if (driverIds.length > 0) {
    excludedActors.push({ userType: "Driver", user: { $in: driverIds } });
  }
  return excludedActors.length > 0 ? { $nor: excludedActors } : {};
};

const getReportIdentityFilter = ({ userIds, driverIds }) => {
  const excludedActors = [];
  if (userIds.length > 0) {
    excludedActors.push(
      { reporterType: "User", reporter: { $in: userIds } },
      { entityType: "User", entityId: { $in: userIds } },
    );
  }
  if (driverIds.length > 0) {
    excludedActors.push(
      { reporterType: "Driver", reporter: { $in: driverIds } },
      { entityType: "Driver", entityId: { $in: driverIds } },
    );
  }
  return excludedActors.length > 0 ? { $nor: excludedActors } : {};
};

const getReviewIdentityFilter = ({ userIds, driverIds }) => {
  const excludedActors = [];
  if (userIds.length > 0) {
    excludedActors.push(
      { reviewerType: "User", reviewer: { $in: userIds } },
      { receiverType: "User", receiver: { $in: userIds } },
    );
  }
  if (driverIds.length > 0) {
    excludedActors.push(
      { reviewerType: "Driver", reviewer: { $in: driverIds } },
      { receiverType: "Driver", receiver: { $in: driverIds } },
    );
  }
  return excludedActors.length > 0 ? { $nor: excludedActors } : {};
};

module.exports = {
  INTERNAL_IDENTITY_DOMAINS,
  INTERNAL_ADMIN_BYPASS_DOMAINS,
  INTERNAL_IDENTITY_EMAIL_PATTERN,
  getEmailDomain,
  isInternalIdentityEmail,
  isInternalAdminEmail,
  shouldRestrictInternalData,
  getVisibleIdentityEmailFilter,
  getInternalIdentityEmailFilter,
  combineMongoFilters,
  getRideIdentityFilter,
  getCarpoolRouteIdentityFilter,
  getCarpoolBookingIdentityFilter,
  getTransactionIdentityFilter,
  getReportIdentityFilter,
  getReviewIdentityFilter,
};
