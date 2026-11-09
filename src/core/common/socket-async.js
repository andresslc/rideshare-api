const DriverModel = require("../../feature/driver/models/driver.model");
const UserModel = require("../../feature/user/models/user.model");
const { t } = require("./helpers");

module.exports = function asyncSocketWrapper(socket, handler) {
  const respond = (callback, data) =>
    typeof callback === "function"
      ? callback(data)
      : socket.emit("error", data);

  const getLocale = async () => {
    console.log("🚀 ~ getLocale ~ socket.user?._id:", socket.user?._id)
    if (!socket.user?._id) return "en";
    try {
      const Model =
        socket.user.role?.toLowerCase() === "driver" ? DriverModel : UserModel;
      console.log("🚀 ~ getLocale ~ Model:", Model)
      const user = await Model.findById(socket.user._id).select("locale");
      console.log("🚀 ~ getLocale ~ user:", user)
      return user?.locale || "en";
    } catch {
      return "en";
    }
  };

  return async (payload, callback) => {
    try {
      await handler(payload, callback);
    } catch (err) {
    console.error("Socket Error:", err);
      const locale = await getLocale();
      console.log("🚀 ~ asyncSocketWrapper ~ locale:", locale)
      console.log("🚀 ~ asyncSocketWrapper ~ err.message:", err.message)
      const message = t(err.message, locale) || "Something went wrong";
      respond(callback, { success: false, message });
    }
  };
};
