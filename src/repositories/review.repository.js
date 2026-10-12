import mongoose from "mongoose";
import { Review } from "../models/review.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { Order } from "../models/order.model.js";

/**
 * Data access for the review slice.
 *
 * Two halves live here on purpose. The first is Review itself: CRUD, the
 * owner/seller/product listings, and the two rating aggregates the simulator's
 * `recomputeAggregates` writes back onto the Product and Store documents —
 * a plain mean over ALL of a product's (resp. a seller's) reviews with no
 * rounding, `0` when the set is empty, exactly like `review-service.ts`.
 *
 * The second is the order-line lookup eligibility needs: a review may only be
 * born from a delivered line of the caller's own order, so the repository
 * resolves `orderItemId` -> SellerOrder -> Order (skipping orphaned rows the
 * way the simulator does: an orphan must never make later lines unreviewable)
 * and the service decides what that outcome means.
 *
 * `orderItemId` is the model's unique index: one review per order line, so a
 * duplicate insert rejects with E11000 and the service translates that race
 * into the simulator's "You already reviewed this item." answer.
 *
 * Malformed ids resolve to `null` instead of throwing a CastError, which keeps
 * "not yours" and "does not exist" indistinguishable on every ownership read.
 */
const isValidId = (value) => mongoose.isValidObjectId(value);

/** Unsorted mean the simulator stores: `sum / count`, or `0` for an empty set. */
const meanOf = (ratings) =>
    ratings.length === 0 ? 0 : ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length;

class ReviewRepository {
    // ------------------------------------------------------------- reviews

    async create(review) {
        return Review.create(review);
    }

    /** `null` for anything that is not an id, so a bad id is a 404, not a 500. */
    async findById(reviewId) {
        if (!isValidId(reviewId)) return null;
        return Review.findById(reviewId);
    }

    /** The unique order line — the "one review per line" rule in one read. */
    async findByOrderItem(orderItemId) {
        if (!orderItemId) return null;
        return Review.findOne({ orderItemId: String(orderItemId) });
    }

    /** Newest first, with `_id` as the deterministic tie-break. */
    async listForProduct(productId, { limit = 0, offset = 0 } = {}) {
        let query = Review.find({ productId }).sort({ createdAt: -1, _id: -1 });
        if (offset > 0) query = query.skip(offset);
        if (limit > 0) query = query.limit(limit);
        return query;
    }

    async countForProduct(productId) {
        return Review.countDocuments({ productId });
    }

    async listForUser(userId) {
        if (!userId) return [];
        return Review.find({ userId }).sort({ createdAt: -1, _id: -1 });
    }

    async listForSeller(sellerId) {
        if (!sellerId) return [];
        return Review.find({ sellerId }).sort({ createdAt: -1, _id: -1 });
    }

    async update(reviewId, updates) {
        if (!isValidId(reviewId)) return null;
        return Review.findByIdAndUpdate(reviewId, { $set: updates }, { new: true, runValidators: true });
    }

    async remove(reviewId) {
        if (!isValidId(reviewId)) return false;
        const deleted = await Review.findByIdAndDelete(reviewId);
        return Boolean(deleted);
    }

    // ------------------------------------------------------------ ratings

    /** `{ ratingAvg, ratingCount }` over every review of one product. */
    async ratingsForProduct(productId) {
        const rows = await Review.find({ productId }).select("rating").lean();
        const ratingCount = rows.length;
        return { ratingAvg: meanOf(rows.map((row) => row.rating)), ratingCount };
    }

    /** `{ ratingAvg, ratingCount }` over every review of one seller. */
    async ratingsForSeller(sellerId) {
        const rows = await Review.find({ sellerId }).select("rating").lean();
        const ratingCount = rows.length;
        return { ratingAvg: meanOf(rows.map((row) => row.rating)), ratingCount };
    }

    // ------------------------------------------------------- order lines

    /** The seller order(s) whose snapshot carries this line id, if any. */
    async findSellerOrdersContainingItem(orderItemId) {
        if (!orderItemId) return [];
        return SellerOrder.find({ "items.id": String(orderItemId) });
    }

    /** `null` when the id is malformed or the parent order is gone. */
    async findOrderById(orderId) {
        if (!isValidId(orderId)) return null;
        return Order.findById(orderId);
    }

    /** The customer's orders, newest first — the eligible-lines walk starts here. */
    async listOrdersForCustomer(userId) {
        if (!userId) return [];
        return Order.find({ customerId: userId }).sort({ placedAt: -1, _id: -1 });
    }

    async findSellerOrderById(sellerOrderId) {
        if (!isValidId(sellerOrderId)) return null;
        return SellerOrder.findById(sellerOrderId);
    }

    /** Stamps the line's `hasReview` / `reviewId`, exactly as the simulator does. */
    async markItemReviewed(sellerOrderId, orderItemId, reviewId) {
        if (!isValidId(sellerOrderId) || !orderItemId) return null;
        return SellerOrder.updateOne(
            { _id: sellerOrderId, "items.id": String(orderItemId) },
            { $set: { "items.$.hasReview": true, "items.$.reviewId": String(reviewId) } }
        );
    }

    /** Clears the flags on every seller order that carried the deleted line's review. */
    async clearItemReview(reviewId) {
        if (!reviewId) return null;
        return SellerOrder.updateMany(
            { "items.reviewId": String(reviewId) },
            { $set: { "items.$.hasReview": false, "items.$.reviewId": null } }
        );
    }
}

export const reviewRepository = new ReviewRepository();
