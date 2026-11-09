// core/helpers/response.js

const { STATUS_CODES } = require("./constants");

/**
 * Standard success response
 * @param {Object} res - Express response object
 * @param {Object} options - { data, message, meta }
 */
const sendSuccess = (
  res,
  { data = null, message = "Operation Successfully", pagination, statusCode },
) => {
  const response = {
    success: true,
    message,
    ...(data !== null && { data }),
  };

  if (pagination) {
    response.pagination = pagination;
  }

  return res.status(statusCode || STATUS_CODES.SUCCESS).json(response);
};

const sendError = (error, req, res, next) => {
  const errorObj = {
    success: false,
    message: error.message || "Internal Server Error",
  };
  if (error.index !== undefined && error.index !== "") {
    errorObj.index = error.index;
  }
  console.error("ERROR 😈", error);
  return res
    .status(error.statusCode || STATUS_CODES.INTERNAL_SERVER_ERROR)
    .json(errorObj);
};

module.exports = { sendSuccess, sendError };
