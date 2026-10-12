import { ApiError } from "../utils/ApiError.js";
import { Product } from "../models/product.model.js";
import { Store } from "../models/store.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { toProductDto } from "../repositories/product.repository.js";
import { productIsAvailable, productIsVisibleToCustomer } from "../core/catalog-rules.js";
import { recentlyViewedRepository } from "../repositories/recently-viewed.repository.js";

/**
 * Recently-viewed domain rules, mirroring `src/services/catalog-service.ts`
 * (`recordView`, `recentlyViewed`).
 *
 * - POST is the ONLY place `viewCount` moves: exactly one atomic `$inc`, and
 *   only for a product that exists (an unknown product is a 422, so the bump
 *   can never happen with nothing to attribute it to). Reads never touch it.
 * - Recording dedupes through the unique `{userId, productId}` upsert: the
 *   simulator deletes the old row and inserts a fresh one, so re-viewing a
 *   product moves it to the top of the list instead of stacking a second row.
 * - The list maps the caller's rows (newest first) onto the live catalog and
 *   drops, in this order: rows whose product document is gone, and products
 *   that are not visible to a customer (`productIsVisibleToCustomer`) — the
 *   same filters `catalogService.recentlyViewed` applies before its `slice`.
 *   `available` is the wishlist/product-screen rule verbatim: visible AND
 *   available. Filtering happens BEFORE the limit, so the client gets the
 *   newest `limit` viewable entries, not `limit` rows with holes.
 * - Identity is always `req.user.id`; a delete scoped to it can only ever
 *   remove the caller's own row (a foreign row simply does not match).
 */
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The lookups `customerVisibility` needs, resolved once per read so the
 * visibility check never issues its own queries. Same shape cart-pricing and
 * the wishlist service build.
 */
const lookupsFor = async (products) => {
    if (products.length === 0) return null;
    const storeIds = [...new Set(products.map((product) => String(product.storeId)))];
    const sellerIds = [...new Set(products.map((product) => String(product.sellerId)))];

    const stores = await Store.find({ $or: [{ _id: { $in: storeIds } }, { sellerId: { $in: sellerIds } }] });
    const sellers = sellerIds.length > 0 ? await SellerProfile.find({ _id: { $in: sellerIds } }) : [];

    const storesById = new Map(stores.map((store) => [String(store._id), store]));
    const storesBySellerId = new Map(stores.map((store) => [String(store.sellerId), store]));
    const sellersById = new Map(sellers.map((seller) => [String(seller._id), seller]));

    return {
        getStoreById: (id) => storesById.get(String(id)) ?? null,
        getStoreBySellerId: (id) => storesBySellerId.get(String(id)) ?? storesById.get(String(id)) ?? null,
        getSellerById: (id) => sellersById.get(String(id)) ?? null
    };
};

/** Record one view: existence check, single `$inc`, then the move-to-newest upsert. */
const recordView = async (userId, productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new ApiError(422, "Product not found.", [], "", "validation_failed");

    await Product.updateOne({ _id: product._id }, { $inc: { viewCount: 1 } });
    const entry = await recentlyViewedRepository.recordForUser(userId, productId);

    return { entry: { productId: String(entry.productId), addedAt: iso(entry.createdAt) } };
};

/** Newest-first, live-catalog mapped, missing/draft products filtered, then `limit`. */
const recentlyViewed = async (userId, limit) => {
    const entries = await recentlyViewedRepository.listForUser(userId);
    if (entries.length === 0) return { items: [] };

    const found = await Product.find({ _id: { $in: entries.map((entry) => entry.productId) } });
    if (found.length === 0) return { items: [] };
    const byId = new Map(found.map((product) => [String(product._id), product]));
    const lookups = await lookupsFor(found);

    const items = [];
    for (const entry of entries) {
        const product = byId.get(String(entry.productId));
        if (!product) continue;
        if (!productIsVisibleToCustomer(product, lookups)) continue;

        items.push({
            productId: String(entry.productId),
            addedAt: iso(entry.createdAt),
            available: Boolean(productIsVisibleToCustomer(product, lookups) && productIsAvailable(product)),
            product: toProductDto(product)
        });
        if (items.length >= limit) break;
    }
    return { items };
};

/** Drop the caller's row only; `removed: false` is a 200, not an error. */
const removeViewedProduct = async (userId, productId) => {
    const result = await recentlyViewedRepository.removeForUser(userId, productId);
    return { removed: result.deletedCount > 0 };
};

export { recordView, recentlyViewed, removeViewedProduct };
