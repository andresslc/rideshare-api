const AdminService = require("./admin.service");
const VehicleTypeService = require("./vehicle-type.service");
const JourneyLogService = require("../journey-log/journey-log.service");

const loginController = async (req, res) => {
  const email = req.body.email;
  const password = req.body.password;

  const result = await AdminService.login(email, password);

  return result;
};

const getDriversController = async (req, res) => {
  const result = await AdminService.getDrivers(req.query, req.user);
  return result;
};

const getDocumentsController = async (req, res) => {
  const docs = await AdminService.getDocuments(req.query, req.user);
  return docs;
};

const getVehiclesController = async (req, res) => {
  const result = await AdminService.getVehicles(req.query, req.user);
  return result;
};

const respondToDocsController = async (req, res) => {
  const { documents } = req.body;

  const result = await AdminService.respondToDocs(documents, req.user);

  return result;
};

const createVehicleTypeController = async (req, res) => {
  const result = await VehicleTypeService.createVehicleTypeMapping(req.body);
  return result;
};

const listVehicleTypesController = async (req, res) => {
  const result = await VehicleTypeService.listVehicleTypeMappings(req.query);
  return result;
};

const updateVehicleTypeController = async (req, res) => {
  const { id } = req.params;
  const result = await VehicleTypeService.updateVehicleTypeMapping(
    id,
    req.body,
  );
  return result;
};

const deleteVehicleTypeController = async (req, res) => {
  const { id } = req.params;
  const result = await VehicleTypeService.deleteVehicleTypeMapping(id);
  return result;
};

const getUsersController = async (req, res) => {
  const result = await AdminService.getUsers(req.query, req.user);
  return result;
};

const getWithdrawalCommissionController = async (req, res) => {
  const result = await AdminService.getWithdrawalCommission(
    req.query,
    req.user,
  );
  return result;
};

const getUserByIdController = async (req, res) => {
  const { id } = req.params;
  const { type } = req.query;
  const result = await AdminService.getUserById(id, type, req.user);
  return result;
};

const updateUserStatusController = async (req, res) => {
  const { id } = req.params;
  const { type, status } = req.body;
  const result = await AdminService.updateUserStatus(
    id,
    type,
    status,
    req.user,
  );
  return result;
};

const updateUserOrDriver = async (req, res) => {
  const result = await AdminService.updateUserOrDriver(
    req.params.id,
    req.body,
    req.user,
  );

  return result;
};

const getRewardedBalanceHistoryController = async (req, res) => {
  const result = await AdminService.getRewardedBalanceHistory(
    req.query,
    req.user,
  );
  return result;
};

const getRidesController = async (req, res) => {
  const result = await AdminService.getRides(req.query, req.user);

  return result;
};

const getRideByIdController = async (req, res) => {
  const result = await AdminService.getRideById(req.params.id, req.user);

  return result;
};

const getCarpoolRidesController = async (req, res) => {
  const result = await AdminService.getCarpoolRides(req.query, req.user);

  return result;
};

const getCarpoolDetailsController = async (req, res) => {
  const result = await AdminService.getCarpoolDetails(req.params.id, req.user);

  return result;
};

const getJourneyTimelineController = async (req, res) => {
  const { journeyType, journeyId } = req.params;
  const data = await JourneyLogService.getJourneyTimeline(
    journeyType,
    journeyId,
    { adminUser: req.user },
  );
  return {
    message: "Journey timeline retrieved successfully",
    data,
  };
};

const deleteUserController = async (req, res) => {
  const { id } = req.params;
  const { type } = req.query;
  const result = await AdminService.deleteUser(id, type, req.user);

  return {
    message: `User deleted successfully`,
  };
};

const getAllAdminNotificationsController = async (req, res) => {
  const result = await AdminService.getAllAdminNotifications(
    req.query,
    req.user,
  );
  return result;
};

const getDriverSubscriptionTransactions = async (req, res) => {
  const result = await AdminService.getDriverSubscriptionTransactions(
    req.params.driverId,
    req.query.page || 1,
    req.query.limit || 10,
    req.user,
  );

  return result;
};

const getSubscriptionRevenueController = async (req, res) => {
  const result = await AdminService.getSubscriptionRevenue(req.query, req.user);
  return result;
};

const getReportsController = async (req, res) => {
  const result = await AdminService.getReports(req.query, req.user);
  return result;
};

const getReportByIdController = async (req, res) => {
  const result = await AdminService.getReportById(req.params.id, req.user);
  return result;
};

const resolveReportController = async (req, res) => {
  const result = await AdminService.resolveReport(
    req.params.id,
    req.user._id,
    req.body.adminNotes,
    req.params.status,
    req.user,
  );
  return result;
};

const sendAdminNotificationController = async (req, res) => {
  console.log("🚀 ~ sendAdminNotificationController ~ req:", req.body);
  const result = await AdminService.sendAdminNotification(req.body, req.user);
  return result;
};

const getAdminNotificationsController = async (req, res) => {
  const result = await AdminService.getAdminNotifications(req.query, req.user);
  return result;
};

const getDashboardStatsController = async (req, res) => {
  const result = await AdminService.getDashboardStats(req.query, req.user);
  return result;
};

const getBirdsEyeViewController = async (req, res) => {
  const result = await AdminService.getBirdsEyeView(req.user);
  return { message: "Birds eye view retrieved successfully", data: result };
};

const getRideAnalyticsController = async (req, res) => {
  const result = await AdminService.getRideAnalytics(req.query, req.user);
  return result;
};

const forgotPasswordAdmin = async (req, res) => {
  const { email } = req.body;
  const result = await AdminService.forgotPasswordAdmin(email);
  return result;
};
const verifyOTPController = async (req, res) => {
  const { email, otp } = req.body;
  const result = await AdminService.verifyOtp({ email, otp });
  return result;
};
const resetPasswordAdmin = async (req, res) => {
  const result = await AdminService.resetPasswordAdmin(req.user, req.body);
  return result;
};

const updatePasswordAdmin = async (req, res) => {
  const result = await AdminService.updatePassword(req.user, req.body);
  return result;
};

const getPendingDriverRequests = async (req, res) => {
  const result = await AdminService.getPendingDriverRequests(
    req.query,
    req.user,
  );
  return result;
};

const createPromoCodeController = async (req, res) => {
  const result = await PromoCodeService.createPromoCode(req.body);
  return result;
};

const updatePromoCodeController = async (req, res) => {
  const promoId = req.params.id;
  const result = await PromoCodeService.updatePromoCode(promoId, req.body);
  return result;
};

const deletePromoCodeController = async (req, res) => {
  const promoId = req.params.id;
  const result = await PromoCodeService.deletePromoCode(promoId);

  return result;
};

const getAllPromoCodeController = async (req, res) => {
  const result = await PromoCodeService.getAllPromoCode(req.query);
  return result;
};

const getUsersCSV = async (req, res) => {
  const { filename, csv } = await AdminService.exportUsersCSV(
    req.query,
    req.user,
  );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
};

const exportRidesCSVController = async (req, res) => {
  const { filename, csv } = await AdminService.exportRidesCSV(
    req.query,
    req.user,
  );
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
};

// ── Ride Rates ────────────────────────────────────────────────────────────────

const getRideConfigurationController = async () => {
  return AdminService.getRideConfiguration();
};

const updateRideConfigurationController = async (req) => {
  return AdminService.updateRideConfiguration(req.body);
};

const getRideRatesController = async (req, res) => {
  const result = await AdminService.getRideRates(req.query);
  return result;
};

const createCityRideRateController = async (req, res) => {
  return AdminService.createCityRideRate(req.body);
};

const updateCityRideRateController = async (req, res) => {
  return AdminService.updateCityRideRate(req.params.id, req.body);
};

const deleteCityRideRateController = async (req, res) => {
  return AdminService.deleteCityRideRate(req.params.id);
};

const updateRideRateController = async (req, res) => {
  const { rideType } = req.params;
  const result = await AdminService.updateRideRate(rideType, req.body);
  return result;
};

// ── Peak Windows ──────────────────────────────────────────────────────────────

const getPeakWindowsController = async (req, res) => {
  const result = await AdminService.getPeakWindows();
  return result;
};

const createPeakWindowController = async (req, res) => {
  const result = await AdminService.createPeakWindow(req.body);
  return result;
};

const updatePeakWindowController = async (req, res) => {
  const result = await AdminService.updatePeakWindow(req.params.id, req.body);
  return result;
};

const deletePeakWindowController = async (req, res) => {
  const result = await AdminService.deletePeakWindow(req.params.id);
  return result;
};

const createAdminUserController = async (req, res) => {
  const result = await AdminService.createAdminUser(req.body, req.user);
  return result;
};

const listAdminUsersController = async (req, res) => {
  const result = await AdminService.listAdminUsers(req.query, req.user);
  return result;
};

const updateAdminUserController = async (req, res) => {
  const result = await AdminService.updateAdminUser(
    req.params.id,
    req.body,
    req.user,
  );
  return result;
};

const deleteAdminUserController = async (req, res) => {
  const result = await AdminService.deleteAdminUser(req.params.id, req.user);
  return result;
};

const getAdminNotificationByIdController = async (req, res) => {
  const result = await AdminService.getAdminNotificationById(
    req.params.id,
    req.user,
  );
  return result;
};

const updateAdminNotificationController = async (req, res) => {
  const result = await AdminService.updateAdminNotification(
    req.params.id,
    req.body,
    req.user,
  );
  return result;
};

const deleteAdminNotificationController = async (req, res) => {
  const result = await AdminService.deleteAdminNotification(
    req.params.id,
    req.user,
  );
  return result;
};

// ── Driver Suspension Management ──────────────────────────────────────────────

const suspendDriverController = async (req, res) => {
  const { id } = req.params;
  const { reason, durationHours } = req.body;
  const adminId = req.user?._id;
  const result = await AdminService.suspendDriver(
    id,
    adminId,
    reason,
    durationHours,
    req.user,
  );
  return result;
};

const unsuspendDriverController = async (req, res) => {
  const { id } = req.params;
  const result = await AdminService.unsuspendDriver(id, req.user);
  return result;
};

const getSuspendedDriversController = async (req, res) => {
  const result = await AdminService.getSuspendedDrivers(req.query, req.user);
  return result;
};

const getDriverSuspensionController = async (req, res) => {
  const { id } = req.params;
  const result = await AdminService.getDriverSuspensionDetails(id, req.user);
  return result;
};

module.exports = {
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
  getPendingDriverRequests,
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
  forgotPasswordAdmin,
  verifyOTPController,
  resetPasswordAdmin,
  updatePasswordAdmin,
  createPromoCodeController,
  updatePromoCodeController,
  deletePromoCodeController,
  getAllPromoCodeController,
  updateUserOrDriver,
  getDriverSubscriptionTransactions,
  getRidesController,
  getRideByIdController,
  getCarpoolRidesController,
  getCarpoolDetailsController,
  getJourneyTimelineController,
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
};
