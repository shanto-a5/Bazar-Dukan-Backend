import { ApiError } from "../utils/ApiError.js";

/**
 * Address book request validation.
 *
 * The shape guard lives here (object-ness, unknown/immutable keys, `isDefault`
 * and `instructions` types) while the domain rules themselves — the exact
 * message strings from `address-service.ts` `validate()` — live in the address
 * service, mirrored verbatim. Every mistake in one request still comes back as
 * ONE 422 with all offending fields.
 *
 * Only AddressInput fields may be written: `label`, `recipientName`, `phone`,
 * `division`, `district`, `area`, `addressLine`, `postalCode`, `instructions`,
 * `isDefault`. A `userId`, `id` or `createdAt` in a body is a field error
 * naming it — identity only ever comes from `req.user.id`.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const ADDRESS_FIELDS = [
    "label",
    "recipientName",
    "phone",
    "division",
    "district",
    "area",
    "addressLine",
    "postalCode",
    "instructions",
    "isDefault"
];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const trimish = (value) => (typeof value === "string" ? value.trim() : "");

const rejectUnknownFields = (body, fields) => {
    for (const key of Object.keys(body)) {
        if (!ADDRESS_FIELDS.includes(key)) {
            fields.push({ field: key, message: `${key} cannot be set from a request.` });
        }
    }
};

const checkIsDefault = (body, fields) => {
    if (body.isDefault === undefined) return undefined;
    if (typeof body.isDefault !== "boolean") {
        fields.push({ field: "isDefault", message: "isDefault must be true or false." });
        return undefined;
    }
    return body.isDefault;
};

const checkInstructions = (body, fields) => {
    if (body.instructions === undefined) return undefined;
    if (typeof body.instructions !== "string") {
        fields.push({ field: "instructions", message: "Instructions must be text." });
        return undefined;
    }
    return body.instructions;
};

/** POST /addresses — full AddressInput; unknown keys and bad types are one 422. */
const validateCreateAddress = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectUnknownFields(body, fields);
    const isDefault = checkIsDefault(body, fields);
    const instructions = checkInstructions(body, fields);

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return {
        label: trimish(body.label),
        recipientName: trimish(body.recipientName),
        phone: trimish(body.phone),
        division: trimish(body.division),
        district: trimish(body.district),
        area: trimish(body.area),
        addressLine: trimish(body.addressLine),
        postalCode: trimish(body.postalCode),
        instructions: instructions === undefined ? null : instructions,
        isDefault
    };
};

/**
 * PATCH /addresses/:id — only the keys actually present are merged; the rest
 * keep their stored values. An empty patch is a valid no-op like the simulator.
 */
const validatePatchAddress = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectUnknownFields(body, fields);
    const isDefault = checkIsDefault(body, fields);
    const instructions = checkInstructions(body, fields);

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    const patch = {};
    for (const key of ADDRESS_FIELDS) {
        if (body[key] === undefined) continue;
        if (key === "isDefault") patch.isDefault = isDefault;
        else if (key === "instructions") patch.instructions = instructions;
        else patch[key] = trimish(body[key]);
    }
    return patch;
};

export { validateCreateAddress, validatePatchAddress };