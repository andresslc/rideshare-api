const crypto = require("node:crypto");

// No 0/O or 1/I: the code is read aloud and typed from a screenshot, and those
// pairs are exactly the ones people get wrong. 32 symbols over 7 characters is
// ~34 billion codes, so a collision is a retry, not a design problem.
const REFERRAL_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REFERRAL_CODE_LENGTH = 7;

const REFERRAL_STATUS = {
  // Saved to the rider's profile, waiting for their first ride.
  SAVED: "saved",
  // Attached to a ride that has not finished yet.
  APPLIED: "applied",
  // The ride completed and the code's owner was paid. Final.
  COMPLETED: "completed",
  // The ride was cancelled after the rider had already been charged the
  // discounted fare. The rider got the benefit, so the code is used up, but
  // the ride never finished, so the owner is not paid. Final.
  VOIDED: "voided",
};

const REFERRAL_STATUS_ENUM = Object.values(REFERRAL_STATUS);

/**
 * Whether a ride that ended without completing hands the code back.
 *
 * The rider is charged when the ride starts, not when it ends. Before that
 * nothing was paid, so the code goes back whoever cancelled. After it, the
 * discount has already been given; handing the code back would give it twice.
 * A payment that failed never charged anyone, so it counts as not charged.
 */
function shouldReturnReferralCode({ previousStatus, paymentStatus }) {
  const riderWasCharged =
    previousStatus === "in-progress" || paymentStatus === "completed";

  return !riderWasCharged;
}

const REFERRAL_BONUS_PURPOSE = "driver_referral_bonus";

const normalizeMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

function generateReferralCode(randomInt = crypto.randomInt) {
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i += 1) {
    code += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * What the rider typed, the way it is stored. Spaces and dashes are dropped
 * because people add them when copying a code out of a message.
 */
function normalizeReferralCode(code) {
  if (typeof code !== "string") return "";
  return code.replace(/[\s-]/g, "").toUpperCase();
}

function isWellFormedReferralCode(code) {
  return new RegExp(
    `^[${REFERRAL_CODE_ALPHABET}]{${REFERRAL_CODE_LENGTH}}$`,
  ).test(code);
}

/**
 * The three fare fields a referral ride carries.
 *
 * The discount is capped at the fare, so a ride cheaper than the discount is
 * free rather than negative. `originalRideFare` is what the driver is paid
 * (see `getRideDriverFare`), which is why it is always the full price.
 */
function computeReferralFare({ fullFare, discount }) {
  const originalRideFare = Math.max(normalizeMoney(fullFare), 0);
  const discountAmount = Math.min(
    Math.max(normalizeMoney(discount), 0),
    originalRideFare,
  );

  return {
    originalRideFare,
    discountAmount,
    rideFare: normalizeMoney(originalRideFare - discountAmount),
  };
}

/**
 * The full fare behind a request. When the app also sent a promo code, the
 * fare it sent is already discounted and the full price is the original; the
 * referral replaces the promo (they never stack), so it starts from that.
 */
function resolveFullRequestFare({ rideFare, originalRideFare, codeId }) {
  const original = normalizeMoney(originalRideFare);
  if (codeId && original > 0) return original;
  return normalizeMoney(rideFare);
}

function referralBonusIdentifierKey(rideId) {
  return `${REFERRAL_BONUS_PURPOSE}:${rideId}`;
}

module.exports = {
  REFERRAL_BONUS_PURPOSE,
  REFERRAL_CODE_ALPHABET,
  REFERRAL_CODE_LENGTH,
  REFERRAL_STATUS,
  REFERRAL_STATUS_ENUM,
  computeReferralFare,
  generateReferralCode,
  isWellFormedReferralCode,
  normalizeReferralCode,
  referralBonusIdentifierKey,
  resolveFullRequestFare,
  shouldReturnReferralCode,
};
