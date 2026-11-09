const getDriverGateKey = (accountStatus, subscription) => {
  if (accountStatus === "incomplete") return "incomplete";
  if (accountStatus === "rejected") return "rejected";
  if (!subscription) return "subscription_not_purchased";
  if (subscription.status !== "active") return "inactive";
  if (accountStatus === "pending") return "under_review";

  return null;
};

module.exports = { getDriverGateKey };
