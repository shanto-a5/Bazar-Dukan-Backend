import { ApiError } from "../utils/ApiError.js";

/**
 * Request validation for the cart surface.
 *
 * Same contract as `validators/auth.validator.js`: every validator normalises
 * the payload and throws a single `422 / validation_failed` carrying *every*
 * offending field at once, so a client never pays a round trip per mistake.
 * Nothing here touches the database — product existence and availability are
 * the service's job.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const SERVER_ONLY_FIELDS = ["id", "_id", "createdAt", "updatedAt", "__v"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const rejectServerOnlyFields = (body, fields) => {
    for (const key of Object.keys(body)) {
        if (SERVER_ONLY_FIELDS.includes(key)) {
            fields.push({ field: key, message: `${key} cannot be set from a request.` });
        }
    }
};

/** Express route params (item ids) and body ids are 24-char hex ObjectIds. */
const isObjectId = (value) => typeof value === "string" && /^[0-9a-f]{24}$/i.test(value.trim());

const normalizeOptionalString = (value, trim = true) =>
    typeof value === "string" && (trim ? value.trim() : value) !== "" ? value.trim() : null;

const validateAddItem = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectServerOnlyFields(body, fields);

    const productId = normalizeOptionalString(body.productId);
    const variantId = typeof body.variantId === "string" ? body.variantId.trim() : null;
    const quantity = body.quantity === undefined ? 1 : body.quantity;

    if (!isObjectId(productId)) fields.push({ field: "productId", message: "Select a product to add." });
    if (variantId !== null && !isObjectId(variantId)) {
        fields.push({ field: "variantId", message: "That variant is not valid." });
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
        fields.push({ field: "quantity", message: "Quantity must be a whole number of at least 1." });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { productId, variantId, quantity };
};

const validateUpdateItem = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectServerOnlyFields(body, fields);

    const patch = {};
    if (body.quantity !== undefined) {
        if (!Number.isInteger(body.quantity) || body.quantity < 1) {
            fields.push({ field: "quantity", message: "Quantity must be a whole number of at least 1." });
        } else {
            patch.quantity = body.quantity;
        }
    }
    if (body.selected !== undefined) {
        if (typeof body.selected !== "boolean") {
            fields.push({ field: "selected", message: "selected must be true or false." });
        } else {
            patch.selected = body.selected;
        }
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    if (Object.keys(patch).length === 0) {
        throw validationError("Provide a quantity or a select state to update.", []);
    }

    return patch;
};

const validateSelect = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);
    rejectServerOnlyFields(body, []);

    if (typeof body.selected !== "boolean") {
        throw validationError("Please fix the highlighted fields.", [
            { field: "selected", message: "selected must be true or false." }
        ]);
    }
    if (body.sellerId !== undefined && typeof body.sellerId !== "string") {
        throw validationError("Please fix the highlighted fields.", [
            { field: "sellerId", message: "sellerId must name a seller." }
        ]);
    }

    const sellerId = typeof body.sellerId === "string" && body.sellerId.trim() !== "" ? body.sellerId.trim() : null;
    return { selected: body.selected, sellerId };
};

export { validationError, validateAddItem, validateUpdateItem, validateSelect };