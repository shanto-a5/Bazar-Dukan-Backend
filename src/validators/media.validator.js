import { validationError, isPlainObject } from "./product.validator.js";

/**
 * Request validation for the seller media surface.
 *
 * `DELETE /seller/media` carries a single field, `url`, and identity is never
 * in the body: the seller comes from `req.sellerProfile`, resolved by
 * `requireSeller`. So an injected `userId`/`sellerId` is not read and not
 * ignored — it is refused with the same all-fields 422 the catalog validator
 * uses, because a key the request may not set must fail loudly.
 *
 * Whether the URL is a Cloudinary URL at all, and whether it sits inside the
 * caller's namespace, belongs to `services/media.service.js`: those rules need
 * the storage layout, this one only needs the payload.
 */

/** `DELETE /seller/media` — the body may carry `url` and nothing else. */
const validateDeleteMediaInput = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    for (const key of Object.keys(body)) {
        if (key === "url") continue;
        fields.push({ field: key, message: `${key} cannot be set from a request.` });
    }

    const url = body.url;
    if (typeof url !== "string" || url.trim() === "") {
        fields.push({ field: "url", message: "Provide the media URL to delete." });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return url.trim();
};

export { validateDeleteMediaInput };
