import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
    getWishlist,
    addWishlistItem,
    removeWishlistItem,
    clearWishlist
} from "../controllers/wishlist.controller.js";

/**
 * Vanta wishlist routes, mounted at `/api/v1`.
 *
 * Paths are the FULL client paths the wishlist screen calls. Everything is
 * authenticated — the wishlist always belongs to `req.user.id`, which the
 * `authenticate` middleware guarantees.
 */
const router = Router();

// the wishlist view (pruned, enriched, newest-first)
router.route("/wishlist").get(authenticate, getWishlist);

// add one product (a duplicate is a silent no-op)
router.route("/wishlist/items").post(authenticate, addWishlistItem);

// remove one product (a no-op when it was not on the list)
router.route("/wishlist/items/:productId").delete(authenticate, removeWishlistItem);

// empty the whole list (a no-op when empty)
router.route("/wishlist").delete(authenticate, clearWishlist);

export default router;