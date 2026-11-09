const express = require("express");
const router = express.Router();
const catchAsync = require("../../core/common/catch-async");

const {
  loginController,
  getDriversController,
  getDocumentsController,
  getVehiclesController,
  respondToDocsController,
  createVehicleTypeController,
  listVehicleTypesController,
  updateVehicleTypeController,
  deleteVehicleTypeController,
  getUsersController,
  getWithdrawalCommissionController,
  getUserByIdController,
  updateUserStatusController,
  getSubscriptionRevenueController,
  getReportsController,
  getReportByIdController,
  resolveReportController,
  sendAdminNotificationController,
  getAdminNotificationsController,
  getDashboardStatsController,
  getBirdsEyeViewController,
  getRideAnalyticsController,
  verifyOTPController,
  forgotPasswordAdmin,
  resetPasswordAdmin,
  updatePasswordAdmin,
  getPendingDriverRequests,
  updateUserOrDriver,
  getDriverSubscriptionTransactions,
  getRidesController,
  getRideByIdController,
  getCarpoolRidesController,
  getCarpoolDetailsController,
  deleteUserController,
  getAllAdminNotificationsController,
  getUsersCSV,
  exportRidesCSVController,
  // Ride Rates
  getRideConfigurationController,
  updateRideConfigurationController,
  getRideRatesController,
  updateRideRateController,
  createCityRideRateController,
  updateCityRideRateController,
  deleteCityRideRateController,
  // Peak Windows
  getPeakWindowsController,
  createPeakWindowController,
  updatePeakWindowController,
  deletePeakWindowController,
  // Admin User Management (super_admin only)
  createAdminUserController,
  listAdminUsersController,
  updateAdminUserController,
  deleteAdminUserController,
  getAdminNotificationByIdController,
  updateAdminNotificationController,
  deleteAdminNotificationController,
  // Driver Suspension Management
  suspendDriverController,
  unsuspendDriverController,
  getSuspendedDriversController,
  getDriverSuspensionController,
  getRewardedBalanceHistoryController,
  getJourneyTimelineController,
} = require("./admin.controller");
const protectRouteMiddleware = require("../../core/middlewares/protect-route.middleware");
const restrictToMiddleware = require("../../core/middlewares/restrict-to.middleware");
const { validate } = require("../../core/middlewares/validate.middleware");
const promoCodeCampaignRoutes = require("../promo-code/promo-code-campaign.routes");

const {
  createVehicleTypeValidator,
  updateVehicleTypeValidator,
  listVehicleTypesValidator,
  deleteVehicleTypeValidator,
} = require("./dto/vehicle-type.validators");
const {
  listUsersValidator,
  getWithdrawalCommissionValidator,
  getUserByIdValidator,
  updateUserStatusValidator,
  updateUserOrDriverValidator,
  getSubscriptionRevenueValidator,
  listReportsValidator,
  getReportByIdValidator,
  resolveReportValidator,
  sendAdminNotificationValidator,
  listAdminNotificationsValidator,
  getDashboardStatsValidator,
  getRideAnalyticsValidator,
  resetPasswordAdminValidator,
  updatePasswordAdminValidator,
  ExportUserValidator,
  createAdminUserValidator,
  listAdminUsersValidator,
  updateAdminUserValidator,
  deleteAdminUserValidator,
  getAdminNotificationByIdValidator,
  updateAdminNotificationValidator,
  deleteAdminNotificationValidator,
  // Driver Suspension Validators
  suspendDriverValidator,
  unsuspendDriverValidator,
  getSuspendedDriversValidator,
  getDriverSuspensionValidator,
  getRewardedBalanceHistoryValidator,
} = require("./dto/user.validators");

const {
  ExportRideValidator,
  getRideByIdValidator,
  getCarpoolDetailsValidator,
  getJourneyTimelineValidator,
} = require("./dto/ride.validators");

const {
  getRideRatesValidator,
  updateRideRateValidator,
  createCityRideRateValidator,
  updateCityRideRateValidator,
  deleteCityRideRateValidator,
  getPeakWindowsValidator,
  createPeakWindowValidator,
  updatePeakWindowValidator,
  deletePeakWindowValidator,
} = require("./dto/ride-rate.validators");
const {
  getRideConfigurationValidator,
  updateRideConfigurationValidator,
} = require("./dto/ride-configuration.validators");
const { ADMIN_ROLES } = require("../../core/common/constants");

router.post("/login", catchAsync(loginController));

// ── Driver Suspension Management Routes ───────────────────────────────────────
// NOTE: Static /drivers/suspended must come before /drivers/:driverId/... params

router.get(
  "/drivers/suspended",
  protectRouteMiddleware,
  validate(getSuspendedDriversValidator),
  catchAsync(getSuspendedDriversController),
);

router.get(
  "/drivers/:id/suspension",
  protectRouteMiddleware,
  validate(getDriverSuspensionValidator),
  catchAsync(getDriverSuspensionController),
);

router.post(
  "/drivers/:id/suspend",
  protectRouteMiddleware,
  validate(suspendDriverValidator),
  catchAsync(suspendDriverController),
);

router.post(
  "/drivers/:id/unsuspend",
  protectRouteMiddleware,
  validate(unsuspendDriverValidator),
  catchAsync(unsuspendDriverController),
);

// ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/drivers/:driverId/transactions",
  protectRouteMiddleware,
  catchAsync(getDriverSubscriptionTransactions),
);
router.get(
  "/drivers",
  protectRouteMiddleware,
  catchAsync(getDriversController),
);
router.get("/docs", protectRouteMiddleware, catchAsync(getDocumentsController));
router.get(
  "/vehicles",
  protectRouteMiddleware,
  catchAsync(getVehiclesController),
);
router.put(
  "/docs/respond",
  protectRouteMiddleware,
  catchAsync(respondToDocsController),
);

// Vehicle Type Mapping Routes
router.post(
  "/vehicle-types",
  protectRouteMiddleware,
  validate(createVehicleTypeValidator),
  catchAsync(createVehicleTypeController),
);

router.get(
  "/vehicle-types",
  validate(listVehicleTypesValidator),
  catchAsync(listVehicleTypesController),
);

router.put(
  "/vehicle-types/:id",
  protectRouteMiddleware,
  validate(updateVehicleTypeValidator),
  catchAsync(updateVehicleTypeController),
);

router.delete(
  "/vehicle-types/:id",
  protectRouteMiddleware,
  validate(deleteVehicleTypeValidator),
  catchAsync(deleteVehicleTypeController),
);

// User Management Routes
router.get(
  "/users/export",
  protectRouteMiddleware,
  validate(ExportUserValidator),
  catchAsync(getUsersCSV),
);

router.get(
  "/users/:id",
  protectRouteMiddleware,
  validate(getUserByIdValidator),
  catchAsync(getUserByIdController),
);

router.patch(
  "/users/:id",
  protectRouteMiddleware,
  restrictToMiddleware(...Object.values(ADMIN_ROLES)),
  validate(updateUserOrDriverValidator),
  catchAsync(updateUserOrDriver),
);

router.delete(
  "/users/:id",
  protectRouteMiddleware,

  catchAsync(deleteUserController),
);

router.get(
  "/users",
  protectRouteMiddleware,

  validate(listUsersValidator),
  catchAsync(getUsersController),
);

router.get(
  "/withdrawals",
  protectRouteMiddleware,

  validate(getWithdrawalCommissionValidator),
  catchAsync(getWithdrawalCommissionController),
);

router.get(
  "/rewarded-balance-history",
  protectRouteMiddleware,
  validate(getRewardedBalanceHistoryValidator),
  catchAsync(getRewardedBalanceHistoryController),
);

router.get(
  "/rewarded-balances",
  protectRouteMiddleware,
  validate(getRewardedBalanceHistoryValidator),
  catchAsync(getRewardedBalanceHistoryController),
);

router.patch(
  "/users/:id/status",
  protectRouteMiddleware,

  validate(updateUserStatusValidator),
  catchAsync(updateUserStatusController),
);

// Subscription Revenue Routes
router.get(
  "/subscription-revenue",
  protectRouteMiddleware,

  validate(getSubscriptionRevenueValidator),
  catchAsync(getSubscriptionRevenueController),
);

// Report Moderation Routes
router.get(
  "/reports",
  protectRouteMiddleware,

  validate(listReportsValidator),
  catchAsync(getReportsController),
);

router.get(
  "/reports/:id",
  protectRouteMiddleware,

  validate(getReportByIdValidator),
  catchAsync(getReportByIdController),
);

router.patch(
  "/reports/:id/:status",
  protectRouteMiddleware,

  validate(resolveReportValidator),
  catchAsync(resolveReportController),
);

// Notification Routes
router.post(
  "/notifications",
  protectRouteMiddleware,

  validate(sendAdminNotificationValidator),
  catchAsync(sendAdminNotificationController),
);

router.get(
  "/notifications/mine",
  protectRouteMiddleware,

  catchAsync(getAllAdminNotificationsController),
);

router.get(
  "/notifications",
  protectRouteMiddleware,

  validate(listAdminNotificationsValidator),
  catchAsync(getAdminNotificationsController),
);

router.get(
  "/notifications/:id",
  protectRouteMiddleware,
  validate(getAdminNotificationByIdValidator),
  catchAsync(getAdminNotificationByIdController),
);

router.patch(
  "/notifications/:id",
  protectRouteMiddleware,
  validate(updateAdminNotificationValidator),
  catchAsync(updateAdminNotificationController),
);

router.delete(
  "/notifications/:id",
  protectRouteMiddleware,
  validate(deleteAdminNotificationValidator),
  catchAsync(deleteAdminNotificationController),
);

// Dashboard Quick Stats
router.get(
  "/dashboard-stats",
  protectRouteMiddleware,

  validate(getDashboardStatsValidator),
  catchAsync(getDashboardStatsController),
);

router.get(
  "/birds-eye-view",
  protectRouteMiddleware,

  catchAsync(getBirdsEyeViewController),
);

router.get(
  "/requests-count",
  protectRouteMiddleware,

  catchAsync(getPendingDriverRequests),
);

// Ride Analytics
router.get(
  "/ride-analytics",
  protectRouteMiddleware,

  validate(getRideAnalyticsValidator),
  catchAsync(getRideAnalyticsController),
);

router.get(
  "/rides/export",
  protectRouteMiddleware,

  validate(ExportRideValidator),
  catchAsync(exportRidesCSVController),
);

router.get(
  "/rides",
  protectRouteMiddleware,

  catchAsync(getRidesController),
);

router.get(
  "/rides/:id",
  protectRouteMiddleware,
  validate(getRideByIdValidator),
  catchAsync(getRideByIdController),
);

router.get(
  "/carpool-rides",
  protectRouteMiddleware,

  catchAsync(getCarpoolRidesController),
);

router.get(
  "/carpool-rides/:id",
  protectRouteMiddleware,
  validate(getCarpoolDetailsValidator),
  catchAsync(getCarpoolDetailsController),
);

router.get(
  "/journeys/:journeyType/:journeyId/timeline",
  protectRouteMiddleware,
  restrictToMiddleware(...Object.values(ADMIN_ROLES)),
  validate(getJourneyTimelineValidator),
  catchAsync(getJourneyTimelineController),
);

// Admin Auth

router.post("/forgot-password", catchAsync(forgotPasswordAdmin));
router.post("/verify-otp", catchAsync(verifyOTPController));
router.post(
  "/reset-password",
  protectRouteMiddleware,
  validate(resetPasswordAdminValidator),

  catchAsync(resetPasswordAdmin),
);

router.put(
  "/update-password",
  protectRouteMiddleware,

  validate(updatePasswordAdminValidator),
  catchAsync(updatePasswordAdmin),
);

// Campaigns
router.use("/campaigns", promoCodeCampaignRoutes);

// Ride Rates
router.get(
  "/ride-configuration",
  protectRouteMiddleware,
  restrictToMiddleware(...Object.values(ADMIN_ROLES)),
  validate(getRideConfigurationValidator),
  catchAsync(getRideConfigurationController),
);

router.patch(
  "/ride-configuration",
  protectRouteMiddleware,
  restrictToMiddleware(...Object.values(ADMIN_ROLES)),
  validate(updateRideConfigurationValidator),
  catchAsync(updateRideConfigurationController),
);

router.get(
  "/ride-rates",
  protectRouteMiddleware,

  validate(getRideRatesValidator),
  catchAsync(getRideRatesController),
);

router.put(
  "/ride-rates/:rideType",
  protectRouteMiddleware,

  validate(updateRideRateValidator),
  catchAsync(updateRideRateController),
);

router.post(
  "/city-ride-rates",
  protectRouteMiddleware,
  validate(createCityRideRateValidator),
  catchAsync(createCityRideRateController),
);

router.put(
  "/city-ride-rates/:id",
  protectRouteMiddleware,
  validate(updateCityRideRateValidator),
  catchAsync(updateCityRideRateController),
);

router.delete(
  "/city-ride-rates/:id",
  protectRouteMiddleware,
  validate(deleteCityRideRateValidator),
  catchAsync(deleteCityRideRateController),
);

// Peak Windows
router.get(
  "/peak-windows",
  protectRouteMiddleware,

  validate(getPeakWindowsValidator),
  catchAsync(getPeakWindowsController),
);

router.post(
  "/peak-windows",
  protectRouteMiddleware,

  validate(createPeakWindowValidator),
  catchAsync(createPeakWindowController),
);

router.put(
  "/peak-windows/:id",
  protectRouteMiddleware,

  validate(updatePeakWindowValidator),
  catchAsync(updatePeakWindowController),
);

router.delete(
  "/peak-windows/:id",
  protectRouteMiddleware,

  validate(deletePeakWindowValidator),
  catchAsync(deletePeakWindowController),
);

// Admin User Management (super_admin only)
router.post(
  "/admin-users",
  protectRouteMiddleware,

  validate(createAdminUserValidator),
  catchAsync(createAdminUserController),
);

router.get(
  "/admin-users",
  protectRouteMiddleware,

  validate(listAdminUsersValidator),
  catchAsync(listAdminUsersController),
);

router.patch(
  "/admin-users/:id",
  protectRouteMiddleware,

  validate(updateAdminUserValidator),
  catchAsync(updateAdminUserController),
);

router.delete(
  "/admin-users/:id",
  protectRouteMiddleware,

  validate(deleteAdminUserValidator),
  catchAsync(deleteAdminUserController),
);

module.exports = {
  path: "/admin",
  router: router,
};
