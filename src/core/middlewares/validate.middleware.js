const { BadRequestError } = require("../common/exceptions");

const validate = (schema) => {
  return (req, res, next) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const fieldPath = firstIssue.path[firstIssue.path.length - 1];
      const expected = firstIssue.expected || "valid value";

      // Custom readable message
      const message = `Invalid ${fieldPath} value: expected ${expected}`;
      return next(new BadRequestError(message));
    }

    req.body = result.data.body;
    req.query = result.data.query;
    req.params = result.data.params;

    next();
  };
};

const validateMultiple = (schemas) => {
  return (req, res, next) => {
    let validatedData = {
      body: req.body,
      query: req.query,
      params: req.params,
    };

    for (const schema of schemas) {
      const result = schema.safeParse(validatedData);

      if (!result.success) {
        const message = result.error.issues.map((e) => e.message).join(", ");

        return next(new BadRequestError(message));
      }

      validatedData = result.data;
    }

    req.body = validatedData.body;
    req.query = validatedData.query;
    req.params = validatedData.params;

    next();
  };
};

module.exports = { validate, validateMultiple };

 