const AppError = require("../utils/AppError.js");
const catchAsync = require("../utils/CatchAsync.js");

const SettingsModel = require("../models/SettingsModel.js");

const { UpdateSettingValidator } = require("../validators/SettingValidators.js");

const getSettings = catchAsync(async (req, res) => {
  const { role } = req.auth;

  let settings = await SettingsModel.findOne({
    $or: [
      { user: req.user._id },
      { store: req.user._id }
    ]
  }).lean();

  if (!settings) {
    const newSettings = role === 'user' ? { user: req.user._id } : { store: req.user._id };
    settings = await SettingsModel.create(newSettings);
  }

  return res.status(200).json({
    success: true,
    message: "Settings retrieved successfully",
    data: settings
  });
});

const updateSettings = catchAsync(async (req, res) => {
  try {
    await UpdateSettingValidator.validateAsync(req.body);
  } catch (error) {
    throw new AppError(error.message, 400);
  }

  const { role } = req.auth;

  const settings = await SettingsModel.findOne({
    $or: [
      { user: req.user._id },
      { store: req.user._id },
    ]
  }).lean();

  if (!settings) {
    const newSettings = role === 'user' ? { user: req.user._id } : { store: req.user._id };
    settings = await SettingsModel.create(newSettings);
  }

  await SettingsModel.findOneAndUpdate({ _id: settings._id }, { ...req.body }, { new: true })

  return res.status(200).json({
    success: true,
    message: "Settings updated successfully",
  });
});

module.exports = { getSettings, updateSettings }
