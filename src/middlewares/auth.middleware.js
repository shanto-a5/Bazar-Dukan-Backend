import { ApiError } from "../utils/ApiError.js";
import { asyncHandlers } from "../utils/asyncHandlers.js";
import { authenticateToken } from "../services/auth.service.js";
import { AUTH_COOKIE_NAME } from "../constance.js";

/**
 * Session authentication for the two transports Vanta accepts.
 *
 * Order matters and is deliberate:
 *
 *   1. `Authorization: Bearer <token>` — when the header is present it is the
 *      credential, full stop. If it does not parse or does not resolve to a
 *      live session the request is rejected; the cookie is never consulted, so
 *      a broken bearer token cannot fall through to a second identity. Without
 *      that rule a caller who *meant* to be one user could silently be served
 *      as another.
 *   2. The `accessToken` cookie — only when no Authorization header was sent
 *      at all. This is the imported backend's `req.cookies?.… || header` shape
 *      with the precedence reversed for exactly the reason above; the cookie
 *      parsing itself is still `cookie-parser` reading `req.cookies`.
 *
 * Either way the value is one opaque session token resolved server-side by
 * `authenticateToken`: no payload is decoded, nothing is logged, and a
 * revoked or expired session stops working on the very next request.
 *
 * On success the request carries:
 *   req.user       — the public projection only (never a hash, never a salt)
 *   req.sessionId  — the session row, so logout can delete exactly this device
 */
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

const authenticate = asyncHandlers(async (req, res, next) => {
    const header = req.header("authorization");

    let token;
    if (header !== undefined) {
        const match = BEARER_PATTERN.exec(header.trim());
        if (!match) {
            throw new ApiError(401, "Your session is no longer valid. Sign in again.", [], "", "unauthorized");
        }
        token = match[1];
    } else {
        const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
        // Only a plain string may reach the session lookup; anything else a
        // client smuggled into the cookie header is simply not a credential.
        token = typeof cookieToken === "string" ? cookieToken : "";
        if (!token) throw new ApiError(401, "Sign in to continue.", [], "", "unauthorized");
    }

    const { user, sessionId } = await authenticateToken(token);

    req.user = user;
    req.sessionId = sessionId;

    next();
});

export { authenticate };
