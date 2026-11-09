/**
 * What happens when a search runs out of rings.
 *
 * Until now the answer was always "expire the request". With the category
 * upgrade on, an exhausted economy search instead asks the rider whether to
 * look again as luxury, at a price quoted here. Accepting restarts the same
 * ride through the whole ladder in the new category; declining, or saying
 * nothing, ends it exactly the way it ended before.
 *
 * The ride stays `requested` for the entire window. That is deliberate: a
 * driver from an earlier ring who finally taps Accept still wins, at the
 * cheaper fare, and every existing query that looks for open requests keeps
 * working untouched.
 */

const RideModel = require("./model/ride.model");
const UserModel = require("../user/models/user.model");
const PromoCodeCampaignModel = require("../promo-code/model/promo-code-campaign.model");
const {
  getRedisConnection,
} = require("../../core/services/redis/redis.service");
const {
  REDIS_CONSTANTS,
} = require("../../core/common/constants/redis-constants");
const {
  RIDE,
  USER,
  PENDING,
  SESSION,
  RIDE_STATUS,
  RIDE_SOCKET_EVENTS,
  DEFAULT_DISTANCE_UNIT,
} = require("../../core/common/constants/ride-constants");
const {
  resolveAppMessage,
  toDisplayDistance,
} = require("../config/ride-configuration.service");
const { t } = require("../../core/common/helpers");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");
const { recordJourneyEvent } = require("../journey-log/journey-log.service");
const {
  priceReferralUpgrade,
} = require("../driver-referral/driver-referral.service");
const {
  calculateCampaignDiscount,
} = require("../promo-code/promo-code-discount.helper");
const {
  OFFER_STATUS,
  claimUpgradeOffer,
  commitUpgradeAccepted,
  openUpgradeOffer,
  settleUpgradeOffer,
} = require("./ride-upgrade-state.helper");

const redis = getRedisConnection();

const TAG = "[UPGRADE]";

const rideRoom = (rideId) => `${RIDE}:${rideId}`;

/**
 * The category name as the rider reads it, so `{{toCategory}}` is not an
 * English word stranded inside a Spanish sentence.
 */
function localizedCategory(category, locale) {
  return t(`RIDE_CATEGORY_${String(category).toUpperCase()}`, locale);
}

/**
 * Whatever `io` the caller had, or the one the app owns. The worker runs with
 * none in hand at all, so it is resolved late rather than held.
 */
function resolveIo(io) {
  if (io) return io;
  try {
    const { socketService } = require("../../../app");
    return socketService?.io || null;
  } catch {
    return null;
  }
}

/**
 * The offer as the apps receive it, and as Redis mirrors it. `seconds` is
 * computed at send time rather than stored, so a rider who reconnects with six
 * seconds left is told six, not thirty.
 */
function buildOfferPayload(ride, { configuration, locale, distanceUnit, now }) {
  const offer = ride.upgradeOffer;
  const unit = distanceUnit || DEFAULT_DISTANCE_UNIT;
  const remainingSeconds = Math.max(
    0,
    Math.round((new Date(offer.expiresAt).getTime() - now.getTime()) / 1000),
  );

  const fromCategory = localizedCategory(offer.fromRideType, locale);
  const toCategory = localizedCategory(offer.toRideType, locale);

  return {
    rideId: ride._id,
    from: { category: offer.fromRideType, fare: ride.rideFare },
    to: { category: offer.toRideType, fare: offer.quotedFare },
    ...(offer.promoCodeDropped
      ? {
          promoCode: {
            dropped: true,
            reason: "PROMO_CODE_INVALID_RIDE_TYPE",
            lostDiscount: ride.discountAmount ?? null,
          },
        }
      : {}),
    // `to.fare` is already what the rider pays. This says why it is lower.
    ...(offer.fullFare
      ? {
          [ride.riderReferral ? "referral" : "promoCode"]: {
            ...(ride.riderReferral ? {} : { dropped: false }),
            fullFare: offer.fullFare,
            discountAmount: Number(
              (offer.fullFare - offer.quotedFare).toFixed(2),
            ),
          },
        }
      : {}),
    decisionSeconds: remainingSeconds,
    expiresAt: offer.expiresAt,
    distanceUnit: unit,
    message: resolveAppMessage(configuration, "RIDE_UPGRADE_OFFERED", locale, {
      fromCategory,
      toCategory,
      fare: Number(offer.quotedFare).toFixed(2),
      seconds: remainingSeconds,
    }),
    searchAttempt: ride.searchAttempt ?? 0,
  };
}

/**
 * Price the ride in the category being offered.
 *
 * `rideFareCalculator` throws when the target category has no rate row at all,
 * which is a configuration gap rather than a rider's problem — the caller
 * expires the search instead of showing an offer nobody can price.
 */
async function quoteUpgrade(ride, toRideType) {
  const { rideFareCalculator } = require("./ride.service");

  const quote = await rideFareCalculator(
    toRideType,
    ride.rideDistance,
    ride.pickupCity || undefined,
  );

  return quote?.data?.totalFare;
}

/**
 * Whether the rider's promo code survives the change of category.
 *
 * A campaign that lists its eligible ride types and does not list the new one
 * would refuse the code at charge time, so the code is dropped here and the
 * rider is told before they decide — not after they have paid.
 */
async function resolvePromoCode(ride, toRideType) {
  if (!ride.campaignId) return { dropped: false };

  try {
    // The discount terms come along so a kept code can be priced against the
    // new fare, not left at the old category's amount.
    const campaign = await PromoCodeCampaignModel.findById(ride.campaignId)
      .select(
        "eligibility discountType discountValue maxDiscountCap minRideAmount",
      )
      .lean();

    const rideTypes = campaign?.eligibility?.rideTypes ?? [];
    if (rideTypes.length === 0) return { dropped: false, campaign };

    return { dropped: !rideTypes.includes(toRideType), campaign };
  } catch (error) {
    // A campaign that cannot be read must not block the offer. Keeping the code
    // is the safe side of this: the charge re-validates it anyway.
    console.error(
      `${TAG} could not read campaign ${ride.campaignId} for ride ${ride._id}:`,
      error.message,
    );
    return { dropped: false };
  }
}

/**
 * What a search does once its last ring closes: expire the request, or put the
 * upgrade question to the rider.
 *
 * Replaces the direct `exhaustSearch` call the dispatcher used to make, and
 * falls back to it on every path where an upgrade cannot be offered.
 */
async function concludeSearch({
  rideId,
  io,
  radiusReachedMiles,
  configuration,
  distanceUnit,
  categoryUpgrade,
  attempt = 0,
}) {
  const { exhaustSearch } = require("./ride-dispatch.service");
  const expire = () =>
    exhaustSearch({
      rideId,
      io,
      radiusReachedMiles,
      configuration,
      distanceUnit,
    });

  const ride = await RideModel.findById(rideId).populate("user", "locale");

  if (!ride) return { stopped: "RIDE_NOT_FOUND" };
  if (ride.rideStatus !== RIDE_STATUS.REQUESTED) {
    return { stopped: "ALREADY_RESOLVED", rideStatus: ride.rideStatus };
  }
  // A retried job must not ask the same question twice.
  if (ride.upgradeOffer?.status) {
    return { stopped: "UPGRADE_ALREADY_OFFERED" };
  }

  const toRideType = categoryUpgrade?.map?.[ride.rideType];

  // No mapping is what stops this looping, and the only way to stop it at all:
  // a luxury search that exhausts finds nothing above it and expires the way it
  // always did, and emptying the map turns the feature off everywhere.
  if (!toRideType) return expire();

  let quotedFare;
  try {
    quotedFare = await quoteUpgrade(ride, toRideType);
  } catch (error) {
    console.error(
      `${TAG} could not price a ${toRideType} upgrade for ride ${rideId}:`,
      error.message,
    );
    return expire();
  }

  if (!Number.isFinite(quotedFare) || quotedFare <= 0) {
    console.error(
      `${TAG} refusing to offer ride ${rideId} an unpriced ${toRideType} upgrade`,
    );
    return expire();
  }

  const promoCode = await resolvePromoCode(ride, toRideType);

  // A discount the ride already carries — a driver referral, or a promo code
  // valid in the new category — carries over. The rider is quoted what they
  // will actually pay; the full price is kept for the driver.
  const fullUpgradeFare = quotedFare;
  let discountedFare = null;

  const referralPricing = await priceReferralUpgrade(ride, fullUpgradeFare);
  if (referralPricing) {
    discountedFare = referralPricing.rideFare;
  } else if (promoCode.campaign && !promoCode.dropped) {
    const promoPricing = calculateCampaignDiscount(
      promoCode.campaign,
      fullUpgradeFare,
    );
    if (promoPricing.discountAmount > 0)
      discountedFare = promoPricing.finalFare;
  }

  if (discountedFare !== null) quotedFare = discountedFare;

  const now = new Date();
  const decisionSeconds = categoryUpgrade.decisionSeconds;
  const expiresAt = new Date(now.getTime() + decisionSeconds * 1000);

  const offered = await openUpgradeOffer(RideModel, rideId, {
    fromRideType: ride.rideType,
    toRideType,
    quotedFare,
    promoCodeDropped: promoCode.dropped,
    fullFare: discountedFare !== null ? fullUpgradeFare : null,
    offeredAt: now,
    expiresAt,
  });

  // Somebody resolved the ride between the read and the write.
  if (!offered) return { stopped: "ALREADY_RESOLVED" };

  const locale = ride.user?.locale || "en";
  const payload = buildOfferPayload(offered, {
    configuration,
    locale,
    distanceUnit,
    now,
  });

  const mirror = {
    ...payload,
    radiusReachedMiles,
    radiusReached: toDisplayDistance(radiusReachedMiles, distanceUnit),
  };

  await redis.set(
    REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId),
    JSON.stringify(mirror),
    REDIS_CONSTANTS.EX,
    decisionSeconds + 15,
  );

  const { enqueueUpgradeDecision } = require("./ride-dispatch.producer");
  await enqueueUpgradeDecision({
    rideId: String(rideId),
    attempt,
    delayMs: decisionSeconds * 1000,
  });

  resolveIo(io)
    ?.to(rideRoom(rideId))
    .emit(RIDE_SOCKET_EVENTS.UPGRADE_OFFER, mirror);

  // Fire-and-forget, like the driver pushes: the rider has been watching a
  // search for the better part of a minute and has very likely put the phone
  // down. A silent window is one nobody answers.
  sendNotificationToSpecificUser({
    title: t("RIDE_UPGRADE_SEARCHING", locale).replace(
      "{{toCategory}}",
      localizedCategory(toRideType, locale),
    ),
    description: payload.message,
    userIds: [String(ride.user?._id ?? ride.user)],
    role: "user",
    skipSave: true,
    metadata: { type: "RIDE_UPGRADE_OFFER", id: String(rideId) },
  });

  await recordJourneyEvent({
    journeyType: "ride",
    journeyId: ride._id,
    rideId: ride._id,
    eventType: "ride.upgrade_offered",
    phase: "pre_assignment",
    actor: { type: "system", id: null },
    source: "dispatch",
    occurredAt: now,
    dedupeKey: `ride:${ride._id}:upgrade_offered:${attempt}`,
    metadata: {
      fromRideType: ride.rideType,
      toRideType,
      quotedFare,
      promoCodeDropped: promoCode.dropped,
      radiusReachedMiles,
      decisionSeconds,
    },
  });

  console.log(
    `${TAG} ride ${rideId} offered ${ride.rideType} -> ${toRideType} at ${quotedFare} for ${decisionSeconds}s`,
  );

  return {
    offered: true,
    toRideType,
    quotedFare,
    expiresAt,
  };
}

/**
 * The rider said yes: change the category and start the search over.
 */
async function acceptCategoryUpgrade({ rideId, userId, io, locale }) {
  // Required late: `ride.service` loads the dispatcher, which loads this
  // module, so a top-level require would close the cycle.
  const { assertRiderCanPayFare } = require("./ride.service");
  const {
    getRideDistanceConfigurationForRuntime,
  } = require("../config/ride-configuration.service");
  const {
    exhaustSearch,
    startDispatch,
    withdrawRideFromOtherDrivers,
  } = require("./ride-dispatch.service");
  const {
    cancelPendingRings,
    cancelUpgradeDecision,
  } = require("./ride-dispatch.producer");

  const claimed = await claimUpgradeOffer(RideModel, rideId, userId);
  if (!claimed) return { accepted: false, reason: "OFFER_NOT_PENDING" };

  const previousAttempt = claimed.searchAttempt ?? 0;
  const offer = claimed.upgradeOffer;

  // The window must not close while a card is being checked.
  await cancelUpgradeDecision({
    rideId: String(rideId),
    attempt: previousAttempt,
  });

  const { distanceUnit, configuration, dispatchLadderMiles } =
    await getRideDistanceConfigurationForRuntime();

  // The reach the search actually got to. `exhaustSearch` formats this into the
  // rider's message, so it has to be a real number rather than a placeholder.
  const radiusReachedMiles =
    dispatchLadderMiles[dispatchLadderMiles.length - 1];

  // Luxury costs more than the fare this rider was cleared for at request
  // time, so the check is run again — against the quoted fare, not the old one.
  const rider = await UserModel.findById(userId);
  const paymentProblem = rider
    ? await assertRiderCanPayFare(rider, {
        rideFare: offer.quotedFare,
        paymentMethod: claimed.paymentMethod,
      })
    : "NOT_YOUR_RIDE";

  if (paymentProblem) {
    await settleUpgradeOffer(RideModel, rideId, {
      from: OFFER_STATUS.ACCEPTING,
      to: OFFER_STATUS.PAYMENT_FAILED,
    });
    await redis.del(REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId));

    emitUpgradeResult(io, rideId, {
      outcome: "payment_failed",
      rideType: claimed.rideType,
      rideFare: claimed.rideFare,
      searchAttempt: previousAttempt,
      message: resolveAppMessage(
        configuration,
        "RIDE_UPGRADE_UNAVAILABLE",
        locale || "en",
      ),
      reason: paymentProblem,
    });

    await exhaustSearch({
      rideId,
      io,
      radiusReachedMiles,
      configuration,
      distanceUnit,
      cancellationReason: "upgrade_payment_failed",
      reasonCode: "UPGRADE_PAYMENT_FAILED",
    });

    // The ride was never mutated, so there is nothing to roll back.
    return { accepted: false, reason: paymentProblem };
  }

  // Deliberately not re-quoted. The rider agreed to the number on their screen;
  // a peak window that flipped during those thirty seconds must not raise the
  // price after the fact.
  const committed = await commitUpgradeAccepted(RideModel, rideId, {
    toRideType: offer.toRideType,
    rideFare: offer.quotedFare,
    dropPromoCode: offer.promoCodeDropped === true,
    fullFare: offer.fullFare ?? null,
  });

  // A driver won the ride while the card was being checked. They keep it, at
  // the cheaper fare, and the `accepted` status update is already on its way.
  if (!committed) return { accepted: false, reason: "RIDE_ALREADY_ACCEPTED" };

  const newAttempt = committed.searchAttempt ?? previousAttempt + 1;

  // Order matters. The withdraw runs *after* the category flip, so the fresh
  // list each driver gets back no longer contains this ride — and it deletes
  // the notified set, which is exactly the reset the new search needs. Without
  // it every driver from the old category counts as already-notified and the
  // new ring 0 finds nobody.
  await withdrawRideFromOtherDrivers({
    rideId: String(rideId),
    winnerDriverId: null,
    io,
    reason: "RIDE_UPGRADED",
  });
  await cancelPendingRings({
    rideId: String(rideId),
    attempt: previousAttempt,
  });

  // Two searches plus a decision window can outlive the original request TTL if
  // an admin has widened the ladder, so both keys are pushed back out.
  await Promise.all([
    redis.expire(
      `${RIDE}:${SESSION}:${rideId}`,
      REDIS_CONSTANTS.RIDE_SESSION_TTL,
    ),
    redis.expire(
      `${USER}:${userId}:${RIDE}:${PENDING}`,
      REDIS_CONSTANTS.RIDE_SESSION_TTL,
    ),
    redis.del(REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId)),
  ]);

  await recordJourneyEvent({
    journeyType: "ride",
    journeyId: committed._id,
    rideId: committed._id,
    eventType: "ride.upgrade_accepted",
    phase: "pre_assignment",
    actor: { type: "user", id: userId },
    source: "socket",
    dedupeKey: `ride:${committed._id}:upgrade_accepted:${newAttempt}`,
    metadata: {
      fromRideType: offer.fromRideType,
      toRideType: offer.toRideType,
      rideFare: offer.quotedFare,
      promoCodeDropped: offer.promoCodeDropped === true,
      searchAttempt: newAttempt,
    },
  });

  const riderLocale = locale || rider?.locale || "en";

  emitUpgradeResult(io, rideId, {
    outcome: "accepted",
    rideType: committed.rideType,
    rideFare: committed.rideFare,
    searchAttempt: newAttempt,
    message: resolveAppMessage(
      configuration,
      "RIDE_UPGRADE_SEARCHING",
      riderLocale,
      { toCategory: localizedCategory(offer.toRideType, riderLocale) },
    ),
  });

  console.log(
    `${TAG} ride ${rideId} upgraded to ${offer.toRideType}; search generation ${newAttempt}`,
  );

  // Ring 0 runs inline, exactly like a fresh request.
  const search = await startDispatch({ rideId, io, attempt: newAttempt });

  return {
    accepted: true,
    rideType: committed.rideType,
    rideFare: committed.rideFare,
    searchAttempt: newAttempt,
    search,
  };
}

function emitUpgradeResult(io, rideId, payload) {
  resolveIo(io)
    ?.to(rideRoom(rideId))
    .emit(RIDE_SOCKET_EVENTS.UPGRADE_RESULT, { rideId, ...payload });
}

/**
 * Close an offer the rider will not be taking, and let the request die the way
 * it would have died without the feature at all.
 */
async function endUpgradeOffer({
  rideId,
  io,
  outcome,
  cancellationReason,
  reasonCode,
  actor,
  locale,
}) {
  const { exhaustSearch } = require("./ride-dispatch.service");
  const {
    getRideDistanceConfigurationForRuntime,
  } = require("../config/ride-configuration.service");

  const settled = await settleUpgradeOffer(RideModel, rideId, {
    from: OFFER_STATUS.OFFERED,
    to: outcome,
  });

  // Already accepted, already timed out, or the ride is long gone.
  if (!settled) return { stopped: "OFFER_NOT_PENDING" };

  await redis.del(REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId));

  const { distanceUnit, configuration, dispatchLadderMiles } =
    await getRideDistanceConfigurationForRuntime();

  emitUpgradeResult(io, rideId, {
    outcome,
    rideType: settled.rideType,
    rideFare: settled.rideFare,
    searchAttempt: settled.searchAttempt ?? 0,
    message: resolveAppMessage(
      configuration,
      "RIDE_UPGRADE_UNAVAILABLE",
      locale || "en",
    ),
  });

  await recordJourneyEvent({
    journeyType: "ride",
    journeyId: settled._id,
    rideId: settled._id,
    eventType: `ride.upgrade_${outcome}`,
    phase: "pre_assignment",
    actor: actor ?? { type: "system", id: null },
    source: "dispatch",
    dedupeKey: `ride:${settled._id}:upgrade_${outcome}:${settled.searchAttempt ?? 0}`,
    metadata: {
      fromRideType: settled.upgradeOffer?.fromRideType,
      toRideType: settled.upgradeOffer?.toRideType,
      quotedFare: settled.upgradeOffer?.quotedFare,
    },
  });

  // The search is over. `exhaustSearch` is conditional on the ride still being
  // `requested`, so a ride a driver took in the meantime is left alone.
  const result = await exhaustSearch({
    rideId,
    io,
    radiusReachedMiles: dispatchLadderMiles[dispatchLadderMiles.length - 1],
    configuration,
    distanceUnit,
    cancellationReason,
    reasonCode,
  });

  return { outcome, ...result };
}

async function declineCategoryUpgrade({ rideId, userId, io, locale }) {
  return endUpgradeOffer({
    rideId,
    io,
    locale,
    outcome: OFFER_STATUS.DECLINED,
    cancellationReason: "upgrade_declined",
    reasonCode: "UPGRADE_DECLINED",
    actor: { type: "user", id: userId },
  });
}

/**
 * The decision window closed with no answer. Entry point for the queued job,
 * which is why it takes nothing but ids.
 */
async function expireCategoryUpgrade({ rideId, attempt = 0 }) {
  console.log(`${TAG} decision window closed for ride ${rideId} (a${attempt})`);

  return endUpgradeOffer({
    rideId,
    outcome: OFFER_STATUS.TIMED_OUT,
    cancellationReason: "upgrade_timed_out",
    reasonCode: "UPGRADE_TIMED_OUT",
  });
}

/**
 * A driver accepted the ride while the question was still on the rider's
 * screen. The driver wins; the offer is simply closed, and nothing else about
 * the ride changes.
 */
async function supersedeCategoryUpgrade({ rideId }) {
  const settled = await settleUpgradeOffer(RideModel, rideId, {
    from: OFFER_STATUS.OFFERED,
    to: OFFER_STATUS.SUPERSEDED,
  });

  if (!settled) return { stopped: "OFFER_NOT_PENDING" };

  await redis.del(REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId));

  return { outcome: OFFER_STATUS.SUPERSEDED };
}

/**
 * The offer a reconnecting rider still has to answer, or null.
 *
 * Read from the Redis mirror, with the remaining seconds recomputed — a rider
 * who comes back with six seconds left must see six, not thirty. An offer whose
 * time is already up is not returned at all; the timeout job settles it.
 */
async function getPendingUpgradeOffer(rideId) {
  try {
    const stored = await redis.get(
      REDIS_CONSTANTS.keys.rideUpgradeOffer(rideId),
    );
    if (!stored) return null;

    const offer = JSON.parse(stored);
    const remainingSeconds = Math.round(
      (new Date(offer.expiresAt).getTime() - Date.now()) / 1000,
    );

    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
      return null;
    }

    return { ...offer, decisionSeconds: remainingSeconds };
  } catch (error) {
    // A resume that cannot read the mirror shows no offer, which is the same
    // place a rider lands today. It must never break the reconnection itself.
    console.error(
      `${TAG} could not read the pending offer for ride ${rideId}:`,
      error.message,
    );
    return null;
  }
}

module.exports = {
  acceptCategoryUpgrade,
  concludeSearch,
  declineCategoryUpgrade,
  expireCategoryUpgrade,
  getPendingUpgradeOffer,
  supersedeCategoryUpgrade,
};
