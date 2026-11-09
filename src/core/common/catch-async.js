const { sendSuccess } = require("./response.formatter");

const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next))
    .then((data) => {
      if (data?.csv) {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${data.filename}"`,
        );
        return res.send(data.csv);
      }

      return sendSuccess(res, data || {});
    })
    .catch(next);
};

module.exports = catchAsync;
