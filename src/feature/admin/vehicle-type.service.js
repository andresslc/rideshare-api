const VehicleTypeModel = require("./model/vehicle-type.model");
const DriverModel = require("../driver/models/driver.model");
const VehicleModel = require("../driver/models/vehicle.model");
const {
  BadRequestError,
  NotFoundError,
} = require("../../core/common/exceptions");
const { aggregatePaginate } = require("../../core/common/helpers");

const DEFAULT_RIDE_TYPE = "economy";

/**
 * Get the default ride type (fallback for unmapped vehicles)
 */
const getDefaultRideType = () => {
  return DEFAULT_RIDE_TYPE;
};

/**
 * Look up ride type for a vehicle by make and model
 * First tries exact match [make, model], then falls back to make only
 * Returns the mapped rideType or default "economy" if not found
 */
const getVehicleTypeByMakeModel = async (model) => {
  if (!model) {
    return getDefaultRideType();
  }

  const normalizedModel = model ? model.trim().toLowerCase() : null;

  // First, try exact match [make, model]
  if (normalizedModel) {
    const exactMatch = await VehicleTypeModel.findOne({
      model: normalizedModel,
      isActive: true,
    }).lean();

    if (exactMatch) {
      return exactMatch.rideType;
    }
  }

  // Return default if no mapping found
  return getDefaultRideType();
};

/**
 * Create a new vehicle type mapping
 */
const createVehicleTypeMapping = async (data) => {
  const { model, rideType, notes } = data;

  const normalizedModel = model ? model.trim().toLowerCase() : null;

  // Check for existing mapping
  const existingMapping = await VehicleTypeModel.findOne({
    model: normalizedModel,
  });

  if (existingMapping) {
    throw new BadRequestError(`A mapping for model "${model}" already exists`);
  }

  const vehicleType = new VehicleTypeModel({
    model: normalizedModel,
    rideType,
    notes,
  });

  await vehicleType.save();

  return {
    data: vehicleType,
    message: "Vehicle type mapping created successfully",
  };
};

/**
 * List all vehicle type mappings with pagination and filters
 */
const listVehicleTypeMappings = async (filters) => {
  const { search, rideType, isActive, page = 1, limit = 20 } = filters;

  const parsedPage = parseInt(page, 10) || 1;
  const parsedLimit = parseInt(limit, 10) || 20;

  const matchStage = {};

  if (search) {
    matchStage.model = { $regex: search.trim().toLowerCase(), $options: "i" };
  }

  if (rideType) {
    matchStage.rideType = rideType;
  }

  if (isActive !== undefined) {
    matchStage.isActive = isActive;
  }

  const pipeline = [{ $match: matchStage }, { $sort: { createdAt: -1 } }];

  const result = await aggregatePaginate(
    VehicleTypeModel,
    pipeline,
    parsedPage,
    parsedLimit,
  );

  pipeline.push({ $skip: result.skip }, { $limit: parsedLimit });

  const vehicleTypes = await VehicleTypeModel.aggregate(pipeline);

  return {
    data: {
      result: vehicleTypes,
    },
    pagination: result.pagination,
  };
};

/**
 * Update a vehicle type mapping and propagate changes to drivers
 */
const updateVehicleTypeMapping = async (id, data) => {
  const vehicleType = await VehicleTypeModel.findById(id);

  if (!vehicleType) {
    throw new NotFoundError("Vehicle type mapping not found");
  }

  const oldModel = vehicleType.model;
  const oldRideType = vehicleType.rideType;

  if (data.model !== undefined) {
    vehicleType.model = data.model ? data.model.trim().toLowerCase() : null;
  }

  if (data.rideType !== undefined) {
    vehicleType.rideType = data.rideType;
  }

  if (data.notes !== undefined) {
    vehicleType.notes = data.notes;
  }

  if (data.isActive !== undefined) {
    vehicleType.isActive = data.isActive;
  }

  await vehicleType.save();

  // If rideType changed, propagate to drivers
  let affectedCount = 0;
  if (data.rideType && data.rideType !== oldRideType) {
    affectedCount = await propagateVehicleTypeChanges(oldModel, data.rideType);
  }

  return {
    data: vehicleType,
    affectedCount,
    message: `Vehicle type mapping updated successfully${
      affectedCount > 0 ? `. ${affectedCount} drivers updated.` : ""
    }`,
  };
};

/**
 * Delete a vehicle type mapping
 */
const deleteVehicleTypeMapping = async (id) => {
  const vehicleType = await VehicleTypeModel.findByIdAndDelete(id);

  if (!vehicleType) {
    throw new NotFoundError("Vehicle type mapping not found");
  }

  return {
    message: "Vehicle type mapping deleted successfully",
  };
};

/**
 * Helper function to propagate vehicle type changes to drivers
 * Updates all drivers whose active vehicles match the make/model to the new rideType
 */
const propagateVehicleTypeChanges = async (model, newRideType) => {
  // Find all vehicles with matching model
  const matchVehicles = await VehicleModel.find({
    model: model || { $in: [null, ""] },
    isDeleted: false,
  }).select("driver");

  if (matchVehicles.length === 0) {
    return 0;
  }

  const driverIds = matchVehicles.map((v) => v.driver);

  // Bulk update drivers with the new rideType
  const result = await DriverModel.updateMany(
    {
      _id: { $in: driverIds },
    },
    {
      $set: { vehicleType: newRideType },
    },
  );

  return result.modifiedCount;
};

module.exports = {
  getDefaultRideType,
  getVehicleTypeByMakeModel,
  createVehicleTypeMapping,
  listVehicleTypeMappings,
  updateVehicleTypeMapping,
  deleteVehicleTypeMapping,
};
