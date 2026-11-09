exports.QUEUES = {
  WEBHOOK: "webhook",
  FILE_PROCESSING: "file-processing",
  USER: "user",
  JOURNEY_LOG: "journey-log",
  RIDE_DISPATCH: "ride-dispatch",
};

exports.STATUS_CODES = {
  SUCCESS: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 422,
  INTERNAL_SERVER_ERROR: 500,
};

exports.ADMIN_ROLES = {
  SUPER_ADMIN: "super_admin",
  ADMIN: "admin",
  GENERAL: "general",
};
