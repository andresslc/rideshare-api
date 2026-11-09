const mongoose = require("mongoose");
const {
  NotFoundError,
  BadRequestError,
} = require("../../core/common/exceptions");
const { t, aggregatePaginate } = require("../../core/common/helpers");

const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const ReportModel = require("./models/report.model");

const getModel = (type) => (type === "Driver" ? DriverModel : UserModel);

const addReport = async ({
  reporterId,
  reporterType,
  entityId,
  entityType,
  reason,
  description,
  supportingEntityId,
  supportingEntityType,
  locale,
}) => {
  const EntityModel = getModel(entityType);

  const [entity, reporter] = await Promise.all([
    EntityModel.findOne({ _id: entityId, isDeleted: false }),
    getModel(reporterType).findOne({ _id: reporterId, isDeleted: false }),
  ]);

  if (!entity) throw new NotFoundError(t("ENTITY_NOT_FOUND", locale));
  if (!reporter) throw new NotFoundError(t("REPORTER_NOT_FOUND", locale));

  if (reporterId.toString() === entityId.toString()) {
    throw new BadRequestError(t("SELF_REPORT_NOT_ALLOWED", locale));
  }

  const existingReport = await ReportModel.findOne({
    reporter: reporterId,
    entityId,
    supportingEntityId,
    supportingEntityType,
    isDeleted: false,
  });

  if (existingReport) throw new BadRequestError(t("ALREADY_REPORTED", locale));

  const report = await ReportModel.create({
    reporter: reporterId,
    reporterType,
    entityId,
    entityType,
    supportingEntityId,
    supportingEntityType,
    reason,
    description,
  });

  return {
    success: true,
    message: t("REPORT_ADDED_SUCCESSFULLY", locale),
    data: { report },
  };
};

const deleteReport = async ({ reportId, reporterId, locale }) => {
  const report = await ReportModel.findOne({
    _id: reportId,
    reporter: reporterId,
  });
  if (!report) throw new NotFoundError(t("REPORT_NOT_FOUND", locale));

  await ReportModel.deleteOne({ _id: reportId });

  return {
    success: true,
    message: t("REPORT_DELETED_SUCCESSFULLY", locale),
  };
};

const getReports = async ({
  page,
  limit,
  search,
  startDate,
  endDate,
  entityType,
  reporterId,
  locale,
}) => {
  const parsedPage = parseInt(page) || 1;
  const parsedLimit = parseInt(limit) || 10;

  const matchStage = {
    reporter: new mongoose.Types.ObjectId(reporterId),
    isDeleted: false,
  };

  if (entityType) matchStage.entityType = entityType;

  if (startDate && endDate) {
    const parsedStartDate = new Date(decodeURIComponent(startDate));
    const parsedEndDate = new Date(decodeURIComponent(endDate));

    if (isNaN(parsedStartDate) || isNaN(parsedEndDate)) {
      throw new BadRequestError(t("INVALID_DATE_FORMAT", locale));
    }

    matchStage.createdAt = {
      $gte: parsedStartDate,
      $lte: parsedEndDate,
    };
  }

  const aggregatePipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "users",
        let: { entityId: "$entityId", eType: "$entityType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$entityId"] },
                  { $eq: ["$$eType", "User"] },
                ],
              },
            },
          },
        ],
        as: "entityUser",
      },
    },
    {
      $lookup: {
        from: "drivers",
        let: { entityId: "$entityId", eType: "$entityType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$entityId"] },
                  { $eq: ["$$eType", "Driver"] },
                ],
              },
            },
          },
        ],
        as: "entityDriver",
      },
    },
    {
      $addFields: {
        entity: {
          $cond: {
            if: { $gt: [{ $size: "$entityUser" }, 0] },
            then: { $arrayElemAt: ["$entityUser", 0] },
            else: { $arrayElemAt: ["$entityDriver", 0] },
          },
        },
      },
    },
    {
      $project: {
        entityUser: 0,
        entityDriver: 0,
      },
    },
  ];

  if (search) {
    aggregatePipeline.push({
      $match: {
        $or: [
          { "entity.firstName": { $regex: search, $options: "i" } },
          { "entity.lastName": { $regex: search, $options: "i" } },
          { "entity.username": { $regex: search, $options: "i" } },
          { "entity.phone": { $regex: search, $options: "i" } },
          { reason: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  const { skip, pagination } = await aggregatePaginate(
    ReportModel,
    aggregatePipeline,
    parsedPage,
    parsedLimit,
  );

  aggregatePipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  );

  const result = await ReportModel.aggregate(aggregatePipeline);

  const reports = result.map(reportParser);

  return {
    success: true,
    message: t("REPORTS_FETCHED_SUCCESSFULLY", locale),
    data: { reports },
    pagination,
  };
};

const reportParser = (obj) => {
  return {
    _id: obj._id,
    entity: {
      _id: obj.entity?._id,
      firstName: obj.entity?.firstName,
      lastName: obj.entity?.lastName,
      username: obj.entity?.username,
      profilePicture: obj.entity?.profilePicture,
    },
    entityType: obj.entityType,
    reporterType: obj.reporterType,
    reason: obj.reason,
    description: obj.description,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
};

module.exports = { addReport, deleteReport, getReports };
