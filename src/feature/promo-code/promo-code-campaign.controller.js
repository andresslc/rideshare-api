const PromoCodeCampaignService = require("./promo-code-campaign.service");

const createCampaignController = async (req, res) => {
  const result = await PromoCodeCampaignService.createCampaign(req.body);
  return result;
};

const updateCampaignController = async (req, res) => {
  const result = await PromoCodeCampaignService.updateCampaign(
    req.params.id,
    req.body,
  );
  return {
    data: result,
  };
};

const updateCampaignStatusController = async (req, res) => {
  const result = await PromoCodeCampaignService.updateCampaignStatus(
    req.params.id,
    req.body.status,
  );
  return {
    data: result,
  };
};

const deleteCampaignController = async (req, res) => {
  const result = await PromoCodeCampaignService.deleteCampaign(req.params.id);
  return {
    data: result,
  };
};

const getAllCampaignsController = async (req, res) => {
  const result = await PromoCodeCampaignService.getAllCampaigns(
    req.query,
    req.user,
  );
  return {
    data: result,
  };
};

const getCampaignByIdController = async (req, res) => {
  const result = await PromoCodeCampaignService.getCampaignById(
    req.params.id,
    req.user,
  );
  return {
    data: result,
  };
};

const getCampaignCodesController = async (req, res) => {
  const result = await PromoCodeCampaignService.getCampaignCodes(
    req.params.id,
    req.query,
  );
  return {
    data: result,
  };
};

module.exports = {
  createCampaignController,
  updateCampaignController,
  updateCampaignStatusController,
  deleteCampaignController,
  getAllCampaignsController,
  getCampaignByIdController,
  getCampaignCodesController,
};
