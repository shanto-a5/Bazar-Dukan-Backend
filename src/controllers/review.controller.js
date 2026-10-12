import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateCreateReview, validatePatchReview, validateReply } from "../validators/review.validator.js";
import * as reviewService from "../services/review.service.js";

/**
 * Review endpoints — HTTP shaping only.
 *
 * Identity comes exclusively from `req.user.id` (customer surface) or
 * `req.sellerProfile._id` (seller surface, resolved by `requireSeller`): no
 * reviewer, owner or seller id is ever read out of the body or the path, so a
 * foreign review or a foreign product's review is a 404 from the service —
 * never a 403, which would confirm the id exists.
 *
 * Read pagination: `limit` is an integer in 1..100 (default 20) and `offset` a
 * non-negative integer (default 0); both are clamped here so the service only
 * ever sees numbers.
 */

/** `limit` → 1..100, default 20; `offset` → >= 0, default 0. */
const parsePaging = (query) => {
    const rawLimit = Number.parseInt(String(query.limit ?? ""), 10);
    const rawOffset = Number.parseInt(String(query.offset ?? ""), 10);

    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    return { limit, offset };
};

// POST /reviews — the simulator's create input, 201 with the new review.
const createReview = asyncHandlers(async (req, res) => {
    const input = validateCreateReview(req.body);
    const review = await reviewService.create(req.user.id, input);

    return res.status(201).json(new ApiResponse(201, { review }, "Review created."));
});

// PATCH /reviews/:id — author only (404 otherwise), rating/title/text/images.
const updateReview = asyncHandlers(async (req, res) => {
    const patch = validatePatchReview(req.body);
    const review = await reviewService.update(req.user.id, req.params.id, patch);

    return res.status(200).json(new ApiResponse(200, { review }, "Review updated."));
});

// DELETE /reviews/:id — author only (404 otherwise).
const deleteReview = asyncHandlers(async (req, res) => {
    const result = await reviewService.remove(req.user.id, req.params.id);

    return res.status(200).json(new ApiResponse(200, result, "Review deleted."));
});

// GET /reviews/eligible — the caller's delivered lines nobody has reviewed yet.
const eligibleReviews = asyncHandlers(async (req, res) => {
    const items = await reviewService.eligibleLines(req.user.id);

    return res.status(200).json(new ApiResponse(200, { items }, "Eligible items listed."));
});

// GET /reviews/mine — the caller's own reviews, newest first.
const myReviews = asyncHandlers(async (req, res) => {
    const reviews = await reviewService.listForUser(req.user.id);

    return res.status(200).json(new ApiResponse(200, { reviews }, "Reviews listed."));
});

// GET /catalog/products/:id/reviews — public page, masked-name rule = none (see service).
const productReviews = asyncHandlers(async (req, res) => {
    const { limit, offset } = parsePaging(req.query);
    const result = await reviewService.listForProduct(req.params.id, { limit, offset });

    return res.status(200).json(new ApiResponse(200, result, "Reviews listed."));
});

// GET /seller/reviews — reviews on this seller's products only, with filters.
const sellerReviews = asyncHandlers(async (req, res) => {
    const reviews = await reviewService.forSeller(req.sellerProfile, req.query);

    return res.status(200).json(new ApiResponse(200, { reviews }, "Reviews listed."));
});

// GET /seller/reviews/:id — 404 for any other seller's review.
const sellerReviewDetail = asyncHandlers(async (req, res) => {
    const review = await reviewService.forSellerById(req.sellerProfile, req.params.id);

    return res.status(200).json(new ApiResponse(200, { review }, "Review found."));
});

// POST /seller/reviews/:id/reply — one reply per review (a re-reply overwrites).
const replyToReview = asyncHandlers(async (req, res) => {
    const { reply } = validateReply(req.body);
    const review = await reviewService.reply(req.sellerProfile, req.params.id, reply);

    return res.status(200).json(new ApiResponse(200, { review }, "Reply saved."));
});

export {
    createReview,
    updateReview,
    deleteReview,
    eligibleReviews,
    myReviews,
    productReviews,
    sellerReviews,
    sellerReviewDetail,
    replyToReview
};
