const { z } = require("zod");

exports.sendMessageValidator = z.object({
  body: z.object({
    receiverId: z.string().min(1),
    message: z.string().min(1).max(2000),
    contextId: z.string({
      required_error: "Document id is required",
      invalid_type_error: "Document id must be a string",
    }),
    contextType: z.enum(["Ride", "CarpoolBooking"], {
      errorMap: () => ({
        message: "Context type must be either 'Ride' or 'CarpoolBooking'",
      }),
    }),
  }),
});

exports.historyValidator = z.object({
  params: z.object({
    contextId: z.string({
      required_error: "Document id is required",
      invalid_type_error: "Document id must be a string",
    }),
  }),
  query: z.object({
    page: z.string().optional().default(1),
    limit: z.string().optional().default(20),
  }),
});

exports.markAsReadValidator = z.object({
  conversationId: z.string().min(1),
});
