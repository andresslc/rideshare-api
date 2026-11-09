const { z } = require("zod");

const PaginationValidator = z.object({
  query: z.object({
    page: z.string().optional().default(1),
    limit: z.string().optional().default(20),
    startDate: z.preprocess(
      (arg) => (arg ? new Date(arg) : undefined),
      z.date().optional(),
    ),
    endDate: z.preprocess(
      (arg) => (arg ? new Date(arg) : undefined),
      z.date().optional(),
    ),
    search: z.string().optional().default(""),
  }),
});

/* Phone numbers are stored as digits only, country code included, no "+" */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{10,15}$/, "Please enter a valid phone number");

/* Accepts "+1 (305) 555-1234" style input and stores "13055551234" */
const lenientPhoneSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? value.replace(/[\s\-().]/g, "").replace(/^\+/, "")
      : value,
  phoneSchema,
);

/* Accepts "123-45-6789" or "123456789" and stores "123456789" */
const ssnSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.replace(/[\s-]/g, "") : value),
  z.string().regex(/^\d{9}$/, "SSN must be 9 digits"),
);

module.exports = {
  PaginationValidator,
  phoneSchema,
  lenientPhoneSchema,
  ssnSchema,
};
