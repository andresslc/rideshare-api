const stripeService = require("../../core/services/stripe/stripe.service");

const getPlan = async () => {
  const product = await stripeService.getPlans();

  return product;
};

module.exports = {
  getPlan,
};
