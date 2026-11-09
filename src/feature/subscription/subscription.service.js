const {
  NotFoundError,
  BadRequestError,
} = require("../../core/common/exceptions");
const stripeService = require("../../core/services/stripe/stripe.service");
const DriverModel = require("../driver/models/driver.model");
const SubscriptionModel = require("./models/subscription.model");
const { t } = require("../../core/common/helpers/index");

const purchaseSubscription = async (priceId, driverId) => {
  const driver = await DriverModel.findById(driverId).populate(
    "signUpRecord subscription",
  );

  if (!driver) {
    throw new NotFoundError(t("DRIVER_NOT_FOUND"));
  }

  if (driver?.subscription?.status === "active") {
    throw new BadRequestError(t("ACTIVE_SUBSCRIPTION_EXISTS", driver.locale));
  }

  const result = await stripeService.purchaseSubscription(priceId, {
    driverId,
  });

  return result;
};

const cancelSubscription = async (driverId) => {
  const driver = await DriverModel.findById(driverId).populate("subscription");

  if (!driver) {
    throw new NotFoundError(t("DRIVER_NOT_FOUND"));
  }

  const subscription = await SubscriptionModel.findOne({ driver: driverId });

  if (!subscription) {
    throw new NotFoundError(
      t("SUBSCRIPTION_NOT_FOUND_FOR_DRIVER", driver.locale),
    );
  }

  if (subscription.cancelAtPeriodEnd || subscription.status === "canceled") {
    throw new BadRequestError(
      t("SUBSCRIPTION_ALREADY_CANCELED", driver.locale),
    );
  }

  const canceledSubscription = await stripeService.cancelSubscription(
    subscription.stripeSubscriptionId,
  );

  subscription.cancelAtPeriodEnd = canceledSubscription.cancel_at_period_end;
  subscription.status = canceledSubscription.status;
  subscription.canceledAt = canceledSubscription.canceled_at
    ? new Date(canceledSubscription.canceled_at * 1000)
    : null;

  await subscription.save();

  return subscription;
};

const subscriptionDetails = async (driverId) => {
  const driver = await DriverModel.findById(driverId).populate("subscription");

  if (!driver) {
    throw new NotFoundError(t("DRIVER_NOT_FOUND"));
  }

  const subscription = await SubscriptionModel.findOne({ driver: driverId });

  if (!subscription) {
    throw new NotFoundError(
      t("SUBSCRIPTION_NOT_FOUND_FOR_DRIVER", driver.locale),
    );
  }

  return subscription;
};

module.exports = {
  purchaseSubscription,
  cancelSubscription,
  subscriptionDetails,
};
