import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller } from "../middlewares/authz.middleware.js";
import {
    preview,
    create,
    list,
    detail,
    cancel,
    sellerList,
    sellerDetail,
    advance
} from "../controllers/order.controller.js";

/**
 * Vanta checkout + order routes. The paths are FULL client paths so the router
 * mounts straight onto the API prefix (`app.use("/api/v1", orderRouter)`).
 *
 * Every route is authenticated: the customer surface acts on `req.user.id` and
 * the seller surface on `req.sellerProfile._id` (resolved by `requireSeller`),
 * so a foreign order or seller-order id is a 404, never somebody else's data.
 */
const router = Router();

// checkout pre-flight — prices and eligibility for the caller's own cart
router.route("/checkout/preview").post(authenticate, preview);

// customer order surface
router.route("/orders").post(authenticate, create).get(authenticate, list);
router.route("/orders/:id").get(authenticate, detail);
router.route("/orders/:id/cancel").post(authenticate, cancel);

// seller fulfilment surface
router.route("/seller/orders").get(authenticate, requireSeller, sellerList);
router.route("/seller/orders/:id").get(authenticate, requireSeller, sellerDetail);
router.route("/seller/orders/:id/advance").post(authenticate, requireSeller, advance);

export default router;