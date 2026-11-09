const ReportService = require("./reports.service");
const { capitalize } = require("../../core/common/helpers");

const addReportController = async (req, res) => {
  const { entityId, entityType, reason, description, supportingEntityId, supportingEntityType } = req.body;
  const reporterId = req.user._id;
  const reporterType = capitalize(req.session.role);
  const locale = req.user.locale;

  const result = await ReportService.addReport({
    reporterId,
    reporterType,
    entityId,
    entityType,
    reason,
    description,
    supportingEntityId,
    supportingEntityType,
    locale,
  });

  return result;
};

const deleteReportController = async (req, res) => {
  const { reportId } = req.params;
  const reporterId = req.user._id;
  const locale = req.user.locale;

  const result = await ReportService.deleteReport({
    reportId,
    reporterId,
    locale,
  });

  return result;
};

const getReportsController = async (req, res) => {
  const { page, limit, search, startDate, endDate, entityType } = req.query;
  const reporterId = req.user._id;
  const locale = req.user.locale;

  const result = await ReportService.getReports({
    page,
    limit,
    search,
    startDate,
    endDate,
    entityType,
    reporterId,
    locale,
  });

  return result;
};

module.exports = {
  addReportController,
  deleteReportController,
  getReportsController,
};
