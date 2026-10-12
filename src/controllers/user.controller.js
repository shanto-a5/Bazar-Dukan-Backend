import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import {
    validateRegister,
    validateLogin,
    validateProfilePatch,
    validateChangePassword,
    validateResetRequest,
    validateResetConfirm
} from "../validators/auth.validator.js";
import {
    register,
    login,
    logout,
    logoutAll,
    updateProfile,
    changePassword,
    requestPasswordReset,
    confirmPasswordReset
} from "../services/auth.service.js";
import { AUTH_COOKIE_NAME, authCookieOptions, sessionTtlMs } from "../constance.js";

/**
 * Vanta identity endpoints.
 *
 * The controller only shapes HTTP: validate in, call the service, put the
 * result in the envelope. No business rule, no query and no password handling
 * lives here — that is what makes the same rules reachable from a future
 * seller onboarding flow without being written twice.
 *
 * `req.user` / `req.sessionId` are set by the `authenticate` middleware and are
 * the only identity this file trusts. A body-supplied id is never read.
 *
 * Two transports carry the same session, because two kinds of client consume
 * this API: the Vanta app takes `data.token` from the body and sends it back as
 * `Authorization: Bearer`, while a browser or an HTTP-testing client rides the
 * `accessToken` cookie this controller sets (the imported backend's pattern).
 * Neither replaces the other — both point at the one session row the service
 * created, so revoking it signs both out at once.
 */

// The session credential as a cookie: same value as `data.token`.
const attachSessionCookie = (res, token) =>
    res.cookie(AUTH_COOKIE_NAME, token, { ...authCookieOptions(), maxAge: sessionTtlMs() });

// Matching clear: same name and the same options the cookie was issued with.
const clearSessionCookie = (res) => res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions());

// POST /api/v1/auth/register — registration signs the account in, so it issues
// exactly what login issues: token in the body *and* the cookie.
const registerUser = asyncHandlers(async (req, res) => {
    const input = validateRegister(req.body);
    const result = await register(input);

    return attachSessionCookie(res, result.token)
        .status(201)
        .json(new ApiResponse(201, result, "Your account is ready."));
});

// POST /api/v1/auth/login
const loginUser = asyncHandlers(async (req, res) => {
    const input = validateLogin(req.body);
    const result = await login(input);

    return attachSessionCookie(res, result.token)
        .status(200)
        .json(new ApiResponse(200, result, "Signed in."));
});

// GET /api/v1/auth/me
const getCurrentUser = asyncHandlers(async (req, res) => {
    return res.status(200).json(new ApiResponse(200, { user: req.user }, "Current user."));
});

// PATCH /api/v1/auth/me
const updateCurrentUser = asyncHandlers(async (req, res) => {
    const patch = validateProfilePatch(req.body);
    const user = await updateProfile(req.user.id, patch);

    return res.status(200).json(new ApiResponse(200, { user }, "Profile updated."));
});

// POST /api/v1/auth/me/password
const updateCurrentUserPassword = asyncHandlers(async (req, res) => {
    const { currentPassword, newPassword } = validateChangePassword(req.body);
    const result = await changePassword(req.user.id, currentPassword, newPassword, req.sessionId);

    return res.status(200).json(new ApiResponse(200, result, "Password updated."));
});

// POST /api/v1/auth/logout — this session only
const logoutCurrentUser = asyncHandlers(async (req, res) => {
    const result = await logout(req.sessionId);

    return clearSessionCookie(res).status(200).json(new ApiResponse(200, result, "Signed out."));
});

// POST /api/v1/auth/logout-all — every session of this account
const logoutCurrentUserEverywhere = asyncHandlers(async (req, res) => {
    const result = await logoutAll(req.user.id);

    return clearSessionCookie(res).status(200).json(new ApiResponse(200, result, "Signed out everywhere."));
});

// POST /api/v1/auth/password-reset/request — same answer for any address
const requestPasswordResetEmail = asyncHandlers(async (req, res) => {
    const { email } = validateResetRequest(req.body);
    const result = await requestPasswordReset(email);

    return res.status(200).json(new ApiResponse(200, result, "If that address has an account, a reset link is on its way."));
});

// POST /api/v1/auth/password-reset/confirm
const confirmPasswordResetEmail = asyncHandlers(async (req, res) => {
    const { token, newPassword } = validateResetConfirm(req.body);
    const result = await confirmPasswordReset(token, newPassword);

    return res.status(200).json(new ApiResponse(200, result, "Password reset."));
});

export {
    registerUser,
    loginUser,
    getCurrentUser,
    updateCurrentUser,
    updateCurrentUserPassword,
    logoutCurrentUser,
    logoutCurrentUserEverywhere,
    requestPasswordResetEmail,
    confirmPasswordResetEmail
};
