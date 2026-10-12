import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller } from "../middlewares/authz.middleware.js";
import {
    create,
    listForOrder,
    listMine,
    sellerList,
    sellerDetail,
    approve,
    reject,
    markReturned
} from "../controllers/return.controller.js";

/**
 * Vanta returns + refunds routes. The paths are FULL client paths so the
 * router mounts straight onto the API prefix
 * (`app.use("/api/v1", returnRouter)`).
 *
 * Every route is authenticated: the customer surface acts on `req.user.id`
 * and the seller surface on `req.sellerProfile._id` (resolved by
 * `requireSeller`), so a foreign order or return id is a 404, never somebody
 * else's data.
 *
 * State transitions are DISCRETE endpoints — approve / reject / returned —
 * mirroring the simulator's `decideReturn`/`markReturned` pair instead of one
 * PATCH that would have to guess which transition was meant.
 */
const router = Router();

// customer surface
router.route("/returns").get(authenticate, listMine);
router.route("/orders/:id/returns").get(authenticate, listForOrder).post(authenticate, create);

// seller surface
router.route("/seller/returns").get(authenticate, requireSeller, sellerList);
router.route("/seller/returns/:id").get(authenticate, requireSeller, sellerDetail);
router.route("/seller/returns/:id/approve").post(authenticate, requireSeller, approve);
router.route("/seller/returns/:id/reject").post(authenticate, requireSeller, reject);
router.route("/seller/returns/:id/returned").post(authenticate, requireSeller, markReturned);

export default router;
