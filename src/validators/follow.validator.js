import { ApiError } from "../utils/ApiError.js";

/**
 * Store-follow request validation.
 *
 * The four follow endpoints take NO writable body: the store id lives in the
 * path and the user id is `req.user.id`. Every key a client sends — including
 * the client-owned `userId`, `storeId` and `followerCount` — is therefore a
 * 422 field error naming it, so `followerCount` can only ever be moved by the
 * service's atomic counters and identity can never be spoofed. An absent body
 * is fine (an empty POST/DELETE payload is the normal call).
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const validateFollowBody = (body) => {
    if (body === undefined || body === null) return {};

    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    for (const key of Object.keys(body)) {
        fields.push({ field: key, message: `${key} cannot be set from a request.` });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return {};
};

export { validateFollowBody };
