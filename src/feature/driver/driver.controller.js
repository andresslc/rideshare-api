const DriverService = require("./driver.service");

const setupConnectedAccoutController = async (req, res) => {
  const driverId = req.user.id;
  const accountLink = await DriverService.setupConnectedAccout(driverId);

  return accountLink;
};

const attachBankAccountController = async (req, res) => {
  const driverId = req.user.id;
  const token = req.body.token;

  const externalAccount = await DriverService.attachBankAccount(
    driverId,
    token,
  );

  return externalAccount;
};

const deleteBankAccountController = async (req, res) => {
  const driverId = req.user.id;
  const bankId = req.body.bankId;

  const result = await DriverService.deleteBankAccount(driverId, bankId);

  return result;
};

const withdrawController = async (req, res) => {
  const { amount, bankId } = req.body;
  const driverId = req.user.id;

  const withdrawRequest = await DriverService.withdraw({
    driverId,
    amount: Number(amount),
    bankId,
  });

  return withdrawRequest;
};

const transactionHistoryController = async (req, res) => {
  const driver = req.user;
  const pagination = req.query;

  const docs = await DriverService.transactionHistory(pagination, driver);

  return docs;
};

const banksListController = async (req, res) => {
  const driverId = req.user.id;
  const banks = await DriverService.banksList(driverId);

  return banks;
};

const getMeController = async (req, res) => {
  const driverId = req.user.id;
  const driver = await DriverService.getMe(driverId);

  return driver;
};

const editDriverController = async (req, res) => {
  const driverId = req.user.id;
  const typeKey = req.params.type;
  const files = req.files;
  const body = req.body;
  const locale = req.user.locale;

  const driver = await DriverService.editDriver(
    body,
    files,
    typeKey,
    driverId,
    locale,
  );

  return driver;
};

const deleteAccountController = async (req, res) => {
  const driverId = req.user.id;
  const phone = req.user.phone;
  const otp = req.body.otp;
  const locale = req.user.locale;

  const deletedAccount = await DriverService.deleteAccount(
    driverId,
    phone,
    otp,
    locale,
  );

  return deletedAccount;
};

const changeLocaleController = async (req, res) => {
  const driverId = req.user.id;
  const newLocale = req.body.locale;

  const result = await DriverService.changeLocale(driverId, newLocale);

  return result;
};

const setDefaultBankAccountController = async (req, res) => {
  const driverId = req.user.id;
  const bankId = req.body.bankId;

  const result = await DriverService.setDefaultBankAccount(driverId, bankId);

  return result;
};

const dashboardController = async (req, res) => {
  const driverId = req.user.id;

  const dashboardData = await DriverService.dashboard(driverId);

  return dashboardData;
};

const driverStatsController = async (req, res) => {
  const driverId = req.params.id;

  const result = await DriverService.driverStats(driverId, req.query);

  return result;
};

module.exports = {
  setDefaultBankAccountController,
  setupConnectedAccoutController,
  attachBankAccountController,
  deleteBankAccountController,
  transactionHistoryController,
  banksListController,
  withdrawController,
  getMeController,
  editDriverController,
  deleteAccountController,
  changeLocaleController,
  dashboardController,
  driverStatsController,
};
