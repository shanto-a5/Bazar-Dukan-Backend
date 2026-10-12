import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
    recordViewEntry,
    listRecentlyViewed,
    removeRecentlyViewedProduct
} from "../controllers/recently-viewed.controller.js";

/**
 * Vanta recently-viewed routes, mounted at `/api/v1`.
 *
 * Paths are the FULL client paths the screens call. Everything is
 * authenticated — recently-viewed always belongs to `req.user.id`, which the
 * `authenticate` middleware guarantees. There is deliberately no
 * clear-all endpoint: the simulator only ever records, lists and removes a
 * single product.
 */
const router = Router();

// record one product view (POST is the only place viewCount moves)
router.route("/recently-viewed").post(authenticate, recordViewEntry);

// the caller's list, newest-first, default limit 12 / max 100
router.route("/recently-viewed").get(authenticate, listRecentlyViewed);

// remove one product from the caller's history (200 { removed } either way)
router.route("/recently-viewed/products/:productId").delete(authenticate, removeRecentlyViewedProduct);

export default router;
