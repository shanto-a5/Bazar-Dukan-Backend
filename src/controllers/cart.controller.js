import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateAddItem, validateUpdateItem, validateSelect } from "../validators/cart.validator.js";
import {
    getCartView,
    addItemToCart,
    updateCartItem,
    removeCartItem,
    clearCart,
    setSelection
} from "../services/cart.service.js";

/**
 * Vanta cart endpoints, all mounted under `/api/v1/cart` and all
 * authenticated.
 *
 * The controller only shapes HTTP: it reads `req.query`/`req.params`/`req.body`
 * into validated input, calls the cart service and wraps the result in the
 * envelope. `req.user.id` is the ONLY identity every operation is scoped to —
 * a userId or itemId from a foreign cart is never reachable through this file.
 */

// GET /cart — the live cart view (pricing, groups, audit issues, totals).
const getCart = asyncHandlers(async (req, res) => {
    const deliveryMethod = typeof req.query.deliveryMethod === "string" ? req.query.deliveryMethod : undefined;
    const voucher =
        typeof req.query.voucher === "string" && req.query.voucher.trim() !== "" ? req.query.voucher : undefined;

    const view = await getCartView(req.user.id, { deliveryMethod, voucher });
    return res.status(200).json(new ApiResponse(200, view, "Cart loaded."));
});

// POST /cart/items — add (or merge) a line, returning the same cart view.
const addItem = asyncHandlers(async (req, res) => {
    const input = validateAddItem(req.body);
    const view = await addItemToCart(req.user.id, input);
    return res.status(201).json(new ApiResponse(201, view, "Item added to cart."));
});

// PATCH /cart/items/:id — clamp quantity and/or flip selected.
const updateItem = asyncHandlers(async (req, res) => {
    const patch = validateUpdateItem(req.body);
    const view = await updateCartItem(req.user.id, req.params.id, patch);
    return res.status(200).json(new ApiResponse(200, view, "Cart updated."));
});

// DELETE /cart/items/:id — remove one line from the caller's cart.
const deleteItem = asyncHandlers(async (req, res) => {
    const view = await removeCartItem(req.user.id, req.params.id);
    return res.status(200).json(new ApiResponse(200, view, "Item removed."));
});

// DELETE /cart/items — empty the caller's cart.
const clearCartItems = asyncHandlers(async (req, res) => {
    const view = await clearCart(req.user.id);
    return res.status(200).json(new ApiResponse(200, view, "Cart cleared."));
});

// PATCH /cart/select — select/deselect all lines or one seller's lines.
const selectLines = asyncHandlers(async (req, res) => {
    const input = validateSelect(req.body);
    const view = await setSelection(req.user.id, input);
    return res.status(200).json(new ApiResponse(200, view, "Selection updated."));
});

export { getCart, addItem, updateItem, deleteItem, clearCartItems, selectLines };