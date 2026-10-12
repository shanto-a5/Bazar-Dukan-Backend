import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateAddWishlistItem, validateWishlistProductIdParam } from "../validators/wishlist.validator.js";
import { list, add, remove, clear } from "../services/wishlist.service.js";

/**
 * Vanta wishlist endpoints, all mounted under `/api/v1/wishlist` and all
 * authenticated.
 *
 * The controller only shapes HTTP: it validates input, calls the wishlist
 * service and wraps the result in the envelope. `req.user.id` is the ONLY
 * identity every operation is scoped to — a client-supplied `userId` never
 * reaches this file (the validator rejects it). Every mutation re-reads the
 * pruned list, so the client always sees the same `{ items }` shape.
 */

// GET /wishlist — the pruned view: productId, addedAt, available and the
// public product DTO, sorted newest-first.
const getWishlist = asyncHandlers(async (req, res) => {
    const items = await list(req.user.id);
    return res.status(200).json(new ApiResponse(200, { items }, "Wishlist loaded."));
});

// POST /wishlist/items — add one product; the full list follows.
const addWishlistItem = asyncHandlers(async (req, res) => {
    const { productId } = validateAddWishlistItem(req.body);
    await add(req.user.id, productId);
    const items = await list(req.user.id);
    return res.status(201).json(new ApiResponse(201, { items }, "Wishlist updated."));
});

// DELETE /wishlist/items/:productId — drop one product; the full list follows.
const removeWishlistItem = asyncHandlers(async (req, res) => {
    const productId = validateWishlistProductIdParam(req.params.productId);
    await remove(req.user.id, productId);
    const items = await list(req.user.id);
    return res.status(200).json(new ApiResponse(200, { items }, "Wishlist updated."));
});

// DELETE /wishlist — empty the list.
const clearWishlist = asyncHandlers(async (req, res) => {
    await clear(req.user.id);
    return res.status(200).json(new ApiResponse(200, { items: [] }, "Wishlist cleared."));
});

export { getWishlist, addWishlistItem, removeWishlistItem, clearWishlist };