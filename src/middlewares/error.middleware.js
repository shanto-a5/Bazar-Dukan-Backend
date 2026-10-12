import { ApiError } from "../utils/ApiError.js";

/**
 * JSON 404 + error handling, in the Vanta response envelope.
 *
 * Before this existed an `ApiError` thrown by a controller reached Express's
 * default handler and went out as an HTML page with a full stack trace and
 * absolute local paths — unusable by the client (which expects
 * `{ ok: false, error: { code, message, fields? }, meta }`) and an information
 * leak. Both handlers below always answer with JSON in that envelope.
 */

/** Status codes the client knows by name. Anything else falls back below. */
const STATUS_CODE_NAMES = {
    400: "validation_failed",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    413: "validation_failed",
    422: "validation_failed",
    429: "rate_limited",
    500: "internal_error"
};

const codeFromStatus = (statusCode) => {
    if (STATUS_CODE_NAMES[statusCode]) return STATUS_CODE_NAMES[statusCode];
    return statusCode >= 500 ? "internal_error" : "validation_failed";
};

/** Only `{ field, message }` entries survive into `error.fields`. */
const toFields = (errors) => {
    if (!Array.isArray(errors)) return [];
    return errors
        .filter((entry) => entry && typeof entry === "object" && typeof entry.field === "string")
        .map((entry) => ({ field: entry.field, message: String(entry.message ?? "") }));
};

/**
 * Body-parser failures arrive as their own `type`. They are answered with a
 * message we wrote, not the parser's, so a client never sees a stack fragment
 * or a library's wording — and the status/code pair stays one the client knows.
 */
const BODY_ERRORS = {
    "entity.parse.failed": { statusCode: 400, code: "validation_failed", message: "Request body is not valid JSON." },
    "entity.too.large": { statusCode: 413, code: "validation_failed", message: "Request body is too large." },
    "encoding.unsupported": { statusCode: 415, code: "validation_failed", message: "Unsupported request encoding." }
};

const notFoundHandler = (req, res) => {
    // The echoed path helps a developer identify the miss, but nothing benefits
    // from a giant one — keep it bounded so headers stay small (FIXES 11).
    const path = req.originalUrl.slice(0, 200);
    res.status(404).json({
        ok: false,
        error: {
            code: "not_found",
            message: `Cannot ${req.method} ${path}`
        },
        meta: { requestId: res.locals.requestId }
    });
};

// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
const errorHandler = (error, req, res, next) => {
    if (res.headersSent) {
        return next(error);
    }

    const bodyError = BODY_ERRORS[error?.type];

    const statusCode = bodyError
        ? bodyError.statusCode
        : typeof error?.statusCode === "number" && error.statusCode >= 400
          ? error.statusCode
          : typeof error?.status === "number" && error.status >= 400
            ? error.status
            : 500;

    // ApiError messages are written to be shown to a person; anything else is an
    // unexpected failure and must not leak its message to a client — at any
    // status, not just 5xx: a stray 4xx-error library threw a message that still
    // names internals, and the envelope is all a client should ever read. The
    // stack is always logged here and never put in the payload (FIXES 11).
    const isKnown = error instanceof ApiError || Boolean(bodyError);
    const message = bodyError
        ? bodyError.message
        : isKnown
          ? error.message
          : "Something went wrong on our side.";
    const code = bodyError
        ? bodyError.code
        : typeof error?.code === "string" && error.code !== ""
          ? error.code
          : codeFromStatus(statusCode);
    const fields = toFields(error?.errors);

    console.error(
        `[error] ${req.requestId ?? "-"} ${req.method} ${req.originalUrl} -> ${statusCode} ${code}: ${message}`,
        error?.stack ? error.stack : ""
    );

    const payload = {
        ok: false,
        error: {
            code,
            message
        },
        meta: { requestId: res.locals.requestId }
    };
    if (fields.length > 0) payload.error.fields = fields;

    res.status(statusCode).json(payload);
};

export { notFoundHandler, errorHandler };
