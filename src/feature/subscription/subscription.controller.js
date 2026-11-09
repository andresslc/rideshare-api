const {
  purchaseSubscription,
  cancelSubscription,
  subscriptionDetails,
} = require("./subscription.service");

const purchaseSubscriptionController = async (req, res) => {
  const driverId = req?.params?.id;
  const priceId = req.params.priceId;

  const result = await purchaseSubscription(priceId, driverId);

  return {
    data: { url: result },
  };
};

const cancelSubscriptionController = async (req, res) => {
  const driverId = req.user.id;
  const result = await cancelSubscription(driverId);

  return {
    message: "Subscription will be canceled at the end of the billing period",
    subscription: result,
  };
};

const subscriptionDetailsController = async (req, res) => {
  const driverId = req.params.id;
  const result = await subscriptionDetails(driverId);

  return {
    data: {
      subscription: result,
    },
  };
};

module.exports = {
  purchaseSubscriptionController,
  cancelSubscriptionController,
  subscriptionDetailsController,
};
