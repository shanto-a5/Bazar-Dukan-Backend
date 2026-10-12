import mongoose from "mongoose";
import { Product } from "../models/product.model.js";
import { roundMoney } from "../core/money.js";

/**
 * Product data access plus the wire projection every catalog response uses.
 *
 * Ownership is the seller profile id, so every read in this slice is scoped by
 * `sellerId` and a product that is not yours is simply not found — there is no
 * way to name an id that resolves to someone else's listing.
 *
 * ## Variant ids
 *
 * Unlike the other embedded schemas in this project, `variantSchema` in
 * `product.model.js` is declared *without* `{ _id: false }`, so every variant
 * carries its own Mongo identity (verified against a live server: hydrated,
 * lean, from a payload, and after `$set` alike). `variantIdOf` therefore
 * reports that `_id`, and `toVariantDto` exposes it as `id` — a handle that
 * survives a SKU rename. The SKU fallback below still exists so that a model
 * that ever drops variant ids keeps working, and because the stock endpoint
 * deliberately accepts either form.
 *
 * Variant timestamps are another consequence: the embedded schema has no
 * `createdAt`/`updatedAt`, so a variant DTO simply does not carry them (the
 * simulator stamps its own copies).
 */
const isValidId = (value) => mongoose.isValidObjectId(value);

/** `null` for anything that cannot be an id, so a bad id is a 404, not a 500. */
const findById = async (productId) => {
    if (!isValidId(productId)) return null;
    return Product.findById(productId);
};

/** Every listing a seller owns; optionally narrowed to a set of statuses. */
const findBySeller = (sellerId, statuses) => {
    const filter = { sellerId };
    if (Array.isArray(statuses) && statuses.length > 0) filter.status = { $in: statuses };
    return Product.find(filter);
};

const insert = (doc) => Product.create(doc);

const patchById = (productId, update) =>
    Product.findByIdAndUpdate(productId, { $set: update }, { new: true, runValidators: true });

/**
 * The listings that count towards the store's `productCount` — the same three
 * statuses the simulator's `recomputeStoreCounters` counts (drafts and archived
 * listings are not on the shelf).
 */
const countLiveForSeller = (sellerId) =>
    Product.countDocuments({ sellerId, status: { $in: ["active", "out_of_stock", "paused"] } });

/**
 * The seller's SKUs minus one product's own, lowercased for the uniqueness
 * rule. This is the whole of `takenSkus` in the simulator: a Set of strings is
 * all `validateDraft` needs.
 */
const takenSkus = async (sellerId, exceptId) => {
    const filter = { sellerId };
    if (exceptId && isValidId(exceptId)) filter._id = { $ne: exceptId };

    const rows = await Product.find(filter, { sku: 1 }).lean();
    return new Set(rows.map((row) => String(row.sku ?? "").trim().toLowerCase()).filter(Boolean));
};

/** The id a client sends back as `variantId`: `_id` when one exists, else the SKU. */
const variantIdOf = (variant) => {
    if (!variant) return null;
    if (variant._id) return String(variant._id);
    return String(variant.sku ?? "");
};

/** A stored variant holds a `Map`; the wire holds a plain object. */
const plainAttributes = (attributes) => {
    if (attributes instanceof Map) return Object.fromEntries(attributes);
    if (attributes && typeof attributes === "object") return { ...attributes };
    return {};
};

const iso = (value) => (value ? new Date(value).toISOString() : null);

const toVariantDto = (variant, productId) => ({
    id: variantIdOf(variant),
    productId,
    sku: variant.sku ?? "",
    attributes: plainAttributes(variant.attributes),
    price: typeof variant.price === "number" ? roundMoney(variant.price) : variant.price,
    compareAtPrice: variant.compareAtPrice === null || variant.compareAtPrice === undefined
        ? null
        : roundMoney(variant.compareAtPrice),
    stock: variant.stock ?? 0,
    image: variant.image ?? ""
});

const toVideoDto = (video) => {
    if (!video) return null;
    return { placeholder: video.placeholder ?? "", uri: video.uri ?? "" };
};

/**
 * The wire shape of a product: camelCase, `id` instead of `_id`, every
 * foreign key a string, money rounded the way checkout rounds it, and dates
 * as ISO strings. Nothing that is only meaningful to the datastore (`__v`,
 * raw ObjectIds) reaches a client.
 */
const toProductDto = (product) => ({
    id: String(product._id),
    sellerId: String(product.sellerId),
    storeId: String(product.storeId),
    name: product.name,
    brand: product.brand ?? "",
    categoryId: String(product.categoryId),
    subcategoryId: product.subcategoryId ? String(product.subcategoryId) : null,
    description: product.description ?? "",
    highlights: [...(product.highlights ?? [])],
    images: [...(product.images ?? [])],
    video: toVideoDto(product.video),
    regularPrice: typeof product.regularPrice === "number" ? roundMoney(product.regularPrice) : product.regularPrice,
    salePrice: product.salePrice === null || product.salePrice === undefined ? null : roundMoney(product.salePrice),
    costPrice: product.costPrice === null || product.costPrice === undefined ? null : roundMoney(product.costPrice),
    sku: product.sku,
    stock: product.stock ?? 0,
    lowStockThreshold: product.lowStockThreshold ?? 5,
    hasVariants: Boolean(product.hasVariants),
    variants: (product.variants ?? []).map((variant) => toVariantDto(variant, String(product._id))),
    status: product.status,
    publishedAt: iso(product.publishedAt),
    ratingAvg: product.ratingAvg ?? 0,
    ratingCount: product.ratingCount ?? 0,
    soldCount: product.soldCount ?? 0,
    viewCount: product.viewCount ?? 0,
    isNewArrival: Boolean(product.isNewArrival),
    createdAt: iso(product.createdAt),
    updatedAt: iso(product.updatedAt)
});

export {
    findById,
    findBySeller,
    insert,
    patchById,
    countLiveForSeller,
    takenSkus,
    variantIdOf,
    toVariantDto,
    toProductDto
};
