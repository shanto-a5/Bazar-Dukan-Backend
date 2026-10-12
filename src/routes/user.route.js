import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { createRateLimit } from "../middlewares/rateLimit.middleware.js";
import {
    registerUser,
    loginUser,
    getCurrentUser,
    updateCurrentUser,
    updateCurrentUserPassword,
    logoutCurrentUser,
    logoutCurrentUserEverywhere,
    requestPasswordResetEmail,
    confirmPasswordResetEmail
} from "../controllers/user.controller.js";

/**
 * Vanta identity routes, mounted at `/api/v1/auth`.
 *
 * The paths are the exact ones the Expo client already calls
 * (`src/api/vanta-api.ts`), so nothing on the device has to change to talk to
 * this server. Everything under `/me` is authenticated; register, login and
 * the two password-reset steps are deliberately not, because the person who
 * needs them has no session yet.
 *
 * The unauthenticated routes are rate-limited (FIXES 6): a known address gets
 * one shared window for login+registration and reset needs their own windows,
 * because every attempt costs an email or a bcrypt compare.
 */
const router = Router();

// registration and sign-in — create a session, return the bearer token
router
    .route("/register")
    .post(createRateLimit({ bucket: "auth-login", windowMs: 15 * 60 * 1000, max: 100 }), registerUser);
router
    .route("/login")
    .post(createRateLimit({ bucket: "auth-login", windowMs: 15 * 60 * 1000, max: 100 }), loginUser);

// the authenticated actor is read from the token, never from the body
router.route("/me").get(authenticate, getCurrentUser);
router.route("/me").patch(authenticate, updateCurrentUser);
router.route("/me/password").post(authenticate, updateCurrentUserPassword);

// session invalidation: this device, or every device
router.route("/logout").post(authenticate, logoutCurrentUser);
router.route("/logout-all").post(authenticate, logoutCurrentUserEverywhere);

// password reset: identical outward answer for known and unknown addresses
router
    .route("/password-reset/request")
    .post(createRateLimit({ bucket: "auth-reset", windowMs: 15 * 60 * 1000, max: 25 }), requestPasswordResetEmail);
router
    .route("/password-reset/confirm")
    .post(createRateLimit({ bucket: "auth-reset-confirm", windowMs: 15 * 60 * 1000, max: 50 }), confirmPasswordResetEmail);

export default router;
