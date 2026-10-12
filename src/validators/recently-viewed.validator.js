import { ApiError } from "../utils/ApiError.js";

/**
 * Recently-viewed request validation.
 *
 * Same contract as `validators/cart.validator.js` / `validators/wishlist.validator.js`:
 * one 422 carrying every offending field at once. A POST body may carry ONLY
 * `productId` — a client-supplied `userId` (or any other key) is a field
 * error naming it, so identity can only ever be `req.user.id`. `productId`
 * must be a 24-char hex ObjectId; product existence is the service's job
 * (422 "Product not found."). The `limit` query is an integer 1..100,
 * defaulting to 12 — the simulator's `recentlyViewed(userId, limit = 12)` —
 * and a bad value is a `limit` field error rather than a silent clamp.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const ALLOWED_KEYS = ["productId"];
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const isObjectId = (value) => typeof value === "string" && /^[0-9a-f]{24}$/i.test(value.trim());

const validateRecordView = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    for (const key of Object.keys(body)) {
        if (!ALLOWED_KEYS.includes(key)) {
            fields.push({ field: key, message: `${key} cannot be set from a request.` });
        }
    }

    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    if (!isObjectId(productId)) fields.push({ field: "productId", message: "Select a product to record." });

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { productId };
};

/** GET /recently-viewed?limit= — default 12, 1..100, one `limit` field error otherwise. */
const validateListQuery = (query) => {
    const raw = query?.limit;
    if (raw === undefined || raw === "") return { limit: DEFAULT_LIMIT };

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        throw validationError("Please fix the highlighted fields.", [
            { field: "limit", message: `Enter a limit between 1 and ${MAX_LIMIT}.` }
        ]);
    }
    return { limit: parsed };
};

/** DELETE /recently-viewed/products/:productId — the path productId must be a real ObjectId. */
const validateProductIdParam = (value) => {
    if (!isObjectId(value)) {
        throw validationError("That product is not valid.", [
            { field: "productId", message: "That product is not valid." }
        ]);
    }
    return value.trim();
};

export { DEFAULT_LIMIT, MAX_LIMIT, validateRecordView, validateListQuery, validateProductIdParam };
