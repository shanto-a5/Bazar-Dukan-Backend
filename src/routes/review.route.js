import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller } from "../middlewares/authz.middleware.js";
import {
    createReview,
    updateReview,
    deleteReview,
    eligibleReviews,
    myReviews,
    productReviews,
    sellerReviews,
    sellerReviewDetail,
    replyToReview
} from "../controllers/review.controller.js";

/**
 * Vanta review routes. The paths are the FULL client paths so the router
 * mounts straight onto the API prefix (`app.use("/api/v1", reviewRouter)`)
 * without a hidden segment.
 *
 * Three surfaces, three guards:
 *
 *   - the customer surface is `authenticate` only and always acts on
 *     `req.user.id`, so a review that is not yours is a 404;
 *   - the product page is public, and the visibility rule that keeps drafts,
 *     paused stores and inactive sellers off it runs inside the service (the
 *     same `customerVisibility` the catalog uses) — an invisible product
 *     answers the same 404 as one that never existed;
 *   - the seller surface is `authenticate + requireSeller` and scopes to
 *     `req.sellerProfile._id`, so a seller can never see or answer a review
 *     on somebody else's product.
 *
 * The literal reads (`/reviews/eligible`, `/reviews/mine`) are declared before
 * the parameterised `/reviews/:id` so a literal path can never be swallowed by
 * a param, and every `/:id` route only implements the methods the simulator
 * has: PATCH/DELETE for the author, GET/POST for the seller.
 */
const router = Router();

// customer surface — identity always from req.user.id
router.route("/reviews").post(authenticate, createReview);
router.route("/reviews/eligible").get(authenticate, eligibleReviews);
router.route("/reviews/mine").get(authenticate, myReviews);
router.route("/reviews/:id").patch(authenticate, updateReview).delete(authenticate, deleteReview);

// public product page — visible products only, no auth
router.route("/catalog/products/:id/reviews").get(productReviews);

// seller surface — identity always from req.sellerProfile._id
router.route("/seller/reviews").get(authenticate, requireSeller, sellerReviews);
router.route("/seller/reviews/:id").get(authenticate, requireSeller, sellerReviewDetail);
router.route("/seller/reviews/:id/reply").post(authenticate, requireSeller, replyToReview);

export default router;
