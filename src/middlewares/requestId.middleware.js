import { randomUUID } from "crypto";

/**
 * Attaches a request id to every request and echoes it on the response.
 *
 * The client reads `x-request-id` off the response header and puts it on
 * `ApiError.requestId`, which is what makes a support ticket traceable to a
 * server log line. An id supplied by the caller is reused (so a proxy or the
 * client can correlate), otherwise one is generated.
 */
const MAX_ID_LENGTH = 128;

const requestId = (req, res, next) => {
    const incoming = req.header("x-request-id");
    const id =
        typeof incoming === "string" && incoming.trim() !== "" && incoming.length <= MAX_ID_LENGTH
            ? incoming.trim()
            : randomUUID();

    req.requestId = id;
    res.locals.requestId = id;
    res.setHeader("x-request-id", id);

    next();
};

export { requestId };
