import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateRecordView, validateListQuery, validateProductIdParam } from "../validators/recently-viewed.validator.js";
import { recordView, recentlyViewed, removeViewedProduct } from "../services/recently-viewed.service.js";

/**
 * Vanta recently-viewed endpoints, all mounted under
 * `/api/v1/recently-viewed` and all authenticated.
 *
 * The controller only shapes HTTP: it validates input, calls the
 * recently-viewed service and wraps the result in the envelope. `req.user.id`
 * is the ONLY identity every operation is scoped to — a client-supplied
 * `userId` never reaches this file (the validator rejects it). Responses are
 * the endpoint's own data ({ entry } / { items } / { removed }), not the full
 * list re-read, because the simulator's screens re-fetch the list themselves.
 */

// POST /recently-viewed — record a view (bumps viewCount once, dedupes to one row).
const recordViewEntry = asyncHandlers(async (req, res) => {
    const { productId } = validateRecordView(req.body);
    const data = await recordView(req.user.id, productId);
    return res.status(201).json(new ApiResponse(201, data, "Product recorded as viewed."));
});

// GET /recently-viewed?limit= — newest-first, missing/draft products filtered, default 12.
const listRecentlyViewed = asyncHandlers(async (req, res) => {
    const { limit } = validateListQuery(req.query);
    const data = await recentlyViewed(req.user.id, limit);
    return res.status(200).json(new ApiResponse(200, data, "Recently viewed loaded."));
});

// DELETE /recently-viewed/products/:productId — drop the caller's row only
// (a row that is not there still answers 200 with { removed: false }).
const removeRecentlyViewedProduct = asyncHandlers(async (req, res) => {
    const productId = validateProductIdParam(req.params.productId);
    const data = await removeViewedProduct(req.user.id, productId);
    return res.status(200).json(new ApiResponse(200, data, "Product removed from recently viewed."));
});

export { recordViewEntry, listRecentlyViewed, removeRecentlyViewedProduct };
