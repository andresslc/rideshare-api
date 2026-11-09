const { getPlan } = require("./plan.service.js");

const getPlanController = async (req, res) => {
  const product = await getPlan();
  return {
    data: product,
  };
};

module.exports = {
  getPlanController,
};
