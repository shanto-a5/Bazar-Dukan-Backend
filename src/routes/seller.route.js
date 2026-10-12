import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller, requireApprover } from "../middlewares/authz.middleware.js";
import {
    registerSeller,
    getApplication,
    getSellerProfile,
    listApprovals,
    approveSeller,
    rejectSeller,
    getApprovalHistory,
    getStore,
    patchStore,
    toggleStoreStatus,
    getDashboard
} from "../controllers/seller.controller.js";

/**
 * Vanta seller routes. The paths are the FULL ones — `/seller/register`,
 * `/approvals/sellers/...` — so the router mounts straight onto the API prefix
 * (`app.use("/api/v1", sellerRouter)`) without a hidden segment.
 *
 * Three tiers, each guarded before any handler runs:
 *   authenticate        — every route; identity is `req.user`, never the body.
 *   requireApprover     — the `/approvals/*` queue, which decides who may sell.
 *   requireSeller       — the seller's own store; it resolves the profile from
 *                         the session and 403s a pending applicant with the
 *                         simulator's own wording.
 *
 * `/seller/register`, `/seller/application` and `/seller/profile` are the
 * applicant's own routes: they must work *without* the seller role, because
 * the person applying does not have it yet.
 */
const router = Router();

// onboarding — one application per account, decided later by an approver
router.route("/seller/register").post(authenticate, registerSeller);
router.route("/seller/application").get(authenticate, getApplication);
router.route("/seller/profile").get(authenticate, getSellerProfile);

// approver queue — `seller_approver` decides, the id is the application id
router.route("/approvals/sellers").get(authenticate, requireApprover, listApprovals);
router.route("/approvals/sellers/:id/approve").post(authenticate, requireApprover, approveSeller);
router.route("/approvals/sellers/:id/reject").post(authenticate, requireApprover, rejectSeller);
router.route("/approvals/sellers/:id/history").get(authenticate, requireApprover, getApprovalHistory);

// the seller's own store — active sellers only, ownership from the session
router.route("/seller/dashboard").get(authenticate, requireSeller, getDashboard);
router.route("/seller/store").get(authenticate, requireSeller, getStore);
router.route("/seller/store").patch(authenticate, requireSeller, patchStore);
router.route("/seller/store/status").post(authenticate, requireSeller, toggleStoreStatus);

export default router;
