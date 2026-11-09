const { redeemCode } = require("./promo-code.service");

const redeemCodeController = async (req, res) => {
  const result = await redeemCode({
    ...req.body,
    userId: req.user._id,
  });
  return { data: result }; // Express wrapper will catchAsync and format response
};

module.exports = {
  redeemCodeController,
};
