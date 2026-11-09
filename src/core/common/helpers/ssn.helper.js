/* Only the last four digits of an SSN ever leave the API */
const maskSsn = (ssn) => {
  if (!ssn) return null;

  const digits = String(ssn).replace(/\D/g, "");
  if (digits.length < 4) return null;

  return `***-**-${digits.slice(-4)}`;
};

module.exports = { maskSsn };
