/**
 * Voucher request validation.
 *
 * Two layers, both failing with a single `422 / validation_failed` that carries
 * EVERY offending field at once (the error middleware forwards them as
 * `error.fields`):
 *
 *   1. shape — the body must be an object and may not name server-owned state.
 *      `scope`/`sellerId` are forced from the session on create (a client that
 *      sends them is told so loudly rather than silently ignored), and
 *      `code`/`type` are immutable on update;
 *   2. rules — `validateDraft` from the voucher service, which holds the
 *      simulator's wording for every field rule.
 *
 * Update merges the patch onto the stored voucher first, so the draft is
 * always validated as a WHOLE document: relaxing `minimumOrder` can surface a
 * cap problem in `maximumDiscount` that the client never sent, and reporting it
 * is the point.
 */
import { ApiError } from "../utils/ApiError.js";
import { validateDraft } from "../services/voucher.service.js";

const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Fields no client may ever write on either endpoint. */
const SERVER_ONLY_FIELDS = ["scope", "sellerId", "usageCount", "perUserUsed", "id", "_id", "createdAt", "updatedAt", "__v"];

/** Extra fields that exist but are frozen after creation. */
const IMMUTABLE_ON_UPDATE = ["code", "type"];

const FIELD_MESSAGES = {
    scope: "scope is set by the server.",
    sellerId: "sellerId is set by the server.",
    code: "code cannot be changed.",
    type: "type cannot be changed."
};

const rejectFields = (body, allowed) => {
    const fields = [];
    for (const key of Object.keys(body)) {
        const serverOnly = SERVER_ONLY_FIELDS.includes(key);
        const immutable = allowed === "update" && IMMUTABLE_ON_UPDATE.includes(key);
        if (!serverOnly && !immutable) continue;
        fields.push({ field: key, message: FIELD_MESSAGES[key] ?? `${key} cannot be set from a request.` });
    }
    return fields;
};

/** POST /seller/vouchers — the draft, with scope/sellerId supplied by us. */
async function validateVoucherCreate(body, { sellerId }) {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = rejectFields(body, "create");
    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return validateDraft(body, { sellerId });
}

/**
 * PATCH /seller/vouchers/:id — only the writable columns are read from the
 * body; everything else keeps its stored value and the merged draft is
 * re-validated in full.
 */
async function validateVoucherUpdate(body, { sellerId, voucherId, existing }) {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = rejectFields(body, "update");
    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    const UPDATABLE = [
        "title",
        "discountValue",
        "minimumOrder",
        "maximumDiscount",
        "startAt",
        "expiry",
        "usageLimit",
        "perUserLimit",
        "categoryId",
        "productIds",
        "description",
        "active"
    ];

    const patch = {};
    for (const key of UPDATABLE) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
    }

    const draft = {
        code: existing.code,
        title: existing.title,
        type: existing.type,
        discountValue: existing.discountValue,
        minimumOrder: existing.minimumOrder,
        maximumDiscount: existing.maximumDiscount ?? undefined,
        startAt: existing.startAt,
        expiry: existing.expiry,
        usageLimit: existing.usageLimit ?? undefined,
        perUserLimit: existing.perUserLimit ?? undefined,
        categoryId: existing.categoryId ? String(existing.categoryId) : undefined,
        productIds: Array.isArray(existing.productIds) ? existing.productIds.map(String) : [],
        active: existing.active,
        description: existing.description ?? "",
        ...patch
    };

    return validateDraft(draft, { sellerId, voucherId });
}

export { validateVoucherCreate, validateVoucherUpdate };
