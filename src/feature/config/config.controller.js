const ConfigService = require("./config.service");

const getConfigController = async (req, res) => {
  const result = await ConfigService.getConfig();
  return result;
};

module.exports = {
  getConfigController,
};