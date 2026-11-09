const mongoose = require("mongoose");
const {
  NotFoundError,
  BadRequestError,
} = require("../../core/common/exceptions");
const { t, aggregatePaginate } = require("../../core/common/helpers");

const UserModel = require("../user/models/user.model");
const DriverModel = require("../driver/models/driver.model");
const ReviewModel = require("./models/review.model");
const {
  sendNotificationToSpecificUser,
} = require("../notification/notification.service");

const getModel = (type) => (type === "Driver" ? DriverModel : UserModel);

const addReview = async ({
  stars,
  description,
  reviewerId,
  reviewerType,
  receiverId,
  receiverType,
  locale,
  rideId,
  carpoolId,
}) => {
  const ReceiverModel = getModel(receiverType);
  const ReviewerModel = getModel(reviewerType);

  const [receiver, reviewer] = await Promise.all([
    ReceiverModel.findOne({ _id: receiverId, isDeleted: false }),
    ReviewerModel.findOne({ _id: reviewerId, isDeleted: false }),
  ]);

  if (!receiver) throw new NotFoundError(t("RECEIVER_NOT_FOUND", locale));
  if (!reviewer) throw new NotFoundError(t("REVIEWER_NOT_FOUND", locale));

  if (reviewerId.toString() === receiverId.toString()) {
    throw new BadRequestError(t("SELF_REVIEW_NOT_ALLOWED", locale));
  }

  const result = await ReviewModel.aggregate([
    {
      $match: {
        receiver: new mongoose.Types.ObjectId(receiverId),
        receiverType,
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        totalStars: { $sum: "$stars" },
        numberOfReviews: { $sum: 1 },
      },
    },
  ]);

  const existingTotal = result.length > 0 ? result[0].totalStars : 0;
  const existingCount = result.length > 0 ? result[0].numberOfReviews : 0;
  const newRating = ((existingTotal + stars) / (existingCount + 1)).toFixed(1);

  const [review] = await Promise.all([
    ReviewModel.create({
      reviewer: reviewerId,
      reviewerType,
      receiver: receiverId,
      receiverType,
      stars,
      description,
      ride: rideId,
      carpool: carpoolId,
    }),
    ReceiverModel.findOneAndUpdate(
      { _id: receiverId },
      { rating: newRating, $inc: { reviewsReceived: 1 } },
      { new: true },
    ),
    ReviewerModel.findOneAndUpdate(
      { _id: reviewerId },
      { $inc: { reviewsGiven: 1 } },
      { new: true },
    ),
  ]);

  sendNotificationToSpecificUser({
    title: t(
      "NOTIFICATION_NEW_REVIEW_RECEIVED_TITLE",
      receiver?.locale || "en",
    ),
    description: t(
      "NOTIFICATION_NEW_REVIEW_RECEIVED_DESC",
      receiver?.locale || "en",
    ),
    userIds: [receiverId],
    metadata: {
      type: "REVIEW_RECEIVED",
    }
  });

  sendNotificationToSpecificUser({
    title: t("NOTIFICATION_REVIEW_SUBMITTED_TITLE", reviewer?.locale || "en"),
    description: t(
      "NOTIFICATION_REVIEW_SUBMITTED_DESC",
      reviewer?.locale || "en",
    ),
    userIds: [reviewerId],
    metadata: {
      type: "REVIEW"
    }
  });

  return {
    success: true,
    message: t("REVIEW_ADDED_SUCCESSFULLY", locale),
    data: { review },
  };
};

const updateReview = async ({
  reviewId,
  stars,
  description,
  reviewerId,
  locale,
}) => {
  const review = await ReviewModel.findOne({
    _id: reviewId,
    reviewer: reviewerId,
  });
  if (!review) throw new NotFoundError(t("REVIEW_NOT_FOUND", locale));

  const ReceiverModel = getModel(review.receiverType);

  if (stars) {
    const result = await ReviewModel.aggregate([
      {
        $match: {
          receiver: new mongoose.Types.ObjectId(review.receiver),
          receiverType: review.receiverType,
          isDeleted: false,
          _id: { $ne: review._id },
        },
      },
      {
        $group: {
          _id: null,
          totalStars: { $sum: "$stars" },
          numberOfReviews: { $sum: 1 },
        },
      },
    ]);

    const existingTotal = result.length > 0 ? result[0].totalStars : 0;
    const existingCount = result.length > 0 ? result[0].numberOfReviews : 0;
    const newRating = ((existingTotal + stars) / (existingCount + 1)).toFixed(
      1,
    );

    await ReceiverModel.findOneAndUpdate(
      { _id: review.receiver },
      { rating: newRating },
      { new: true },
    );
  }

  await ReviewModel.findOneAndUpdate(
    { _id: reviewId },
    { stars, description },
    { new: true },
  );

  return {
    success: true,
    message: t("REVIEW_UPDATED_SUCCESSFULLY", locale),
  };
};

const deleteReview = async ({ reviewId, reviewerId, reviewerType, locale }) => {
  const review = await ReviewModel.findOne({
    _id: reviewId,
    reviewer: reviewerId,
  });
  if (!review) throw new NotFoundError(t("REVIEW_NOT_FOUND", locale));

  const ReceiverModel = getModel(review.receiverType);
  const ReviewerModel = getModel(reviewerType);

  const result = await ReviewModel.aggregate([
    {
      $match: {
        receiver: new mongoose.Types.ObjectId(review.receiver),
        receiverType: review.receiverType,
        isDeleted: false,
        _id: { $ne: review._id },
      },
    },
    {
      $group: {
        _id: null,
        totalStars: { $sum: "$stars" },
        numberOfReviews: { $sum: 1 },
      },
    },
  ]);

  const remainingTotal = result.length > 0 ? result[0].totalStars : 0;
  const remainingCount = result.length > 0 ? result[0].numberOfReviews : 0;
  const newRating =
    remainingCount > 0 ? (remainingTotal / remainingCount).toFixed(1) : 0;

  await Promise.all([
    ReceiverModel.findOneAndUpdate(
      { _id: review.receiver },
      { rating: newRating, $inc: { reviewsReceived: -1 } },
      { new: true },
    ),
    ReviewerModel.findOneAndUpdate(
      { _id: reviewerId },
      { $inc: { reviewsGiven: -1 } },
      { new: true },
    ),
    ReviewModel.deleteOne({ _id: reviewId }),
  ]);

  return {
    success: true,
    message: t("REVIEW_DELETED_SUCCESSFULLY", locale),
  };
};

const getReviews = async ({
  type,
  search,
  startDate,
  endDate,
  page,
  limit,
  userId,
  requesterId,
  locale,
}) => {
  if (type !== "given" && type !== "received") {
    throw new BadRequestError(t("INVALID_REVIEW_TYPE", locale));
  }

  const targetId = userId || requesterId;

  if (!/^[0-9a-fA-F]{24}$/.test(targetId)) {
    throw new BadRequestError(t("INVALID_USER_ID", locale));
  }

  const parsedPage = parseInt(page) || 1;
  const parsedLimit = parseInt(limit) || 10;

  const matchStage = { isDeleted: false };

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

  if (type === "given") {
    matchStage.reviewer = new mongoose.Types.ObjectId(targetId);
  } else {
    matchStage.receiver = new mongoose.Types.ObjectId(targetId);
  }

  const summaryResult = await ReviewModel.aggregate([
    { $match: { ...matchStage } },
    {
      $group: {
        _id: null,
        totalReviews: { $sum: 1 },
        averageRating: { $avg: "$stars" },
        fiveStars: { $sum: { $cond: [{ $eq: ["$stars", 5] }, 1, 0] } },
        fourStars: { $sum: { $cond: [{ $eq: ["$stars", 4] }, 1, 0] } },
        threeStars: { $sum: { $cond: [{ $eq: ["$stars", 3] }, 1, 0] } },
        twoStars: { $sum: { $cond: [{ $eq: ["$stars", 2] }, 1, 0] } },
        oneStar: { $sum: { $cond: [{ $eq: ["$stars", 1] }, 1, 0] } },
      },
    },
  ]);

  const summary =
    summaryResult.length > 0
      ? {
          averageRating: parseFloat(summaryResult[0].averageRating.toFixed(1)),
          totalReviews: summaryResult[0].totalReviews,
          breakdown: {
            5: summaryResult[0].fiveStars,
            4: summaryResult[0].fourStars,
            3: summaryResult[0].threeStars,
            2: summaryResult[0].twoStars,
            1: summaryResult[0].oneStar,
          },
        }
      : {
          averageRating: 0,
          totalReviews: 0,
          breakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
        };

  const aggregatePipeline = [
    { $match: matchStage },
    {
      $lookup: {
        from: "users",
        let: { reviewerId: "$reviewer", rType: "$reviewerType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$reviewerId"] },
                  { $eq: ["$$rType", "User"] },
                ],
              },
            },
          },
        ],
        as: "reviewerUser",
      },
    },
    {
      $lookup: {
        from: "drivers",
        let: { reviewerId: "$reviewer", rType: "$reviewerType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$reviewerId"] },
                  { $eq: ["$$rType", "Driver"] },
                ],
              },
            },
          },
        ],
        as: "reviewerDriver",
      },
    },
    {
      $addFields: {
        reviewer: {
          $cond: {
            if: { $gt: [{ $size: "$reviewerUser" }, 0] },
            then: { $arrayElemAt: ["$reviewerUser", 0] },
            else: { $arrayElemAt: ["$reviewerDriver", 0] },
          },
        },
      },
    },
    {
      $lookup: {
        from: "users",
        let: { receiverId: "$receiver", rType: "$receiverType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$receiverId"] },
                  { $eq: ["$$rType", "User"] },
                ],
              },
            },
          },
        ],
        as: "receiverUser",
      },
    },
    {
      $lookup: {
        from: "drivers",
        let: { receiverId: "$receiver", rType: "$receiverType" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$_id", "$$receiverId"] },
                  { $eq: ["$$rType", "Driver"] },
                ],
              },
            },
          },
        ],
        as: "receiverDriver",
      },
    },
    {
      $addFields: {
        receiver: {
          $cond: {
            if: { $gt: [{ $size: "$receiverUser" }, 0] },
            then: { $arrayElemAt: ["$receiverUser", 0] },
            else: { $arrayElemAt: ["$receiverDriver", 0] },
          },
        },
      },
    },
    {
      $project: {
        reviewerUser: 0,
        reviewerDriver: 0,
        receiverUser: 0,
        receiverDriver: 0,
      },
    },
  ];

  if (search) {
    const searchTarget = type === "given" ? "receiver" : "reviewer";
    aggregatePipeline.push({
      $match: {
        $or: [
          {
            [`${searchTarget}.firstName`]: { $regex: search, $options: "i" },
          },
          {
            [`${searchTarget}.lastName`]: { $regex: search, $options: "i" },
          },
          { description: { $regex: search, $options: "i" } },
        ],
      },
    });
  }

  const { skip, pagination } = await aggregatePaginate(
    ReviewModel,
    aggregatePipeline,
    parsedPage,
    parsedLimit,
  );

  aggregatePipeline.push(
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: parsedLimit },
  );

  const result = await ReviewModel.aggregate(aggregatePipeline);

  const reviews = result.map((review) => {
    review.isOwn = review.reviewer?._id.toString() === requesterId.toString();
    return reviewParser(review);
  });

  return {
    success: true,
    message: t("REVIEWS_FETCHED_SUCCESSFULLY", locale),
    data: {
      summary,
      reviews,
    },
    pagination,
  };
};

const reviewParser = (obj) => {
  return {
    _id: obj._id,
    reviewer: {
      _id: obj.reviewer?._id,
      firstName: obj.reviewer?.firstName,
      lastName: obj.reviewer?.lastName,
      username: obj.reviewer?.username,
      profilePicture: obj.reviewer?.profilePicture,
    },
    receiver: {
      _id: obj.receiver?._id,
      firstName: obj.receiver?.firstName,
      lastName: obj.receiver?.lastName,
      username: obj.receiver?.username,
      profilePicture: obj.receiver?.profilePicture,
    },
    reviewerType: obj.reviewerType,
    receiverType: obj.receiverType,
    stars: obj.stars,
    description: obj.description,
    isOwn: obj.isOwn,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
};

module.exports = {
  addReview,
  updateReview,
  deleteReview,
  getReviews,
};
