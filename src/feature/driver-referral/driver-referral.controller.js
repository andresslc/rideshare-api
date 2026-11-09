const { ForbiddenError } = require("../../core/common/exceptions");
const { getRequestLocale, t } = require("../../core/common/helpers");
const {
  getDriverReferralSummary,
  getRiderReferralStatus,
  listDriverReferrals,
  saveReferralCodeForRider,
} = require("./driver-referral.service");

// The session role, not `req.user.role`: rider and driver documents carry no
// role of their own (see protect-route.middleware).
const requireRole = (req, role) => {
  if (req.session?.role !== role) {
    throw new ForbiddenError(
      t(
        role === "driver"
          ? "DRIVER_REFERRAL_DRIVERS_ONLY"
          : "DRIVER_REFERRAL_RIDERS_ONLY",
        req.user?.locale || getRequestLocale(req),
      ),
    );
  }
};

const localeOf = (req) => req.user?.locale || getRequestLocale(req);

const applyReferralCodeController = async (req) => {
  requireRole(req, "user");
  const locale = localeOf(req);

  const data = await saveReferralCodeForRider({
    riderId: req.user._id,
    code: req.body.code,
    locale,
  });

  return { data, message: t("DRIVER_REFERRAL_CODE_SAVED", locale) };
};

const getRiderReferralStatusController = async (req) => {
  requireRole(req, "user");

  return { data: await getRiderReferralStatus(req.user._id) };
};

const getDriverReferralSummaryController = async (req) => {
  requireRole(req, "driver");

  return { data: await getDriverReferralSummary(req.user._id) };
};

const getDriverReferralHistoryController = async (req) => {
  requireRole(req, "driver");

  const { data, pagination } = await listDriverReferrals(req.user._id, {
    page: req.query.page,
    limit: req.query.limit,
  });

  return { data, pagination };
};

module.exports = {
  applyReferralCodeController,
  getDriverReferralHistoryController,
  getDriverReferralSummaryController,
  getRiderReferralStatusController,
};
