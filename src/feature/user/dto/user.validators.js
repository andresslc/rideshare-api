const { default: mongoose } = require("mongoose");
const { z } = require("zod");

const empty = z.object({}).strip();
const isValidObjectId = (val) => mongoose.Types.ObjectId.isValid(val);

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

exports.attachCardValidator = z.object({
  body: z
    .object({
      pmId: z.string({
        required_error: "Payment method ID is required",
      }),
    })
    .strip(),
  query: empty,
  params: empty,
});

exports.topupWalletValidator = z.object({
  body: z
    .object({
      amount: z
        .number({
          required_error: "Amount is required",
          invalid_type_error: "Amount must be a number",
        })
        .positive("Amount must be greater than 0"),

      cardId: z
        .string({
          required_error: "Card ID is required",
          invalid_type_error: "Card ID must be a string",
        })
        .min(1, "Card ID is required"),
    })
    .strip(),

  query: empty,
  params: empty,
});

exports.saveLocationValidator = z.object({
  body: z
    .object({
      name: z
        .string({
          required_error: "Name is required",
          invalid_type_error: "Name must be a string",
        })
        .min(1, "Name is required"),

      address: z
        .string({
          required_error: "Address is required",
          invalid_type_error: "Address must be a string",
        })
        .min(1, "Address is required"),

      country: z
        .string({
          required_error: "Country is required",
          invalid_type_error: "Country must be a string",
        })
        .min(1, "Country is required"),

      city: z.string().optional(),

      state: z
        .string({
          required_error: "State is required",
          invalid_type_error: "State must be a string",
        })
        .min(1, "State is required"),

      coordinates: z.object({
        lat: z.number({
          required_error: "Latitude is required",
          invalid_type_error: "Latitude must be a number",
        }),
        lng: z.number({
          required_error: "Longitude is required",
          invalid_type_error: "Longitude must be a number",
        }),
      }),
    })
    .strip(),

  query: empty,
  params: empty,
});

exports.updateLocationOrderValidator = z.object({
  body: z
    .object({
      locations: z
        .array(
          z
            .string({
              required_error: "Location ID is required",
              invalid_type_error: "Location ID must be a string",
            })
            .refine(isValidObjectId, {
              message: "Invalid Location ID",
            }),
        )
        .min(1, "Locations array cannot be empty"),
    })
    .strip(),
  query: empty,
  params: empty,
});
