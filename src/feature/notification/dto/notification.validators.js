const { z } = require("zod");

const objectIdPattern = /^[0-9a-fA-F]{24}$/;

// Create Notification Validator
exports.CreateNotificationValidator = z.object({
  title: z.string().trim().nonempty("Please enter Title"),
  description: z.string().trim().nonempty("Please enter Description"),
});

// Send Notification Validator
exports.SendNotificationValidator = z.object({
  user: z
    .object({
      _id: z.string().regex(objectIdPattern, "Invalid _id format"),
      uid: z.string().trim().nonempty("Please enter Uid"),
      firstName: z.string().trim().nonempty("Please enter first name"),
      lastName: z.string().trim().nonempty("Please enter last name"),
      email: z.string().trim().email().optional().nullable(),
      profilePicture: z.string().trim().optional().nullable(),
    })
    .required(),
  title: z.string().trim().nonempty("Please enter Title"),
  description: z.string().trim().nonempty("Please enter Description"),
  chatId: z.string().trim().nonempty("Please enter Chat ID"),
});

// Read Notification Validator
exports.ReadNotificationValidator = z.object({
  notificationId: z
    .string()
    .regex(objectIdPattern, "Invalid notificationId format"),
});

// Delete Notification Validator
exports.DeleteNotificationValidator = z.object({
  notificationId: z
    .string()
    .regex(objectIdPattern, "Invalid notificationId format"),
});
