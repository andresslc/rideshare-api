const Joi = require("joi");
const objectIdPattern = /^[0-9a-fA-F]{24}$/;

exports.UpdateSettingValidator = Joi.object({
    notification: Joi.boolean().optional().messages({
        "any.optional": "Value is optional"
    })
});