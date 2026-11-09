const {
  getCampaignStats,
  getCampaignRedemptions,
  getUserRedemptionHistory,
} = require("./promo-code-analytics.service");

const getCampaignStatsController = async (req, res) => {
  const result = await getCampaignStats(req.params.id, req.user);
  return {
    data: result,
  };
};

const getCampaignRedemptionsController = async (req, res) => {
  const result = await getCampaignRedemptions(
    req.params.id,
    req.query,
    req.user,
  );
  return {
    data: result,
  };
};

const getUserRedemptionHistoryController = async (req, res) => {
  const result = await getUserRedemptionHistory(
    req.params.id,
    req.params.userId,
    req.user,
  );
  return {
    data: result,
  };
};

module.exports = {
  getCampaignStatsController,
  getCampaignRedemptionsController,
  getUserRedemptionHistoryController,
};
