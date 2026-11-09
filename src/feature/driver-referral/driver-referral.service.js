const mongoose = require("mongoose");
const RiderReferralModel = require("./model/rider-referral.model");
const DriverModel = require("../driver/models/driver.model");
const RideModel = require("../ride/model/ride.model");
const CarpoolBookingModel = require("../carpool/model/carpool-booking.model");
const TransactionModel = require("../transactions/model/transaction.model");
const { BALANCE_SOURCES } = require("../wallet/wallet.service");
const {
  getDriverReferralConfiguration,
} = require("../config/ride-configuration.service");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { RIDE_STATUS } = require("../../core/common/constants/ride-constants");
const {
  CARPOOL_BOOKING_STATUS_ENUM,
} = require("../../core/common/constants/carpool-constants");
const { BadRequestError } = require("../../core/common/exceptions");
const { t } = require("../../core/common/helpers");
const {
  REFERRAL_BONUS_PURPOSE,
  REFERRAL_STATUS,
  computeReferralFare,
  generateReferralCode,
  isWellFormedReferralCode,
  normalizeReferralCode,
  referralBonusIdentifierKey,
} = require("./driver-referral.helper");

const TAG = "[DRIVER-REFERRAL]";
const MAX_CODE_ATTEMPTS = 8;

const isDuplicateKeyError = (error) => error?.code === 11000;

// ─── Driver codes ─────────────────────────────────────────────────────────────

/**
 * Give a driver their code if they do not have one yet, and return it.
 *
 * Runs outside any transaction on purpose: a duplicate-key error inside one
 * aborts the whole transaction, while here it is just a reason to draw again.
 * The `referralCode: { $exists: false }` filter makes a concurrent call harmless
 * — whichever write lands first wins and both callers read the same code back.
 */
async function ensureDriverReferralCode(driverId) {
  const existing = await DriverModel.findById(driverId)
    .select("referralCode")
    .lean();

  if (!existing) return null;
  if (existing.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateReferralCode();

    try {
      const updated = await DriverModel.findOneAndUpdate(
        { _id: driverId, referralCode: { $exists: false } },
        { $set: { referralCode: code } },
        { new: true },
      )
        .select("referralCode")
        .lean();

      if (updated) return updated.referralCode;

      // Someone else assigned one between the read and the write.
      const current = await DriverModel.findById(driverId)
        .select("referralCode")
        .lean();
      return current?.referralCode ?? null;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  throw new Error("DRIVER_REFERRAL_CODE_GENERATION_FAILED");
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/**
 * Whether the rider has already finished a trip of any kind. A completed
 * carpool counts: the code is for people who have never ridden with us.
 */
async function hasCompletedTrip(riderId, session = null) {
  const [ride, booking] = await Promise.all([
    RideModel.exists({
      user: riderId,
      rideStatus: RIDE_STATUS.COMPLETED,
    }).session(session),
    CarpoolBookingModel.exists({
      passenger: riderId,
      status: CARPOOL_BOOKING_STATUS_ENUM.COMPLETED,
    }).session(session),
  ]);

  return Boolean(ride || booking);
}

// ─── Rider side ───────────────────────────────────────────────────────────────

/**
 * Save a driver's code to the rider's profile. It is used automatically on
 * their next ride request, not here.
 *
 * `session` is passed during onboarding, where the rider and their referral are
 * written together. Every refusal is checked before the insert, because a
 * duplicate-key error would abort that transaction rather than just this call.
 */
async function saveReferralCodeForRider({
  riderId,
  code,
  locale = "en",
  session = null,
}) {
  const config = await getDriverReferralConfiguration();
  if (!config.enabled) {
    throw new BadRequestError(t("DRIVER_REFERRAL_DISABLED", locale));
  }

  const normalizedCode = normalizeReferralCode(code);
  if (!isWellFormedReferralCode(normalizedCode)) {
    throw new BadRequestError(t("DRIVER_REFERRAL_CODE_INVALID", locale));
  }

  const driver = await DriverModel.findOne({
    referralCode: normalizedCode,
    isDeleted: { $ne: true },
    isDeactivatedByAdmin: { $ne: true },
  })
    .select("_id firstName")
    .session(session)
    .lean();

  if (!driver) {
    throw new BadRequestError(t("DRIVER_REFERRAL_CODE_INVALID", locale));
  }

  const alreadySaved = await RiderReferralModel.exists({
    rider: riderId,
  }).session(session);
  if (alreadySaved) {
    throw new BadRequestError(t("DRIVER_REFERRAL_ALREADY_USED", locale));
  }

  if (await hasCompletedTrip(riderId, session)) {
    throw new BadRequestError(t("DRIVER_REFERRAL_NOT_ELIGIBLE", locale));
  }

  try {
    await RiderReferralModel.create(
      [
        {
          rider: riderId,
          driver: driver._id,
          code: normalizedCode,
          status: REFERRAL_STATUS.SAVED,
        },
      ],
      session ? { session } : {},
    );
  } catch (error) {
    // Two taps on "Apply" at once: the unique index lets one through.
    if (isDuplicateKeyError(error)) {
      throw new BadRequestError(t("DRIVER_REFERRAL_ALREADY_USED", locale));
    }
    throw error;
  }

  if (session) return null;

  return getRiderReferralStatus(riderId);
}

/**
 * What the rider app shows on the referral screen and uses to decide whether
 * the promo field is available.
 */
async function getRiderReferralStatus(riderId) {
  const [config, referral] = await Promise.all([
    getDriverReferralConfiguration(),
    RiderReferralModel.findOne({ rider: riderId })
      .populate("driver", "firstName")
      .lean(),
  ]);

  if (!referral) {
    const completedTrip = await hasCompletedTrip(riderId);

    return {
      status: "none",
      enabled: config.enabled,
      eligible: config.enabled && !completedTrip,
      riderDiscountAmount: config.riderDiscountAmount,
    };
  }

  return {
    status: referral.status,
    enabled: config.enabled,
    eligible: false,
    code: referral.code,
    driverFirstName: referral.driver?.firstName ?? null,
    // Once attached to a ride the snapshot is the truth; before that it is
    // whatever the configuration says today.
    riderDiscountAmount:
      referral.status === REFERRAL_STATUS.SAVED
        ? config.riderDiscountAmount
        : referral.riderDiscountAmount,
    rideId: referral.ride ?? null,
    appliedAt: referral.appliedAt,
    completedAt: referral.completedAt,
    voidedAt: referral.voidedAt ?? null,
  };
}

/**
 * The discount a saved referral would give on a fare, without claiming it.
 * Used for fare quotes and for checking the rider can pay what they will
 * actually be charged. `null` when nothing would apply.
 */
async function previewReferralDiscount(riderId, fullFare) {
  const config = await getDriverReferralConfiguration();
  if (!config.enabled) return null;

  const referral = await RiderReferralModel.exists({
    rider: riderId,
    status: REFERRAL_STATUS.SAVED,
  });
  if (!referral) return null;

  const pricing = computeReferralFare({
    fullFare,
    discount: config.riderDiscountAmount,
  });

  return pricing.discountAmount > 0 ? pricing : null;
}

// ─── Ride lifecycle ───────────────────────────────────────────────────────────

/**
 * Claim the rider's saved referral for a ride that is about to be created.
 *
 * The claim is one conditional update (saved -> applied), so two requests
 * racing each other cannot both get the discount. Returns the fare fields to
 * write onto the ride, or `null` when no referral applies.
 */
async function claimReferralForRide({ riderId, rideId, fullFare }) {
  const config = await getDriverReferralConfiguration();
  if (!config.enabled) return null;

  const pricing = computeReferralFare({
    fullFare,
    discount: config.riderDiscountAmount,
  });
  if (pricing.discountAmount <= 0) return null;

  // Checked again here, not only when the code was saved: the rider may have
  // finished a carpool trip since.
  if (await hasCompletedTrip(riderId)) return null;

  const referral = await RiderReferralModel.findOneAndUpdate(
    { rider: riderId, status: REFERRAL_STATUS.SAVED },
    {
      $set: {
        status: REFERRAL_STATUS.APPLIED,
        ride: rideId,
        riderDiscountAmount: config.riderDiscountAmount,
        driverBonusAmount: config.driverBonusAmount,
        appliedAt: new Date(),
      },
    },
    { new: true },
  ).lean();

  if (!referral) return null;

  return { referral, pricing };
}

/**
 * Hand the code back to the rider after a ride that did not complete. Safe to
 * call for any ride and more than once: only an `applied` referral pointing at
 * this exact ride is touched.
 */
async function releaseReferralForRide(rideId) {
  if (!rideId) return null;

  try {
    const released = await RiderReferralModel.findOneAndUpdate(
      { ride: rideId, status: REFERRAL_STATUS.APPLIED },
      {
        $set: {
          status: REFERRAL_STATUS.SAVED,
          ride: null,
          riderDiscountAmount: null,
          driverBonusAmount: null,
          appliedAt: null,
        },
      },
      { new: true },
    ).lean();

    if (released) {
      console.log(`${TAG} code handed back after ride ${rideId} ended`, {
        rider: released.rider,
      });
    }

    return released;
  } catch (error) {
    // Never fail a cancellation over this. The referral stays `applied` on a
    // dead ride, which support can see and reset.
    console.error(
      `${TAG} could not release referral for ride ${rideId}`,
      error,
    );
    return null;
  }
}

/**
 * Use the code up after a ride that was cancelled once the rider had already
 * been charged the discounted fare. The rider keeps the discount they paid
 * with; the owner is not paid, because the ride never finished. Safe to call
 * more than once, and never fails the cancellation.
 */
async function voidReferralForRide(rideId) {
  if (!rideId) return null;

  try {
    const voided = await RiderReferralModel.findOneAndUpdate(
      { ride: rideId, status: REFERRAL_STATUS.APPLIED },
      { $set: { status: REFERRAL_STATUS.VOIDED, voidedAt: new Date() } },
      { new: true },
    ).lean();

    if (voided) {
      console.log(
        `${TAG} code used up by ride ${rideId}, cancelled after the charge`,
        { rider: voided.rider },
      );
    }

    return voided;
  } catch (error) {
    console.error(`${TAG} could not void referral for ride ${rideId}`, error);
    return null;
  }
}

/**
 * Pay the code's owner once the referral ride has completed.
 *
 * The status move, the balance credit and the transaction are one database
 * transaction, so the bonus is paid exactly when the referral is marked done.
 * The unique `identifierKey` on the transaction is a second guard against a
 * double payment if this is ever reached twice for the same ride.
 */
async function settleReferralForCompletedRide(ride) {
  if (!ride?.riderReferral) return null;

  const session = await mongoose.startSession();
  let settled = null;

  try {
    await session.withTransaction(async () => {
      settled = null;

      const referral = await RiderReferralModel.findOneAndUpdate(
        {
          _id: ride.riderReferral,
          ride: ride._id,
          status: REFERRAL_STATUS.APPLIED,
        },
        {
          $set: {
            status: REFERRAL_STATUS.COMPLETED,
            completedAt: new Date(),
          },
        },
        { new: true, session },
      );

      if (!referral) return;

      const bonus = Number((referral.driverBonusAmount || 0).toFixed(2));

      if (bonus > 0) {
        await DriverModel.findByIdAndUpdate(
          referral.driver,
          { $inc: { rewardedBalance: bonus } },
          { session },
        );

        const [transaction] = await TransactionModel.create(
          [
            {
              user: referral.driver,
              userType: "Driver",
              amount: bonus,
              rewardedAmount: bonus,
              isRewarded: true,
              balanceSource: BALANCE_SOURCES.REWARDED,
              type: "Credit",
              status: "success",
              purpose: REFERRAL_BONUS_PURPOSE,
              identifierKey: referralBonusIdentifierKey(ride._id),
              metadata: {
                rideId: ride._id,
                riderReferralId: referral._id,
                riderId: referral.rider,
                description: "Driver referral bonus",
              },
            },
          ],
          { session, ordered: true },
        );

        referral.bonusTransaction = transaction._id;
        await referral.save({ session });
      }

      settled = { referral, bonus };
    });
  } catch (error) {
    // The ride itself has already completed; this must not undo that. The
    // referral stays `applied`, so running this again for the ride pays it.
    console.error(
      `${TAG} could not pay the referral bonus for ride ${ride._id}`,
      error,
    );
    return null;
  } finally {
    await session.endSession();
  }

  if (settled?.bonus > 0) {
    notifyDriverOfBonus(settled.referral.driver, settled.bonus, ride._id);
  }

  return settled;
}

async function notifyDriverOfBonus(driverId, bonus, rideId) {
  try {
    const driver = await DriverModel.findById(driverId).select("locale").lean();
    const locale = driver?.locale || "en";

    await sendNotificationToSpecificUser({
      title: t("DRIVER_REFERRAL_BONUS_TITLE", locale),
      description: t("DRIVER_REFERRAL_BONUS_DESC", locale).replace(
        "{{amount}}",
        bonus.toFixed(2),
      ),
      userIds: [driverId],
      metadata: {
        type: "DRIVER_REFERRAL_BONUS",
        amount: bonus,
        rideId,
      },
    });
  } catch (error) {
    console.error(`${TAG} bonus notification failed`, error?.message);
  }
}

/**
 * A ride may change category while it is still searching. The referral stays
 * with it: the discount copied when it was claimed comes off the new full
 * price, and the driver is paid that full price. `null` for a ride with no
 * referral, so the caller keeps its own pricing.
 */
async function priceReferralUpgrade(ride, fullUpgradeFare) {
  if (!ride?.riderReferral) return null;

  const referral = await RiderReferralModel.findOne({
    _id: ride.riderReferral,
    ride: ride._id,
    status: REFERRAL_STATUS.APPLIED,
  })
    .select("riderDiscountAmount")
    .lean();

  if (!referral) return null;

  return computeReferralFare({
    fullFare: fullUpgradeFare,
    discount: referral.riderDiscountAmount,
  });
}

// ─── Driver side ──────────────────────────────────────────────────────────────

async function getDriverReferralSummary(driverId) {
  const [code, config, counts, earned] = await Promise.all([
    ensureDriverReferralCode(driverId),
    getDriverReferralConfiguration(),
    RiderReferralModel.aggregate([
      { $match: { driver: new mongoose.Types.ObjectId(driverId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    TransactionModel.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(driverId),
          userType: "Driver",
          purpose: REFERRAL_BONUS_PURPOSE,
          status: "success",
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]),
  ]);

  const byStatus = Object.fromEntries(
    counts.map(({ _id, count }) => [_id, count]),
  );

  return {
    referralCode: code,
    enabled: config.enabled,
    riderDiscountAmount: config.riderDiscountAmount,
    driverBonusAmount: config.driverBonusAmount,
    stats: {
      saved: byStatus[REFERRAL_STATUS.SAVED] || 0,
      applied: byStatus[REFERRAL_STATUS.APPLIED] || 0,
      completed: byStatus[REFERRAL_STATUS.COMPLETED] || 0,
      voided: byStatus[REFERRAL_STATUS.VOIDED] || 0,
      totalEarned: Number((earned[0]?.total || 0).toFixed(2)),
    },
  };
}

/**
 * The riders who used this driver's code. First name only: the driver needs
 * to recognise the person they shared it with, not their contact details.
 */
async function listDriverReferrals(driverId, { page = 1, limit = 10 } = {}) {
  const currentPage = Math.max(Number(page) || 1, 1);
  const itemsPerPage = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const filter = { driver: driverId };

  const [referrals, total] = await Promise.all([
    RiderReferralModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((currentPage - 1) * itemsPerPage)
      .limit(itemsPerPage)
      .populate("rider", "firstName profilePicture")
      .lean(),
    RiderReferralModel.countDocuments(filter),
  ]);

  return {
    data: referrals.map((referral) => ({
      id: referral._id,
      riderFirstName: referral.rider?.firstName ?? null,
      riderProfilePicture: referral.rider?.profilePicture ?? null,
      status: referral.status,
      bonusAmount:
        referral.status === REFERRAL_STATUS.COMPLETED
          ? referral.driverBonusAmount
          : null,
      savedAt: referral.createdAt,
      completedAt: referral.completedAt,
      voidedAt: referral.voidedAt ?? null,
    })),
    pagination: {
      page: currentPage,
      limit: itemsPerPage,
      total,
      totalPages: Math.ceil(total / itemsPerPage),
    },
  };
}

module.exports = {
  claimReferralForRide,
  ensureDriverReferralCode,
  getDriverReferralSummary,
  getRiderReferralStatus,
  hasCompletedTrip,
  listDriverReferrals,
  previewReferralDiscount,
  priceReferralUpgrade,
  releaseReferralForRide,
  saveReferralCodeForRider,
  settleReferralForCompletedRide,
  voidReferralForRide,
};
