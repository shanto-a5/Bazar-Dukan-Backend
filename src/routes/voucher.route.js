import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller } from "../middlewares/authz.middleware.js";
import {
    createVoucher,
    listVouchers,
    getVoucher,
    updateVoucher,
    deleteVoucher,
    eligibleVouchers
} from "../controllers/voucher.controller.js";

/**
 * Vanta voucher routes. The paths are the FULL client paths so the router
 * mounts straight onto the API prefix (`app.use("/api/v1", voucherRouter)`)
 * without a hidden segment.
 *
 * Two tiers:
 *   authenticate       — every route; identity is `req.user`, never the body.
 *   authenticate +     — the seller's own management surface. `requireSeller`
 *   requireSeller        resolves the profile from the session, so `sellerId`
 *                        is always the caller's and a foreign voucher id is a
 *                        404 rather than somebody else's data.
 *
 * `/vouchers/eligible` is a customer read: any signed-in user asks what their
 * own cart qualifies for.
 */
const router = Router();

// customer eligibility — quotes for the caller's cart, best discount first
router.route("/vouchers/eligible").get(authenticate, eligibleVouchers);

// the seller's voucher collection
router
    .route("/seller/vouchers")
    .post(authenticate, requireSeller, createVoucher)
    .get(authenticate, requireSeller, listVouchers);

// one of the seller's vouchers — ownership is re-checked per request
router
    .route("/seller/vouchers/:id")
    .get(authenticate, requireSeller, getVoucher)
    .patch(authenticate, requireSeller, updateVoucher)
    .delete(authenticate, requireSeller, deleteVoucher);

export default router;
