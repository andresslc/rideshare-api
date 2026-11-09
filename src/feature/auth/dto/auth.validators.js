const { z } = require("zod");
const { phoneSchema } = require("../../../core/common/global.validators");

/* -------------------- Helpers -------------------- */

const empty = z.object({}).strip();

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Please enter a valid Email address");

const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long");

const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, "OTP must be a 4 to 6 digit number");

/* ==================================================
   Signup
================================================== */

exports.SignupValidator = z.object({
  body: z
    .object({
      method: z.enum(["email", "google", "apple"]),
      email: emailSchema.optional(),
      password: passwordSchema.optional(),
      name: z.string().trim().min(1, "Name cannot be empty"),
      idToken: z.string().optional(),
    })
    .strip()
    .superRefine((data, ctx) => {
      if (data.method === "email") {
        if (!data.email) {
          ctx.addIssue({
            path: ["email"],
            message: "Email is required for email signup",
            code: "custom",
          });
        }
        if (!data.password) {
          ctx.addIssue({
            path: ["password"],
            message: "Password is required for email signup",
            code: "custom",
          });
        }
        if (data.idToken) {
          ctx.addIssue({
            path: ["idToken"],
            message: "idToken is not allowed for email signup",
            code: "custom",
          });
        }
      }

      if (data.method === "google" || data.method === "apple") {
        if (!data.idToken) {
          ctx.addIssue({
            path: ["idToken"],
            message: "idToken is required for social login",
            code: "custom",
          });
        }
        if (data.password) {
          ctx.addIssue({
            path: ["password"],
            message: "Password is not allowed for social login",
            code: "custom",
          });
        }
      }
    }),
  query: empty,
  params: empty,
});

/* ==================================================
   Signin
================================================== */

exports.SigninValidator = z.object({
  body: z
    .object({
      method: z.enum(["email", "google", "apple"]),
      email: emailSchema,
      password: passwordSchema.optional(),
      idToken: z.string().optional(),
    })
    .strip()
    .superRefine((data, ctx) => {
      if (data.method === "email" && !data.password) {
        ctx.addIssue({
          path: ["password"],
          message: "Password is required for email login",
          code: "custom",
        });
      }

      if (
        (data.method === "google" || data.method === "apple") &&
        !data.idToken
      ) {
        ctx.addIssue({
          path: ["idToken"],
          message: "idToken is required for social login",
          code: "custom",
        });
      }

      if (
        (data.method === "google" || data.method === "apple") &&
        data.password
      ) {
        ctx.addIssue({
          path: ["password"],
          message: "Password is not allowed for social login",
          code: "custom",
        });
      }
    }),
  query: empty,
  params: empty,
});

/* ==================================================
   OTP
================================================== */

exports.OTPValidator = z.object({
  body: z
    .object({
      otp: z.string().trim().min(1, "OTP is required"),
    })
    .strip(),
  query: empty,
  params: empty,
});

/* ==================================================
   Verify OTP
================================================== */

exports.verifyPhoneOTP = z.object({
  body: z
    .object({
      phone: phoneSchema,
      otp: otpSchema,
      role: z.string(),
      fcmToken: z.string().optional(),
      locale: z.enum(["en", "es"]).optional(),
    })
    .strip(),
  query: empty,
  params: empty,
});

/* ==================================================
   Forgot Password
================================================== */

exports.forgotPasswordControllerValidator = z.object({
  body: z
    .object({
      email: emailSchema,
    })
    .strip(),
  query: empty,
  params: empty,
});

/* ==================================================
   Update Password
================================================== */

exports.updatePasswordControllerValidator = z.object({
  body: z
    .object({
      password: passwordSchema,
    })
    .strip(),
  query: empty,
  params: empty,
});

/* ==================================================
   Change Password
================================================== */

exports.ChangePasswordValidator = z.object({
  body: z
    .object({
      password: passwordSchema,
      newPassword: passwordSchema,
    })
    .strip()
    .refine((d) => d.password !== d.newPassword, {
      path: ["newPassword"],
      message: "New password must be different from the current password",
    }),
  query: empty,
  params: empty,
});

/* -------------------- Send OTP Validator -------------------- */

exports.SendOtpValidator = z.object({
  body: z
    .object({
      phone: phoneSchema,
      role: z.enum(["user", "admin", "driver"], {
        errorMap: () => ({ message: "Invalid role provided" }),
      }),
      locale: z.enum(["en", "es"]).optional(),
    })
    .strip(),
  query: empty,
  params: empty,
});

/* -------------------- Send Onboard Validator -------------------- */

exports.OnboardUserValidator = z.object({
  body: z
    .object({
      phone: phoneSchema,
      email: emailSchema,
      firstName: z
        .string()
        .trim()
        .min(1, "First name must be at least 1 character long"),
      lastName: z
        .string()
        .trim()
        .min(1, "Last name must be at least 1 character long"),
      fcmToken: z.string().optional(),
      referredBy: z.string().optional(),
      // Riders only: a driver's referral code, saved for their first ride.
      referralCode: z.string().trim().max(20).optional(),
      ssn: z.string().optional(),
      dob: z.string().optional(),
      address: z.string().trim().optional(),
      state: z.string().trim().optional(),
      city: z.string().trim().optional(),
    })
    .strip(),
  query: empty,
  params: z.object({
    role: z.enum(["user", "driver"], {
      errorMap: () => ({ message: "Invalid role provided" }),
    }),
  }),
});

/* ==================================================
   Update FCM Token
================================================== */

exports.updateFCMTokenControllerValidator = z.object({
  body: z
    .object({
      fcmToken: z.string().trim().min(1, "FCM token cannot be empty"),
    })
    .strip(),
  query: empty,
  params: empty,
});

const documentStatusSchema = z
  .object({
    id: z.string({
      required_error: "Document id is required",
      invalid_type_error: "Document id must be a string",
    }),

    status: z.enum(["approved", "rejected"], {
      errorMap: () => ({ message: "Status must be approved or rejected" }),
    }),

    rejectReason: z
      .string({
        invalid_type_error: "Reject reason must be a string",
      })
      .min(1, "Reject reason cannot be empty")
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.status === "rejected" && !data.rejectReason) {
      ctx.addIssue({
        code: "custom",
        message: "Reject reason is required when status is rejected",
        path: ["rejectReason"],
      });
    }

    if (data.status === "approved" && data.rejectReason) {
      ctx.addIssue({
        code: "custom",
        message: "Reject reason should not be provided when status is approved",
        path: ["rejectReason"],
      });
    }
  });

exports.RespondToDocsValidator = z.object({
  body: z
    .object({
      documents: z
        .array(documentStatusSchema, {
          required_error: "Documents array is required",
        })
        .min(1, "At least one document is required"),
    })
    .strip(),
  query: empty,
  params: empty,
});
