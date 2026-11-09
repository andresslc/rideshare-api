const { z } = require("zod");

const empty = z.object({}).strip();

exports.attachBankValidator = z.object({
  body: z
    .object({
      token: z
        .string({
          required_error: "Bank token is required",
        })
        .regex(/^btok_[a-zA-Z0-9]+$/, {
          message: "Invalid bank token",
        }),
    })
    .strip(),

  query: empty,
  params: empty,
});

exports.deleteBankValidator = z.object({
  body: z
    .object({
      bankId: z
        .string({
          required_error: "Bank ID is required",
        })
        .regex(/^ba_[a-zA-Z0-9]+$/, {
          message: "Invalid bank ID",
        }),
    })
    .strip(),

  query: empty,
  params: empty,
});

exports.withdrawValidator = z.object({
  body: z
    .object({
      amount: z
        .number({
          required_error: "Amount is required",
          invalid_type_error: "Amount must be a number",
        })
        .positive("Amount must be greater than 0"),

      bankId: z
        .string({
          required_error: "Bank ID is required",
          invalid_type_error: "Bank ID must be a string",
        })
        .min(1, "Bank ID is required"),
    })
    .strip(),

  query: empty,
  params: empty,
});

exports.deleteAccountValidator = z.object({
  body: z
    .object({
      otp: z.string({
        required_error: "OTP is required",
      }),
    })
    .strip(),
  query: empty,
  params: empty,
});
