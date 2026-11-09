const { ForbiddenError } = require("../common/exceptions");

const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError(
        "You do not have permission to perform this action",
      );
    }
    next();
  };
};

module.exports = restrictTo;
