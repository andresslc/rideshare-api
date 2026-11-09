const UserService = require("./user.service");

const getUserProfileController = async (req, res) => {
  const userId = req.user.id;
  const user = await UserService.getUserProfile(userId);

  return user;
};

const editUserProfileController = async (req, res) => {
  const userId = req.user.id;
  const user = await UserService.editUserProfile(req.body, req.file, userId);

  return user;
};

const attachCardController = async (req, res) => {
  const userId = req.user.id;
  const pmId = req.body.pmId;

  const card = await UserService.attachCard(userId, pmId);

  return card;
};

const topupWalletController = async (req, res) => {
  const userId = req.user.id;
  const { amount, cardId } = req.body;

  const result = await UserService.topupWallet({
    amount,
    cardId,
    userId,
  });

  return result;
};

const transactionHistoryController = async (req, res) => {
  const user = req.user;
  const pagination = req.query;

  const docs = await UserService.transactionHistory(pagination, user);

  return docs;
};

const cardsListController = async (req, res) => {
  const cardId = req.user.id;
  const cards = await UserService.cardsList(cardId);

  return cards;
};

const setCardAsDefaultController = async (req, res) => {
  const userId = req.user.id;
  const cardId = req.params.card;
  const locale = req.user.locale;

  const card = await UserService.setCardAsDefault(userId, cardId, locale);

  return card;
};

const removeCardController = async (req, res) => {
  const userId = req.user.id;
  const cardId = req.params.card;
  const locale = req.user.locale;

  const card = await UserService.removeCard(userId, cardId, locale);

  return card;
};

const saveLocationController = async (req, res) => {
  const userId = req.user.id;
  const locale = req.user.locale;

  const location = await UserService.saveLocation(req.body, userId, locale);

  return location;
};

const myLocationsController = async (req, res) => {
  const userId = req.user.id;
  const locale = req.user.locale;

  const locations = await UserService.myLocations(req.query, userId, locale);

  return locations;
};

const editLocationController = async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  const body = req.body;
  const locale = req.user.locale;

  const editedLocation = await UserService.editLocation(
    locationId,
    body,
    userId,
    locale,
  );

  return editedLocation;
};

const deleteLocationController = async (req, res) => {
  const userId = req.user.id;
  const locationId = req.params.id;
  const locale = req.user.locale;

  const deletedLocation = await UserService.deleteLocation(
    locationId,
    userId,
    locale,
  );

  return deletedLocation;
};

const updateLocationOrderController = async (req, res) => {
  const userId = req.user.id;
  const locationIds = req.body.locations;
  const locale = req.user.locale;

  const updatedLocations = await UserService.updateLocationOrder(
    userId,
    locationIds,
    locale,
  );

  return updatedLocations;
};

const deleteAccountController = async (req, res) => {
  const userId = req.user.id;
  const phone = req.user.phone;
  const otp = req.body.otp;
  const locale = req.user.locale;

  const deletedAccount = await UserService.deleteAccount(
    userId,
    phone,
    otp,
    locale,
  );

  return deletedAccount;
};

const changeLocaleController = async (req, res) => {
  const userId = req.user.id;
  const newLocale = req.body.locale;

  const result = await UserService.changeLocale(userId, newLocale);

  return result;
};

module.exports = {
  transactionHistoryController,
  cardsListController,
  getUserProfileController,
  editUserProfileController,
  topupWalletController,
  attachCardController,
  setCardAsDefaultController,
  removeCardController,
  saveLocationController,
  myLocationsController,
  deleteAccountController,
  updateLocationOrderController,
  editLocationController,
  deleteLocationController,
  changeLocaleController,
};
