import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
    getCart,
    addItem,
    updateItem,
    deleteItem,
    clearCartItems,
    selectLines
} from "../controllers/cart.controller.js";

/**
 * Vanta cart routes, mounted at `/api/v1`.
 *
 * Paths are the FULL client paths the Expo cart screen calls
 * (`src/api/vanta-api.ts`): `/cart`, `/cart/items`, `/cart/items/:id` and
 * `/cart/select`. Everything is authenticated — the cart always belongs to
 * `req.user.id`, which the `authenticate` middleware guarantees.
 */
const router = Router();

// the cart view, with pricing, groups and audit issues
router.route("/cart").get(authenticate, getCart);

// add/merge a line into the cart
router.route("/cart/items").post(authenticate, addItem);

// empty the whole cart (a no-op when there is no cart yet)
router.route("/cart/items").delete(authenticate, clearCartItems);

// one line: clamp quantity and/or flip selected
router.route("/cart/items/:id").patch(authenticate, updateItem);

// one line: remove it entirely
router.route("/cart/items/:id").delete(authenticate, deleteItem);

// select/deselect all lines, or only one seller's lines
router.route("/cart/select").patch(authenticate, selectLines);

export default router;