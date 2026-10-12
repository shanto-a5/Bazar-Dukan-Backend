import { ApiError } from "../utils/ApiError.js";
import { Product } from "../models/product.model.js";
import { Store } from "../models/store.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { toProductDto } from "../repositories/product.repository.js";
import { productIsAvailable, productIsVisibleToCustomer } from "../core/catalog-rules.js";
import { wishlistRepository } from "../repositories/wishlist.repository.js";

/**
 * Wishlist domain rules, mirroring `src/services/wishlist-service.ts`.
 *
 * - `list` PRUNES first, exactly like the service: items are de-duplicated by
 *   product keeping the FIRST occurrence, and rows whose product document no
 *   longer exists are dropped (persisted, and `updatedAt` bumped, only when
 *   something changed).
 * - Availability is the product screen's rule: `available` is true only when
 *   `productIsVisibleToCustomer && productIsAvailable`. A draft or paused-store
 *   listing stays on the list with `available: false`; only a MISSING product
 *   is pruned away.
 * - `add` requires a live product (else 422 "Product not found."), is a silent
 *   no-op for a duplicate, and `unshift`s the new item so the newest sits
 *   first. `remove` and `clear` are quiet no-ops when there is nothing to do.
 * - Identity is `req.user.id` end to end; the list methods read the caller's
 *   own row or answer an empty list — a foreign wishlist is never reachable.
 */
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The lookups `customerVisibility` needs, resolved once per read so the
 * availability check never issues its own queries. Same shape cart-pricing and
 * the catalog query service build.
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

/** The full list, pruned, enriched and newest-first — the only read a client sees. */
const list = async (userId) => {
    const wishlist = await wishlistRepository.findByUserId(userId);
    if (!wishlist) return [];

    const productIds = wishlist.items.map((item) => String(item.productId));
    const byId = new Map();
    if (productIds.length > 0) {
        const found = await Product.find({ _id: { $in: productIds } });
        for (const product of found) byId.set(String(product._id), product);
    }

    // prune: dedupe by productId keeping the FIRST occurrence, then drop rows
    // whose product document is gone.
    const seen = new Set();
    const kept = [];
    for (const item of wishlist.items) {
        const productId = String(item.productId);
        if (seen.has(productId)) continue;
        seen.add(productId);
        if (!byId.has(productId)) continue;
        kept.push(item);
    }

    if (kept.length !== wishlist.items.length) {
        wishlist.items = kept;
        wishlist.updatedAt = new Date();
        await wishlistRepository.save(wishlist);
    }

    if (kept.length === 0) return [];

    const existing = [...new Set(kept.map((item) => String(item.productId)))]
        .map((id) => byId.get(id))
        .filter(Boolean);
    const lookups = await lookupsFor(existing);

    const entries = [];
    for (const item of kept) {
        const product = byId.get(String(item.productId));
        if (!product) continue;
        entries.push({
            productId: String(item.productId),
            addedAt: iso(item.addedAt),
            available: Boolean(productIsVisibleToCustomer(product, lookups) && productIsAvailable(product)),
            product: toProductDto(product)
        });
    }
    return entries.sort((left, right) => new Date(right.addedAt).getTime() - new Date(left.addedAt).getTime());
};

/** Add a product; 422 when the product no longer exists, no-op for a duplicate. */
const add = async (userId, productId) => {
    const product = await Product.findById(productId);
    if (!product) throw new ApiError(422, "Product not found.", [], "", "validation_failed");

    const wishlist = await wishlistRepository.ensureWishlist(userId);
    if (wishlist.items.some((item) => String(item.productId) === String(productId))) return wishlist;

    // new items UNSHIFT (newest first), mirroring the service's `items.unshift`.
    wishlist.items = [{ productId: product._id, addedAt: new Date() }, ...wishlist.items];
    wishlist.updatedAt = new Date();
    await wishlistRepository.save(wishlist);
    return wishlist;
};

/** Remove a product; a quiet no-op when it was not on the list. */
const remove = async (userId, productId) => {
    const wishlist = await wishlistRepository.findByUserId(userId);
    if (!wishlist || !wishlist.items.some((item) => String(item.productId) === String(productId))) return wishlist;

    wishlist.items = wishlist.items.filter((item) => String(item.productId) !== String(productId));
    wishlist.updatedAt = new Date();
    await wishlistRepository.save(wishlist);
    return wishlist;
};

/** Empty the list; a quiet no-op when it already is. */
const clear = async (userId) => {
    const wishlist = await wishlistRepository.findByUserId(userId);
    if (!wishlist || wishlist.items.length === 0) return wishlist;

    wishlist.items = [];
    wishlist.updatedAt = new Date();
    await wishlistRepository.save(wishlist);
    return wishlist;
};

export { list, add, remove, clear };