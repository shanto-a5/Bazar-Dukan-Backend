import { ApiError } from "../utils/ApiError.js";

/**
 * Sliding-window rate limiter for endpoints that burn credentials or send
 * mail (login, registration, password reset).
 *
 * FIXES 6 — before this existed those routes had no protection: a caller
 * could hammer the login and password-reset endpoints without ever seeing a
 * 429. Each bucket is a process-local Map of `ip:${bucket}` -> one window, so
 * the limiter is transparent to tests (every `node --test` file runs in its
 * own process) yet real traffic is capped per address.
 *
 * Buckets live in memory on purpose. A distributed store would be stronger,
 * but it is out of scope here and the counter still raises the bar against
 * credential stuffing and reset spam on a single instance.
 *
 * Usage:
 *   import { createRateLimit } from "../middlewares/rateLimit.middleware.js";
 *   router.post("/login", createRateLimit({ bucket: "auth-login", windowMs: 15 * 60 * 1000, max: 100 }), loginUser);
 */

const sweepOldest = () => {
    const oldestAllowed = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, entry] of buckets) {
        if (entry.windowStartedAt + entry.windowMs < oldestAllowed) buckets.delete(key);
    }
};

/** Process-local counters: `ip:${bucket}` -> `{ count, windowStartedAt, windowMs }`. */
const buckets = new Map();

const IP_SOURCES = ["x-forwarded-for", "x-real-ip"];

const ipOf = (req) => {
    for (const header of IP_SOURCES) {
        const value = req.headers?.[header];
        if (typeof value === "string" && value.length > 0) return value.split(",")[0].trim();
    }
    return (req.ip ?? req.socket?.remoteAddress ?? "unknown").replace("::ffff:", "");
};

/**
 * @param {object} options
 * @param {string} options.bucket - Named counter so different endpoints never
 *   share a window unless they explicitly use the same bucket name.
 * @param {number} options.windowMs - Length of the window, in milliseconds.
 * @param {number} options.max - Maximum requests per window per IP.
 * @param {string} [options.message] - Message a human sees on the 429.
 * @returns {import("express").RequestHandler}
 */
const createRateLimit = ({ bucket, windowMs, max, message }) => {
    if (!bucket) throw new Error("createRateLimit: a named bucket is required");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("createRateLimit: a positive windowMs is required");
    if (!Number.isInteger(max) || max <= 0) throw new Error("createRateLimit: a positive integer max is required");

    return (req, res, next) => {
        const key = `${ipOf(req)}:${bucket}`;
        const now = Date.now();
        const entry = buckets.get(key);

        if (!entry || now - entry.windowStartedAt >= entry.windowMs) {
            buckets.set(key, { count: 1, windowStartedAt: now, windowMs });
            return next();
        }

        entry.count += 1;
        if (entry.count > max) {
            return next(
                new ApiError(
                    429,
                    message ?? "Too many requests. Please try again later.",
                    [],
                    "",
                    "rate_limited"
                )
            );
        }
        return next();
    };
};

// keep the map from growing forever on abusive or rotating addresses
setInterval(sweepOldest, 60 * 60 * 1000).unref();

export { createRateLimit };