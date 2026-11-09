const BALANCE_SOURCES = {
  REGULAR: "regular",
  REWARDED: "rewarded",
  MIXED: "mixed",
};

function normalizeMoney(value) {
  const number = Number(value || 0);
  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function getWalletAllocation(wallet, amount, options = {}) {
  const requestedAmount = normalizeMoney(amount);
  const regularBalance = Math.max(0, normalizeMoney(wallet.balance));
  const rewardedBalance = Math.max(0, normalizeMoney(wallet.rewardedBalance));
  const pendingBalance = Math.max(0, normalizeMoney(options.pendingBalance));
  const pendingRewardedBalance = Math.max(
    0,
    Math.min(pendingBalance, normalizeMoney(options.pendingRewardedBalance)),
  );

  const availableRegularBalance = Math.max(
    0,
    normalizeMoney(regularBalance - (pendingBalance - pendingRewardedBalance)),
  );
  const availableRewardedBalance = Math.max(
    0,
    normalizeMoney(rewardedBalance - pendingRewardedBalance),
  );
  const availableBalance = normalizeMoney(
    availableRegularBalance + availableRewardedBalance,
  );

  if (requestedAmount <= 0) return null;
  if (!options.allowNegativeBalance && availableBalance < requestedAmount) {
    return null;
  }

  const availableRegularAmount = Math.min(
    requestedAmount,
    availableRegularBalance,
  );
  const rewardedAmount = Math.min(
    normalizeMoney(requestedAmount - availableRegularAmount),
    availableRewardedBalance,
  );
  // An overdraft is always assigned to the regular balance because rewardedBalance
  // is not allowed to become negative by the user and transaction schemas.
  const regularAmount = normalizeMoney(requestedAmount - rewardedAmount);

  return {
    regularAmount: normalizeMoney(regularAmount),
    rewardedAmount,
    isRewarded: rewardedAmount > 0,
    balanceSource:
      rewardedAmount === 0
        ? BALANCE_SOURCES.REGULAR
        : regularAmount === 0
          ? BALANCE_SOURCES.REWARDED
          : BALANCE_SOURCES.MIXED,
  };
}

function transactionRewardFields(allocation) {
  return {
    rewardedAmount: allocation.rewardedAmount,
    isRewarded: allocation.isRewarded,
    balanceSource: allocation.balanceSource,
  };
}

module.exports = {
  BALANCE_SOURCES,
  getWalletAllocation,
  normalizeMoney,
  transactionRewardFields,
};
