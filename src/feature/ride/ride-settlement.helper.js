const DriverModel = require("../driver/models/driver.model");
const TransactionModel = require("../transactions/model/transaction.model");
const {
  getRideDriverFare,
} = require("../../core/common/helpers/driver-fare.helper");

const normalizeMoney = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
};

/**
 * A ride the rider owes nothing for — a 100% promo, or a fare that resolved to
 * zero. The driver still earns: `getRideDriverFare` pays off the ORIGINAL fare,
 * and the platform absorbs the difference.
 */
function isFreeRide(ride) {
  return normalizeMoney(ride?.rideFare) <= 0;
}

/**
 * Pay the driver for a finished charge and record who absorbed the discount.
 *
 * This used to be copy-pasted in the wallet branch and again in the Stripe
 * webhook, which is how the free-ride path ended up with no payout at all — it
 * never reached either copy. Everything that settles a ride now goes through
 * here: wallet, card (via webhook) and free.
 *
 * `amountChargedToRider` is what the rider actually paid, which differs from
 * `ride.rideFare` on the card path (the transaction amount is authoritative
 * there) and is zero for a free ride.
 */
async function creditDriverForRide({
  ride,
  paymentMethod,
  amountChargedToRider,
  session = null,
  identifierKey = null,
  stripeIds = null,
}) {
  const driverAmount = getRideDriverFare(ride);

  if (!ride?.driver || driverAmount <= 0) {
    return { driverAmount: 0, discountAbsorbed: 0, driverTransaction: null };
  }

  const riderPaid = normalizeMoney(amountChargedToRider ?? ride.rideFare);
  const recordedDiscount = normalizeMoney(ride.discountAmount);
  const discountAbsorbed =
    recordedDiscount > 0
      ? recordedDiscount
      : Math.max(normalizeMoney(driverAmount - riderPaid), 0);

  const writeOptions = session ? { session } : {};

  await DriverModel.findByIdAndUpdate(
    ride.driver,
    { $inc: { balance: driverAmount } },
    { ...writeOptions, new: true },
  );

  const [driverTransaction] = await TransactionModel.create(
    [
      {
        user: ride.driver,
        userType: "Driver",
        amount: driverAmount,
        type: "Credit",
        status: "success",
        ...(identifierKey ? { identifierKey } : {}),
        ...(stripeIds ? { stripeIds } : {}),
        metadata: { rideId: ride._id, paymentMethod },
      },
    ],
    { ...writeOptions, ordered: true },
  );

  if (discountAbsorbed > 0) {
    await TransactionModel.create(
      [
        {
          userType: "Platform",
          amount: discountAbsorbed,
          type: "Debit",
          status: "success",
          metadata: {
            rideId: ride._id,
            reason: ride.riderReferral
              ? "driver_referral_discount_absorbed"
              : "promo_discount_absorbed",
            paymentMethod,
          },
        },
      ],
      { ...writeOptions, ordered: true },
    );
  }

  return { driverAmount, discountAbsorbed, driverTransaction };
}

module.exports = {
  creditDriverForRide,
  isFreeRide,
  normalizeMoney,
};
