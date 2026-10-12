import { ApiError } from "../utils/ApiError.js";
import { SellerProfile } from "../models/seller-profile.model.js";

/**
 * Authorization for role-gated and seller-gated routes.
 *
 * Every guard runs after `authenticate`, so `req.user` is the public projection
 * of the session's user and can never be crafted by a request body. Roles are
 * server-controlled on the User document; the seller business identity is a
 * `SellerProfile` row derived from the authenticated user id, never from the
 * request — a client cannot name a sellerId it does not own.
 *
 * All failures throw `ApiError` so the shared error middleware formats them:
 * 401 when there is no authenticated actor (a guard running without
 * `authenticate` is a wiring bug and must not 500), 403 for every
 * authorization failure.
 */

const forbidden = (message) => new ApiError(403, message, [], "", "forbidden");
const unauthorized = (message) => new ApiError(401, message, [], "", "unauthorized");

/**
 * Allows only users whose roles intersect the given roles.
 */
const requireRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) {
            throw unauthorized("Sign in to continue.");
        }
        const allowed = roles.some((role) => (req.user.roles ?? []).includes(role));
        if (!allowed) {
            throw forbidden("You do not have permission to perform this action.");
        }
        next();
    };
};

const requireSellerRole = requireRole("seller");

/**
 * Attaches `req.sellerProfile` / `req.sellerId` when the authenticated user is
 * a seller. Never throws and never blocks: read-only convenience for routes
 * that act only when a profile exists.
 */
const loadSellerProfile = async (req, res, next) => {
    if (req.user?.id) {
        const profile = await SellerProfile.findOne({ userId: req.user.id });
        if (profile) {
            req.sellerProfile = profile;
            req.sellerId = String(profile._id);
        }
    }
    next();
};

/**
 * Resolves the authenticated user to an active seller profile and attaches it
 * to the request. Failing to find a profile, or finding a non-active one, is a
 * 403 with a status-specific message so a pending applicant is told their
 * application is under review and a rejected/suspended seller is told the
 * account is not active.
 */
const requireSeller = async (req, res, next) => {
    if (!req.user) {
        throw unauthorized("Sign in to continue.");
    }

    const profile = await SellerProfile.findOne({ userId: req.user.id });
    if (!profile) {
        throw forbidden("You do not have a seller account.");
    }

    if (profile.status === "pending") {
        throw forbidden("Your seller application is still under review.");
    }
    if (profile.status !== "active") {
        throw forbidden("Your seller account is not active.");
    }

    req.sellerProfile = profile;
    req.sellerId = String(profile._id);

    next();
};

const requireApprover = requireRole("seller_approver");

export {
    requireRole,
    requireSellerRole,
    loadSellerProfile,
    requireSeller,
    requireApprover
};