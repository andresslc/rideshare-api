const TOTAL_VERIFICATION_ITEMS = 4;

const formatLabels = (labels) =>
  labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
    : labels[0];

const buildDriverVerificationEmail = ({
  status,
  reviewedItems,
  approvedCount,
  frontendUrl,
}) => {
  if (status === "approved") {
    if (approvedCount === TOTAL_VERIFICATION_ITEMS) {
      return {
        subject: "All Documents Approved - RideShare",
        message: `Congratulations! All your documents have been approved. You can now access the RideShare app.

Thank you for choosing RideShare. We’re excited to have you on the road!`,
      };
    }

    const approvedLabels = reviewedItems.map((item) => item.label);
    const isMultipleApprovals = approvedLabels.length > 1;
    const formattedLabels = formatLabels(approvedLabels);

    return {
      subject: isMultipleApprovals
        ? "Documents Approved - RideShare"
        : `${formattedLabels} Approved - RideShare`,
      message: `Great news! ${
        isMultipleApprovals
          ? `Your ${approvedLabels.length} documents (${formattedLabels}) have`
          : `Your ${formattedLabels} has`
      } been approved.

We are still reviewing your remaining documents and will keep you updated.

Progress: ${approvedCount}/${TOTAL_VERIFICATION_ITEMS} approved`,
    };
  }

  if (status === "rejected") {
    const isMultipleRejections = reviewedItems.length > 1;
    const rejectionDetails = reviewedItems
      .map((item) => `- ${item.label}: ${item.rejectReason}`)
      .join("\n");
    const rejectionMessage = isMultipleRejections
      ? `The following documents were rejected:

${rejectionDetails}`
      : `Your ${reviewedItems[0].label} was rejected.

Reason: ${reviewedItems[0].rejectReason}`;

    return {
      subject: isMultipleRejections
        ? "Documents Verification Declined - RideShare"
        : `${reviewedItems[0].label} Verification Declined - RideShare`,
      message: `${rejectionMessage}

Please review and resubmit ${isMultipleRejections ? "them" : "it"} in the RideShare web portal.

Link: ${frontendUrl}`,
    };
  }

  return null;
};

module.exports = { buildDriverVerificationEmail };
