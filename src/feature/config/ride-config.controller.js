const { getAppRideConfiguration } = require("./ride-configuration.service");

/**
 * The dispatch settings and copy the apps render.
 *
 * Deliberately open, like the rest of `/config`: an app needs the search screen
 * to read correctly before anyone signs in, and nothing here is private — it is
 * the same ladder and the same sentences every rider already sees.
 */
const getAppRideConfigurationController = async (req) => {
  const locale =
    req.query.locale || req.headers["accept-language"] || req.user?.locale;

  const data = await getAppRideConfiguration(
    typeof locale === "string" ? locale.slice(0, 2).toLowerCase() : "en",
  );

  return { data };
};

module.exports = {
  getAppRideConfigurationController,
};
