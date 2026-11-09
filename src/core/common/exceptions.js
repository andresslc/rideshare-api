const { STATUS_CODES } = require("./constants");

class AppError extends Error {
  constructor(message, statusCode, index) {
    super(message);
    this.statusCode = statusCode;
    this.index = index;
    Error.captureStackTrace(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = "Bad Request", index) {
    super(message, STATUS_CODES.BAD_REQUEST, index);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, STATUS_CODES.UNAUTHORIZED);
  }
}

class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, STATUS_CODES.FORBIDDEN);
  }
}

class NotFoundError extends AppError {
  constructor(message = "Not Found", index) {
    super(message, STATUS_CODES.NOT_FOUND, index);
  }
}

class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(message, STATUS_CODES.CONFLICT);
  }
}

class ValidationError extends AppError {
  constructor(message = "Validation Error", index) {
    super(message, STATUS_CODES.VALIDATION_ERROR, index);
  }
}

class InternalServerError extends AppError {
  constructor(message = "Internal Server Error") {
    super(message, STATUS_CODES.INTERNAL_SERVER_ERROR);
  }
}

module.exports = {
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  InternalServerError,
  AppError,
};
