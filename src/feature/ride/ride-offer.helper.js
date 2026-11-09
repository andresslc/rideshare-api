const { getWalletAllocation } = require("../wallet/wallet.service");

const canAffordRideOffer = (wallet, fare, paymentMethod) => {
  if (paymentMethod !== "wallet") return true;
  return Boolean(wallet && getWalletAllocation(wallet, fare));
};

module.exports = { canAffordRideOffer };
