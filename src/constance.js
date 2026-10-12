export const DB_Name = "UP";

/**
 * Authentication contract constants. The validators, the auth service and the
 * middleware all read them from here so "how short is too short" or "what does
 * a token look like" cannot drift between layers. Email shape comes from the
 * existing `utils/helper/email.validator.js`, which stays the single rule.
 */
export const PHONE_PATTERN = /^[0-9+\-\s]{6,20}$/;
export const MIN_PASSWORD_LENGTH = 8;
/** An issued token is 32 random bytes as hex; anything else never hits the DB. */
export const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

const intFromEnv = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be zero or a positive integer.`);
    }
    return parsed;
};

/**
 * Read on every use rather than at import time, so a deployment (or a test) can
 * set them before the first call and so a bad value fails the request that used
 * it instead of killing the process at boot.
 */
export const bcryptRounds = () => intFromEnv("BCRYPT_ROUNDS", 12);
export const sessionTtlMs = () => intFromEnv("SESSION_TTL_DAYS", 30) * 86_400_000;
/** 0 is documented as "no cap" rather than as a mistake. */
export const sessionMaxPerUser = () => intFromEnv("SESSION_MAX_PER_USER", 10);
export const passwordResetTtlMs = () => intFromEnv("PASSWORD_RESET_TTL_MINUTES", 30) * 60_000;
export const publicAppUrl = () => process.env.PUBLIC_APP_URL || "http://127.0.0.1:8099/reset-password";

/**
 * Mail transport configuration.
 *
 * `mailProvider()` picks the provider the mailer dispatches to; the Resend
 * values are read here so no provider — and above all no auth service — ever
 * touches `process.env` for a secret. `RESEND_API_KEY` is read, never printed:
 * it exists in `.env` (git-ignored) and nowhere else.
 *
 * The sender is configuration, not code: Resend only delivers from an address
 * the account has verified, so a deployment sets `MAIL_FROM` to its own domain
 * and the example sender below is only the out-of-the-box value.
 */
export const mailProvider = () => process.env.MAIL_PROVIDER || "console";
export const resendApiKey = () => (process.env.RESEND_API_KEY ?? "").trim();
export const mailFrom = () => process.env.MAIL_FROM?.trim() || "onboarding@resend.dev";

/**
 * The authentication cookie, kept from the backend this project was imported
 * from: login issued an `accessToken` cookie, logout cleared it, and the auth
 * middleware read `req.cookies` before falling back to the Authorization
 * header. The name and the `httpOnly` intent are unchanged; the options are
 * adapted for Vanta:
 *
 * - `secure` is decided by the environment instead of being hard-coded, so
 *   development stays testable over local HTTP while production still ships
 *   `Secure` cookies.
 * - `sameSite` and `path` are stated rather than left to the runtime defaults.
 * - `maxAge` is set at issue time from the same session TTL the datastore
 *   uses, so the cookie and its session row expire together.
 *
 * The imported project also issued a `refreshToken` cookie because it carried
 * a second JWT that its refresh route rotated. Vanta has exactly one
 * credential — the opaque session token, revocable server-side — and no
 * refresh route in the contract, so there is nothing for a second cookie to
 * carry but a duplicate of the same secret. One cookie is issued instead.
 */
export const AUTH_COOKIE_NAME = "accessToken";

export const authCookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
});
