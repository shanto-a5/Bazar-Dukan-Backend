import { ApiError } from "../utils/ApiError.js";
import { customerVisibility } from "../core/catalog-rules.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { reviewRepository } from "../repositories/review.repository.js";
import * as productRepository from "../repositories/product.repository.js";
import * as storeRepository from "../repositories/store.repository.js";
import * as userRepository from "../repositories/user.repository.js";
import { create as createNotification } from "./notification.service.js";

/**
 * Review domain rules — a port of the simulator's `src/services/review-service.ts`.
 *
 * The rules and messages below are that file's, verbatim:
 *
 *   Eligibility is per ORDER LINE: the line must live in a SellerOrder of an
 *   Order the caller owns, its own `status` must be `delivered` (the line's
 *   status, not the parent order's), and nobody may have reviewed the line yet
 *   — a line reviewed by someone else answers "not yours", a line nobody owns
 *   answers "Order item not found.". Failure reasons map to one 422 each:
 *   "You already reviewed this item." / "You can only review your own delivered
 *   items." / "Order item not found." / "This item has not been delivered yet."
 *
 *   One review per line is also the model's unique `orderItemId` index; the
 *   E11000 race translates to the same duplicate message as a 409.
 *
 *   Reviews are visible immediately — the simulator has NO approval step —
 *   and the author may edit or delete theirs forever (no window in the
 *   simulator). A foreign review is a 404 ("Review not found."), never a 403,
 *   so an id cannot be probed.
 *
 *   A seller may reply once per review in the sense that matters: a second
 *   reply REPLACES the first (the simulator's `reply` overwrites), scoped to
 *   reviews on that seller's own products — anybody else's is a 404.
 *
 *   Aggregates: every create/edit/delete recomputes `ratingAvg`/`ratingCount`
 *   on the PRODUCT (mean over all of its reviews, no rounding, `0` when empty)
 *   and on the STORE of the reviewing seller (mean over all of that seller's
 *   reviews) — `recomputeAggregates` in the simulator. SellerProfile has no
 *   rating columns in this schema, so nothing else is denormalised.
 *
 *   Notifications mirror the simulator exactly: `seller_review_received` to
 *   the product's seller on create, `review_reply` to the reviewer on reply.
 *
 * Identity always comes from `req.user.id` or the `req.sellerProfile` the
 * middleware resolved — never from a body or a query.
 */
const validation = (message, fields = []) => new ApiError(422, message, fields, "", "validation_failed");
const conflict = (message) => new ApiError(409, message, [], "", "conflict");
const notFound = (message) => new ApiError(404, message, [], "", "not_found");

const MESSAGES = {
    alreadyReviewed: "You already reviewed this item.",
    notYours: "You can only review your own delivered items.",
    orderItemNotFound: "Order item not found.",
    notDelivered: "This item has not been delivered yet.",
    mismatch: "This review does not match the delivered order item.",
    reviewNotFound: "Review not found.",
    productNotFound: "Product not found.",
    userNotFound: "User not found."
};

/** The simulator's eligibility reasons, in the order `eligibility` reports them. */
const ELIGIBILITY_MESSAGES = {
    already_reviewed: MESSAGES.alreadyReviewed,
    not_yours: MESSAGES.notYours,
    not_found: MESSAGES.orderItemNotFound,
    not_delivered: MESSAGES.notDelivered
};

const eligibilityError = (reason) => validation(ELIGIBILITY_MESSAGES[reason] ?? MESSAGES.orderItemNotFound);

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** Public projection: `id` as a string, never `_id`/`__v`, foreign keys as strings. */
const toReviewDto = (review) => ({
    id: String(review._id),
    userId: String(review.userId),
    userName: review.userName ?? "",
    productId: String(review.productId),
    sellerId: String(review.sellerId),
    orderId: String(review.orderId),
    orderItemId: review.orderItemId,
    rating: review.rating,
    title: review.title ?? "",
    text: review.text ?? "",
    images: [...(review.images ?? [])],
    verifiedPurchase: Boolean(review.verifiedPurchase),
    sellerReply: review.sellerReply?.text
        ? { text: review.sellerReply.text, at: iso(review.sellerReply.at) }
        : null,
    helpfulCount: review.helpfulCount ?? 0,
    createdAt: iso(review.createdAt),
    updatedAt: iso(review.updatedAt)
});

/**
 * What a seller sees: the review plus the fields `SellerReviewView` carries in
 * the simulator — product name (or "Removed product"), reply presence, the
 * order code and the listing state (`live` / `hidden` / `missing`).
 */
const toSellerView = (review, product, order) => ({
    ...toReviewDto(review),
    productName: product ? product.name : "Removed product",
    verified: Boolean(review.verifiedPurchase),
    hasReply: Boolean(review.sellerReply?.text),
    replyText: review.sellerReply?.text ?? null,
    orderCode: order ? order.orderCode : null,
    listingStatus: !product ? "missing" : product.status === "active" ? "live" : "hidden"
});

/**
 * The product behind a public read, or the catalog's 404.
 *
 * Same rule as `GET /catalog/products/:id`: a draft, a paused store or an
 * inactive seller answers "Product not found." byte for byte, so the reviews
 * endpoint cannot be used to probe for listings a buyer may not see.
 */
const visibleProduct = async (productId) => {
    const product = await productRepository.findById(productId);
    if (!product) throw notFound(MESSAGES.productNotFound);

    const store =
        (await storeRepository.findById(product.storeId)) ??
        (await storeRepository.findBySellerId(product.sellerId));
    const seller = await SellerProfile.findById(product.sellerId);
    const lookups = {
        getStoreById: () => store,
        getStoreBySellerId: () => store,
        getSellerById: () => seller
    };
    if (!customerVisibility(product, lookups).visible) throw notFound(MESSAGES.productNotFound);
    return product;
};

/**
 * The simulator's `eligibility(userId, orderItemId)`, reason for reason.
 *
 * Checks run in the simulator's order: an existing review first (its author
 * decides "already reviewed" vs "not yours"), then the line lookup (orphaned
 * seller orders are skipped, never fatal), then ownership, then the line's own
 * `delivered` status.
 */
const eligibility = async (userId, orderItemId) => {
    const lineId = typeof orderItemId === "string" ? orderItemId.trim() : "";

    const existing = await reviewRepository.findByOrderItem(lineId);
    if (existing) {
        const owner = String(existing.userId) === String(userId);
        return { reason: owner ? "already_reviewed" : "not_yours", reviewId: String(existing._id) };
    }

    const sellerOrders = await reviewRepository.findSellerOrdersContainingItem(lineId);
    for (const sellerOrder of sellerOrders) {
        const item = sellerOrder.items.find((entry) => entry.id === lineId);
        if (!item) continue;

        const order = await reviewRepository.findOrderById(sellerOrder.orderId);
        if (!order) continue;
        if (String(order.customerId) !== String(userId)) return { reason: "not_yours" };

        const context = {
            orderId: String(order._id),
            sellerOrderId: String(sellerOrder._id),
            productId: item.productId,
            sellerId: String(sellerOrder.sellerId),
            item
        };
        if (item.status !== "delivered") return { reason: "not_delivered", ...context };
        return { reason: "can_review", ...context };
    }

    return { reason: "not_found" };
};

/** The caller's delivered lines that nobody has reviewed yet, newest order first. */
const eligibleLines = async (userId) => {
    const orders = await reviewRepository.listOrdersForCustomer(userId);
    const items = [];

    for (const order of orders) {
        for (const sellerOrderId of order.sellerOrderIds ?? []) {
            const sellerOrder = await reviewRepository.findSellerOrderById(sellerOrderId);
            if (!sellerOrder) continue;

            for (const item of sellerOrder.items) {
                if (item.status !== "delivered") continue;
                if (await reviewRepository.findByOrderItem(item.id)) continue;

                items.push({
                    orderItemId: item.id,
                    orderId: String(order._id),
                    sellerOrderId: String(sellerOrder._id),
                    orderNumber: order.orderCode,
                    productId: item.productId,
                    productName: item.productName,
                    product: {
                        id: item.productId,
                        name: item.productName,
                        image: item.image ?? ""
                    },
                    brand: item.brand ?? "",
                    image: item.image ?? "",
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                    status: item.status,
                    placedAt: iso(order.placedAt)
                });
            }
        }
    }

    return items;
};

/**
 * Writes the simulator's unrounded mean back onto the Product and the Store.
 *
 * The product is recomputed from ALL of its reviews; the store from ALL of the
 * seller's reviews across products. Nothing else carries rating columns:
 * SellerProfile has none in this schema.
 */
const recomputeAggregates = async (productId, sellerId) => {
    await productRepository.patchById(productId, await reviewRepository.ratingsForProduct(productId));

    const store = await storeRepository.findBySellerId(sellerId);
    if (store) {
        await storeRepository.patchById(store._id, await reviewRepository.ratingsForSeller(sellerId));
    }
};

/**
 * POST /reviews — one review for one delivered line the caller owns.
 *
 * Every guard and message is the simulator's, in its order: user, eligibility,
 * the optional "does this match the delivered order item?" cross-check, the
 * product, then the write (E11000 -> the duplicate message as a 409), the
 * line's `hasReview` stamp, the aggregate recompute and the seller's
 * `seller_review_received` notification.
 */
const create = async (userId, input) => {
    const user = await userRepository.findById(userId);
    if (!user) throw notFound(MESSAGES.userNotFound);

    const outcome = await eligibility(userId, input.orderItemId);
    if (outcome.reason !== "can_review") throw eligibilityError(outcome.reason);

    const { match } = input;
    if (
        (match.orderId && match.orderId !== outcome.orderId) ||
        (match.sellerOrderId && match.sellerOrderId !== outcome.sellerOrderId) ||
        (match.productId && match.productId !== outcome.productId) ||
        (match.sellerId && match.sellerId !== outcome.sellerId)
    ) {
        throw validation(MESSAGES.mismatch);
    }

    const product = await productRepository.findById(outcome.productId);
    if (!product) throw notFound(MESSAGES.productNotFound);

    const userName = user.name || "Customer";

    let review;
    try {
        review = await reviewRepository.create({
            userId,
            userName,
            productId: product._id,
            sellerId: outcome.sellerId,
            orderItemId: input.orderItemId,
            orderId: outcome.orderId,
            rating: input.rating,
            title: input.title,
            text: input.text,
            images: input.images,
            verifiedPurchase: true,
            sellerReply: null,
            helpfulCount: 0
        });
    } catch (error) {
        if (error?.code === 11000) throw conflict(MESSAGES.alreadyReviewed);
        throw error;
    }

    await reviewRepository.markItemReviewed(outcome.sellerOrderId, input.orderItemId, String(review._id));
    await recomputeAggregates(String(product._id), outcome.sellerId);

    const seller = await SellerProfile.findById(outcome.sellerId);
    if (seller) {
        await createNotification({
            userId: seller.userId,
            type: "seller_review_received",
            title: "New Review",
            body: `${userName} reviewed "${product.name}".`,
            data: { productId: String(product._id), reviewId: String(review._id) }
        });
    }

    return toReviewDto(review);
};

/** PATCH /reviews/:id — author only (404 otherwise), rating/title/text/images. */
const update = async (userId, reviewId, patch) => {
    const review = await reviewRepository.findById(reviewId);
    if (!review || String(review.userId) !== String(userId)) throw notFound(MESSAGES.reviewNotFound);

    const updated = await reviewRepository.update(reviewId, { ...patch, updatedAt: new Date() });
    await recomputeAggregates(String(review.productId), String(review.sellerId));
    return toReviewDto(updated ?? review);
};

/** DELETE /reviews/:id — author only (404 otherwise), then the line flags clear. */
const remove = async (userId, reviewId) => {
    const review = await reviewRepository.findById(reviewId);
    if (!review || String(review.userId) !== String(userId)) throw notFound(MESSAGES.reviewNotFound);

    await reviewRepository.remove(reviewId);
    await reviewRepository.clearItemReview(String(review._id));
    await recomputeAggregates(String(review.productId), String(review.sellerId));
    return { deleted: true };
};

/** GET /reviews/mine — the caller's own reviews, newest first (simulator `listForUser`). */
const listForUser = async (userId) => {
    const reviews = await reviewRepository.listForUser(userId);
    return reviews.map(toReviewDto);
};

/**
 * GET /catalog/products/:id/reviews — newest first with limit/offset, plus the
 * totals the product page renders.
 *
 * The reviewer's display name is the stored `userName`, verbatim: the
 * simulator renders `review.userName` with no masking anywhere (product page,
 * my-reviews, seller inbox), so this endpoint mirrors that byte for byte.
 */
const listForProduct = async (productId, { limit = 0, offset = 0 } = {}) => {
    const product = await visibleProduct(productId);

    const [reviews, total, ratings] = await Promise.all([
        reviewRepository.listForProduct(product._id, { limit, offset }),
        reviewRepository.countForProduct(product._id),
        reviewRepository.ratingsForProduct(product._id)
    ]);

    return {
        reviews: reviews.map(toReviewDto),
        total,
        ratingAvg: ratings.ratingAvg,
        ratingCount: ratings.ratingCount
    };
};

/** The simulator's `SellerReviewFilters`, read off a query string. */
const parseFilters = (raw = {}) => {
    const filters = {};

    if (raw.productId !== undefined && String(raw.productId).trim() !== "") {
        filters.productId = String(raw.productId).trim();
    }

    const rating = raw.rating;
    if (rating !== undefined && String(rating).trim() !== "" && String(rating) !== "all") {
        const value = Number(rating);
        if (Number.isInteger(value) && value >= 1 && value <= 5) filters.rating = value;
    }

    const reply = String(raw.reply ?? "");
    if (reply === "replied" || reply === "awaiting") filters.reply = reply;

    const verified = String(raw.verified ?? "");
    if (verified === "verified" || verified === "unverified") filters.verified = verified;

    const search = typeof raw.search === "string" ? raw.search.trim() : "";
    if (search !== "") filters.search = search;

    return filters;
};

/** The simulator's `filterSellerViews`, predicate for predicate. */
const matchesFilters = (view, filters) => {
    if (filters.productId && view.productId !== filters.productId) return false;
    if (filters.rating !== undefined && view.rating !== filters.rating) return false;
    if (filters.reply === "replied" && !view.hasReply) return false;
    if (filters.reply === "awaiting" && view.hasReply) return false;
    if (filters.verified === "verified" && !view.verified) return false;
    if (filters.verified === "unverified" && view.verified) return false;

    if (filters.search) {
        const haystack = `${view.productName} ${view.title} ${view.text} ${view.userName} ${view.orderCode ?? ""}`
            .toLowerCase();
        if (!haystack.includes(filters.search.toLowerCase())) return false;
    }
    return true;
};

/**
 * GET /seller/reviews — reviews on THIS seller's products only, newest first,
 * with the simulator's filters (productId, rating, reply, verified, search).
 */
const forSeller = async (sellerProfile, rawFilters = {}) => {
    const sellerId = String(sellerProfile._id);
    const filters = parseFilters(rawFilters);

    const reviews = await reviewRepository.listForSeller(sellerId);
    const views = [];
    for (const review of reviews) {
        const product = await productRepository.findById(review.productId);
        const order = await reviewRepository.findOrderById(review.orderId);
        const view = toSellerView(review, product, order);
        if (matchesFilters(view, filters)) views.push(view);
    }
    return views;
};

/** GET /seller/reviews/:id — another seller's review is a 404, never a 403. */
const forSellerById = async (sellerProfile, reviewId) => {
    const review = await reviewRepository.findById(reviewId);
    if (!review || String(review.sellerId) !== String(sellerProfile._id)) {
        throw notFound(MESSAGES.reviewNotFound);
    }

    const product = await productRepository.findById(review.productId);
    const order = await reviewRepository.findOrderById(review.orderId);
    return toSellerView(review, product, order);
};

/**
 * POST /seller/reviews/:id/reply — one reply per review in the sense the
 * simulator implements: a reply overwrites any previous one (the UI's "Edit
 * reply"), scoped to reviews on this seller's own products (else 404), with
 * the simulator's length rules and its `review_reply` notification to the
 * reviewer afterwards.
 */
const reply = async (sellerProfile, reviewId, text) => {
    const review = await reviewRepository.findById(reviewId);
    if (!review || String(review.sellerId) !== String(sellerProfile._id)) {
        throw notFound(MESSAGES.reviewNotFound);
    }

    const now = new Date();
    const updated = await reviewRepository.update(reviewId, {
        sellerReply: { text, at: now },
        updatedAt: now
    });

    const product = await productRepository.findById(review.productId);
    const store = await storeRepository.findBySellerId(String(sellerProfile._id));
    await createNotification({
        userId: review.userId,
        type: "review_reply",
        title: "Seller replied to your review",
        body: product
            ? `${store?.name ?? "The seller"} replied on "${product.name}".`
            : "The seller replied to your review.",
        data: { productId: String(review.productId), reviewId: String(review._id) }
    });

    return toReviewDto(updated ?? review);
};

export {
    eligibility,
    eligibleLines,
    create,
    update,
    remove,
    listForUser,
    listForProduct,
    forSeller,
    forSellerById,
    reply
};
