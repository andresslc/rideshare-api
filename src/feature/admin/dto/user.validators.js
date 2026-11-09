const { z } = require("zod");
const {
  lenientPhoneSchema,
  ssnSchema,
} = require("../../../core/common/global.validators");
const { RIDE_TYPE } = require("../../../core/common/constants/ride-constants");

const empty = z.object({}).strip();

exports.listUsersValidator = z.object({
  body: empty,
  query: z
    .object({
      type: z.enum(["rider", "driver"], {
        required_error: "User type is required",
        invalid_type_error: "User type must be either 'rider' or 'driver'",
      }),
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
      search: z.string().trim().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional().default("desc"),
    })
    .strip(),
  params: empty,
});

exports.getUserByIdValidator = z.object({
  body: empty,
  query: z
    .object({
      type: z.enum(["rider", "driver"], {
        required_error: "User type is required",
      }),
    })
    .strip(),
  params: z
    .object({
      id: z
        .string({
          required_error: "User ID is required",
        })
        .regex(/^[a-f\d]{24}$/i, "Invalid User ID"),
    })
    .strip(),
});

exports.updateUserStatusValidator = z.object({
  body: z
    .object({
      type: z.enum(["rider", "driver"], {
        required_error: "User type is required",
      }),
      status: z.enum(["active", "deactivated"], {
        required_error: "Status is required",
      }),
    })
    .strip(),
  query: empty,
  params: z
    .object({
      id: z
        .string({
          required_error: "User ID is required",
        })
        .regex(/^[a-f\d]{24}$/i, "Invalid User ID"),
    })
    .strip(),
});

exports.getSubscriptionRevenueValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
      search: z.string().trim().optional(),
      subscriptionStatus: z.enum(["active", "expired"]).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      dateField: z.enum(["createdAt", "currentPeriodEnd"]).optional(),
      sortBy: z.enum(["expiryDate", "purchaseDate"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .strip(),
  params: empty,
});

exports.getWithdrawalCommissionValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
      search: z.string().trim().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      sortBy: z.enum(["date", "withdrawalAmount"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .strip(),
  params: empty,
});

exports.listReportsValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
      status: z.enum(["pending", "resolved"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .strip(),
  params: empty,
});

exports.getReportByIdValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid Report ID"),
    })
    .strip(),
});

exports.resolveReportValidator = z.object({
  body: z
    .object({
      adminNotes: z.string().trim().optional(),
    })
    .strip(),
  query: empty,
  params: z
    .object({
      id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid Report ID"),
      status: z.enum(["rejected", "resolved"], {
        required_error: "Status is required",
      }),
    })
    .strip(),
});

exports.sendAdminNotificationValidator = z.object({
  body: z
    .object({
      recipientType: z.enum(["riders", "drivers", "both", "rider", "driver"], {
        required_error: "Recipient type is required",
      }),
      title: z
        .string({
          required_error: "Title is required",
        })
        .min(1, "Title cannot be empty"),
      message: z
        .string({
          required_error: "Message is required",
        })
        .min(1, "Message cannot be empty"),
      scheduledFor: z.string().optional(),
      recipientId: z.string().optional(),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.listAdminNotificationsValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z.string().regex(/^\d+$/).transform(Number).optional(),
      limit: z.string().regex(/^\d+$/).transform(Number).optional(),
      search: z.string().trim().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional().default("desc"),
    })
    .strip(),
  params: empty,
});

exports.getDashboardStatsValidator = z.object({
  body: empty,
  query: z
    .object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    })
    .strip(),
  params: empty,
});

exports.getRideAnalyticsValidator = z.object({
  body: empty,
  query: z
    .object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    })
    .strip(),
  params: empty,
});

exports.forgotPasswordAdminValidator = z.object({
  body: z
    .object({ email: z.string().email({ message: "Invalid email address" }) })
    .strip(),
  query: empty,
  params: empty,
});

exports.verifyOTPValidator = z.object({
  body: z
    .object({
      email: z.string().email({ message: "Invalid email address" }),
      otp: z.string().length(6, "OTP must be 6 digits"),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.resetPasswordAdminValidator = z.object({
  body: z
    .object({
      email: z.string().email({ message: "Invalid email address" }).optional(),
      newPassword: z.string(),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.updatePasswordAdminValidator = z.object({
  body: z.object({
    currentPassword: z.string({
      required_error: "Current password is required",
    }),
    newPassword: z.string({
      required_error: "New password is required",
    }),
  }),
});

exports.createAdminUserValidator = z.object({
  body: z
    .object({
      name: z
        .string({ required_error: "Name is required" })
        .trim()
        .min(1, "Name cannot be empty"),
      email: z
        .string({ required_error: "Email is required" })
        .email("Invalid email address"),
      password: z
        .string({ required_error: "Password is required" })
        .min(6, "Password must be at least 6 characters"),
      role: z.enum(["admin", "general"], {
        required_error: "Role is required",
        invalid_type_error: "Role must be either 'admin' or 'general'",
      }),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.listAdminUsersValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .refine((value) => value >= 1, "Page must be at least 1")
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .refine(
          (value) => value >= 1 && value <= 100,
          "Limit must be between 1 and 100",
        )
        .optional(),
      search: z.string().trim().optional(),
      role: z.enum(["admin", "general", "super_admin"]).optional(),
      isActive: z
        .enum(["true", "false"])
        .transform((v) => v === "true")
        .optional(),
      sort: z.enum(["asc", "desc"]).optional().default("desc"),
    })
    .strip(),
  params: empty,
});

exports.ExportUserValidator = z.object({
  body: empty,
  query: z
    .object({
      type: z.enum(["rider", "driver"], {
        required_error: "User type is required",
        invalid_type_error: "User type must be either 'rider' or 'driver'",
      }),
      search: z.string().trim().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional().default("desc"),
      fields: z
        .union([z.string(), z.array(z.string())])
        .transform((val) => (Array.isArray(val) ? val : [val]))
        .pipe(
          z.array(
            z.enum([
              "firstName",
              "lastName",
              "email",
              "phoneNumber",
              "address",
              "state",
              "city",
              "status",
            ]),
          ),
        )
        .optional(),
    })
    .strip(),
  params: empty,
});

exports.updateAdminUserValidator = z.object({
  body: z
    .object({
      name: z.string().trim().min(1, "Name cannot be empty").optional(),
      role: z
        .enum(["admin", "general"], {
          invalid_type_error: "Role must be either 'admin' or 'general'",
        })
        .optional(),
      isActive: z.boolean().optional(),
    })
    .strip()
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided for update",
    }),
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Admin user ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid admin user ID"),
    })
    .strip(),
});

/* Fields the admin panel may change on a rider or driver profile */
const UPDATE_USER_OR_DRIVER_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "dob",
  "ssn",
  "vehicleType",
  "subscriptionStatus",
  "balance",
];

const optionalText = z.string().trim().optional();

exports.updateUserOrDriverValidator = z.object({
  body: z
    .object({
      type: z
        .enum(["rider", "driver"], {
          error: "User type must be either 'rider' or 'driver'",
        })
        .optional(),
      firstName: z
        .string()
        .trim()
        .min(1, "First name cannot be empty")
        .optional(),
      lastName: z
        .string()
        .trim()
        .min(1, "Last name cannot be empty")
        .optional(),
      email: z
        .string()
        .trim()
        .toLowerCase()
        .email("Invalid email address")
        .optional(),
      phone: lenientPhoneSchema.optional(),
      phoneNumber: lenientPhoneSchema.optional(),
      address: optionalText,
      city: optionalText,
      state: optionalText,
      dob: z.string().trim().optional(),
      ssn: ssnSchema.optional(),
      vehicleType: z.enum(RIDE_TYPE).optional(),
      subscriptionStatus: z
        .enum([
          "incomplete",
          "incomplete_expired",
          "trialing",
          "active",
          "past_due",
          "canceled",
          "unpaid",
          "paused",
        ])
        .optional(),
      balance: z.union([z.number(), z.string()]).optional(),
      reason: z.string().trim().optional(),
      description: z.string().trim().optional(),
    })
    .strip()
    .superRefine((data, ctx) => {
      const isDriver = data.type === "driver";

      if (!isDriver) {
        for (const field of ["ssn", "vehicleType", "subscriptionStatus"]) {
          if (data[field] !== undefined) {
            ctx.addIssue({
              code: "custom",
              path: [field],
              message: `${field} can only be set for drivers`,
            });
          }
        }
      }

      if (isDriver && data.dob !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["dob"],
          message: "dob can only be set for riders",
        });
      }
    })
    .transform(({ phoneNumber, ...data }) => ({
      ...data,
      /* phoneNumber is an alias; phone wins when both are sent */
      ...(data.phone === undefined &&
        phoneNumber !== undefined && { phone: phoneNumber }),
    }))
    .refine(
      (data) =>
        UPDATE_USER_OR_DRIVER_FIELDS.some((field) => data[field] !== undefined),
      { message: "At least one field must be provided for update" },
    ),
  query: empty,
  params: z
    .object({
      id: z
        .string({ error: "User ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid User ID"),
    })
    .strip(),
});

exports.deleteAdminUserValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Admin user ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid admin user ID"),
    })
    .strip(),
});

exports.getAdminNotificationByIdValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Notification ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid notification ID"),
    })
    .strip(),
});

exports.updateAdminNotificationValidator = z.object({
  body: z
    .object({
      title: z.string().trim().min(1, "Title cannot be empty").optional(),
      message: z.string().trim().min(1, "Message cannot be empty").optional(),
      recipientType: z
        .enum(["riders", "drivers", "both", "rider", "driver"], {
          invalid_type_error: "Invalid recipient type",
        })
        .optional(),
      scheduledFor: z.string().optional(),
    })
    .strip()
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided for update",
    }),
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Notification ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid notification ID"),
    })
    .strip(),
});

exports.deleteAdminNotificationValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Notification ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid notification ID"),
    })
    .strip(),
});

// ── Driver Suspension Validators ──────────────────────────────────────────────

exports.suspendDriverValidator = z.object({
  body: z
    .object({
      reason: z
        .string({ required_error: "Suspension reason is required" })
        .trim()
        .min(1, "Reason cannot be empty"),
      durationHours: z
        .number({ invalid_type_error: "Duration must be a number" })
        .positive("Duration must be greater than 0")
        .optional(),
    })
    .strip(),
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Driver ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid Driver ID"),
    })
    .strip(),
});

exports.unsuspendDriverValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Driver ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid Driver ID"),
    })
    .strip(),
});

exports.getSuspendedDriversValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
      suspensionType: z
        .enum(["all", "cancellation", "admin_manual", "admin_permanent"])
        .optional()
        .default("all"),
      search: z.string().trim().optional(),
    })
    .strip(),
  params: empty,
});

exports.getDriverSuspensionValidator = z.object({
  body: empty,
  query: empty,
  params: z
    .object({
      id: z
        .string({ required_error: "Driver ID is required" })
        .regex(/^[a-f\d]{24}$/i, "Invalid Driver ID"),
    })
    .strip(),
});

exports.getRewardedBalanceHistoryValidator = z.object({
  body: empty,
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, "Page must be a number")
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, "Limit must be a number")
        .transform(Number)
        .optional(),
      search: z.string().trim().optional(),
      userType: z.enum(["rider", "driver", "user", "all"]).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      sortBy: z.enum(["date", "amount", "createdAt"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .strip(),
  params: empty,
});
