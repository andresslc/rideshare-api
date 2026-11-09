const ConfigModel = require("./model/config.model");
const { NotFoundError } = require("../../core/common/exceptions");

const getConfig = async () => {
  const config = await ConfigModel.findOne().lean();

  if (!config) {
    throw new NotFoundError("Config not found");
  }

  return {
    data: config,
  };
};

module.exports = {
  getConfig,
};