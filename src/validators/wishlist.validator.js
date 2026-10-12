import { ApiError } from "../utils/ApiError.js";

/**
 * Wishlist request validation.
 *
 * Same contract as `validators/cart.validator.js`: one 422 carrying every
 * offending field at once. A POST body may carry ONLY `productId` — a
 * client-supplied `userId` (or any other key) is a field error naming it, so
 * identity can only ever be `req.user.id`. `productId` must be a 24-char hex
 * ObjectId; product existence and availability are the service's job.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const ALLOWED_KEYS = ["productId"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isObjectId = (value) => typeof value === "string" && /^[0-9a-f]{24}$/i.test(value.trim());

const validateAddWishlistItem = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    for (const key of Object.keys(body)) {
        if (!ALLOWED_KEYS.includes(key)) {
            fields.push({ field: key, message: `${key} cannot be set from a request.` });
        }
    }

    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    if (!isObjectId(productId)) fields.push({ field: "productId", message: "Select a product to add." });

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { productId };
};

/** DELETE /wishlist/items/:productId — the path productId must be a real ObjectId. */
const validateWishlistProductIdParam = (value) => {
    if (!isObjectId(value)) {
        throw validationError("That product is not valid.", [
            { field: "productId", message: "That product is not valid." }
        ]);
    }
    return value.trim();
};

export { validateAddWishlistItem, validateWishlistProductIdParam };