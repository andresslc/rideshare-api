const ReviewService = require("./review.service");
const { capitalize } = require("../../core/common/helpers");

const addReviewController = async (req, res) => {
  const { receiverId, receiverType, stars, description, rideId, carpoolId } =
    req.body;
  const reviewerId = req.user._id;
  const reviewerType = capitalize(req.session.role);
  const locale = req.user.locale;

  const result = await ReviewService.addReview({
    stars,
    description,
    reviewerId,
    reviewerType,
    receiverId,
    receiverType,
    locale,
    rideId,
    carpoolId,
  });

  return result;
};

const updateReviewController = async (req, res) => {
  const { reviewId, stars, description } = req.body;
  const reviewerId = req.user._id;
  const locale = req.user.locale;

  const result = await ReviewService.updateReview({
    reviewId,
    stars,
    description,
    reviewerId,
    locale,
  });

  return result;
};

const deleteReviewController = async (req, res) => {
  const { reviewId } = req.params;
  const reviewerId = req.user._id;
  const reviewerType = capitalize(req.session.role);
  const locale = req.user.locale;

  const result = await ReviewService.deleteReview({
    reviewId,
    reviewerId,
    reviewerType,
    locale,
  });

  return result;
};

const getReviewsController = async (req, res) => {
  const { search, startDate, endDate, page, limit, userId } = req.query;
  const requesterId = req.user._id;
  const locale = req.user.locale;

  const result = await ReviewService.getReviews({
    type: "received",
    search,
    startDate,
    endDate,
    page,
    limit,
    userId,
    requesterId,
    locale,
  });

  return result;
};

module.exports = {
  addReviewController,
  updateReviewController,
  deleteReviewController,
  getReviewsController,
};
