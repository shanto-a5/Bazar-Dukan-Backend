import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { Product } from "../models/product.model.js";
import { Notification } from "../models/notification.model.js";
import * as productRepository from "../repositories/product.repository.js";
import * as adjustmentRepository from "../repositories/inventory-adjustment.repository.js";
import * as storeRepository from "../repositories/store.repository.js";
import { findById as findCategoryById } from "../repositories/category.repository.js";
import { effectivePrice, productStock, stockLevelOf } from "../core/catalog-rules.js";
import { validationError, validateDraft, productDraftFromProduct } from "../validators/product.validator.js";

/**
 * Seller catalog writes: create, read, update, status, stock, and the two
 * inventory reads.
 *
 * The rules mirror the simulator's `src/services/catalog-service.ts` rule for
 * rule and message for message — `validateDraft`, `statusFor`,
 * `bulkStatusBlock`, `sellerProductList`, `adjustStock`,
 * `recomputeStoreCounters` and the low-stock notification are all ports, not
 * reinterpretations, so a seller sees the same sentence here as in the app.
 *
 * Three seams are worth naming up front, because each is a deliberate,
 * documented divergence:
 *
 *   Ownership resolves to a 404, always. `ownedProduct` answers "Product not
 *   found." for an id that does not exist *and* for one that belongs to
 *   another seller, so no probe can learn which ids exist. That is also why
 *   ownership runs before every other check on update, status and stock —
 *   matching the simulator, which loads the product first.
 *
 *   Validation is split in two. The controller normalises the payload (pure,
 *   no I/O) and passes any structural field errors along; this service adds
 *   the three checks that need the datastore — category existence, subcategory
 *   existence, per-seller SKU uniqueness — and throws ONE 422 carrying every
 *   offending field, because a form that reveals one problem per round trip is
 *   a bad form.
 *
 *   Store counters are recomputed from the datastore, but ratings are not:
 *   this milestone has no review repository yet, so `ratingAvg`/`ratingCount`
 *   on the store are left exactly as they are (the simulator recompute reads
 *   reviews too). `productCount` is kept correct, which is what the storefront
 *   header shows.
 *
 * Identity always comes from `req.sellerProfile` — resolved by
 * `requireSeller` from the session — never from the payload.
 */
const notFound = () => new ApiError(404, "Product not found.", [], "", "not_found");
const storeNotFound = () => new ApiError(404, "Store not found.", [], "", "not_found");

/** One 422 for many field problems: the house aggregate message. */
const rejectFields = (fields) => {
    throw validationError("Please fix the highlighted fields.", fields);
};

/**
 * Flattens field-error lists into one list, first occurrence per field
 * winning: structural errors (a value of the wrong type) are reported before
 * the rule that value then breaks.
 */
const mergeFields = (...lists) => {
    const merged = [];
    const seen = new Set();
    for (const list of lists) {
        for (const entry of list ?? []) {
            if (!entry || typeof entry.field !== "string" || seen.has(entry.field)) continue;
            seen.add(entry.field);
            merged.push({ field: entry.field, message: String(entry.message ?? "") });
        }
    }
    return merged;
};

/** The product, or the same 404 whether it is missing or someone else's. */
const ownedProduct = async (profile, productId) => {
    const product = await productRepository.findById(productId);
    if (!product || String(product.sellerId) !== String(profile._id)) throw notFound();
    return product;
};

/**
 * Category existence without ever letting a malformed id become a CastError:
 * `findById` is wrapped so a value that passes `isValidObjectId` but still
 * fails to cast answers "no such category" — which `validateDraft` turns into
 * "Choose a category."
 */
const categoryExists = async (categoryId) => {
    if (!categoryId || !mongoose.isValidObjectId(categoryId)) return false;
    try {
        return Boolean(await findCategoryById(categoryId));
    } catch {
        return false;
    }
};

/** Payload-shape errors plus the datastore-dependent `validateDraft` rules. */
const rejectInvalidDraft = async (draft, { sellerId, exceptId = null, shapeErrors = [] }) => {
    const fields = mergeFields(
        shapeErrors,
        validateDraft(draft, {
            takenSkus: await productRepository.takenSkus(sellerId, exceptId),
            categoryExists: await categoryExists(draft.categoryId),
            subcategoryExists: draft.subcategoryId ? await categoryExists(draft.subcategoryId) : true
        })
    );
    if (fields.length > 0) rejectFields(fields);
};

/**
 * Where a listing lands after a change, ported from the simulator's
 * `statusFor` (catalog-service.ts:160). States a seller or the approval flow
 * chose are preserved; only the two stock-derived states are recomputed, so an
 * out-of-stock listing heals to `active` the moment it is restocked without
 * ever losing `archived`, `draft`, `pending` or `paused`.
 */
const statusFor = (product) => {
    if (["archived", "draft", "pending", "paused"].includes(product.status)) return product.status;
    return productStock(product) <= 0 ? "out_of_stock" : "active";
};

/**
 * Why one listing cannot take a given status, or `null` when it can — the
 * simulator's `bulkStatusBlock` (catalog-service.ts:146) verbatim, including
 * its sentences, which are shown to sellers. The single-status endpoint applies
 * the same guard as the bulk one so a seller never sees two different answers
 * for the same transition.
 */
const bulkStatusBlock = (product, status) => {
    if (product.status === status) return "Already in that state.";
    if (status === "active") {
        if (productStock(product) <= 0) return "Restock before publishing.";
        if (!String(product.name ?? "").trim() || (product.images ?? []).length === 0) {
            return "Add a name and a photo first.";
        }
    }
    if (status === "paused" && !["active", "out_of_stock"].includes(product.status)) {
        return "Only a live listing can be paused.";
    }
    if (status === "draft" && product.status !== "archived") return "Only an archived listing can be restored.";
    return null;
};

/**
 * Re-derives the store's denormalised `productCount` from the datastore, as
 * the simulator does after every write (catalog-service.ts:1179). Ratings are
 * deliberately not recomputed — no review repository exists in this milestone
 * — so `ratingAvg`/`ratingCount` are left untouched.
 */
const recomputeStoreCounters = async (sellerId) => {
    const store = await storeRepository.findBySellerId(sellerId);
    if (!store) return;
    const productCount = await productRepository.countLiveForSeller(sellerId);
    await storeRepository.patchById(store._id, { productCount });
};

/**
 * The seller's low-stock ping, ported from `notifyLowStock`
 * (catalog-service.ts:1197): a notification fires only when a balance *crosses*
 * a line, never because a product happens to sit near one — restocking an
 * already-low product back above its alert level says nothing new, and an
 * out-of-stock notice that repeats on every zero delta is noise.
 *
 * `src/services/notification.service.js` cannot be used: it currently fails
 * `node --check` (a stray token at line 6), so the row is written straight to
 * the `Notification` model with exactly the payload that service builds.
 */
const notifyLowStock = async (profile, before, product) => {
    const after = productStock(product);
    const threshold = product.lowStockThreshold ?? 5;
    const crossedLow = before > threshold && after <= threshold && after > 0;
    const crossedOut = before > 0 && after <= 0;
    if (!crossedLow && !crossedOut) return;

    await Notification.create({
        userId: profile.userId,
        type: "seller_low_stock",
        title: crossedOut ? "Product out of stock" : "Low stock alert",
        body: crossedOut
            ? `${product.name} is out of stock. Update the quantity so buyers can order again.`
            : `${product.name} has ${after} unit(s) left, at or below your alert level of ${threshold}.`,
        data: {
            productId: String(product._id),
            sellerId: String(profile._id),
            level: crossedOut ? "out" : "low"
        }
    });
};

/**
 * Saves a product, translating a schema violation into the same 422 a client
 * gets for every other field problem. The validators upstream are what make
 * this a safety net rather than a routine path: by the time a document is
 * written, every rule `validateDraft` owns has already been checked with its
 * human message.
 */
const saveProduct = async (product) => {
    try {
        await product.save();
    } catch (error) {
        if (error?.name !== "ValidationError") throw error;
        const fields = Object.entries(error.errors ?? {}).map(([field, detail]) => ({
            field,
            message: String(detail?.message ?? "This value is not valid.")
        }));
        rejectFields(fields);
    }
};

/**
 * POST /seller/products — validates the draft, then writes it.
 *
 * The status a new listing gets mirrors the simulator (createProduct,
 * catalog-service.ts:734): `draft` when the seller asked to save a draft and
 * `active` otherwise, with `publishedAt` set only when it actually goes live.
 * An empty image list falls back to the simulator's placeholder so a listing
 * can never be image-less (`"Add a name and a photo first."` would then block
 * every attempt to publish it). Stock is the aggregate across variants when
 * the product has them.
 */
const createProductFor = async (profile, draft, shapeErrors = []) => {
    const sellerId = profile._id;
    await rejectInvalidDraft(draft, { sellerId, shapeErrors });

    const store = await storeRepository.findBySellerId(sellerId);
    if (!store) throw storeNotFound();

    const saveAsDraft = draft.saveAsDraft === true;
    const hasVariants = draft.hasVariants === true;

    const product = new Product({
        sellerId,
        storeId: store._id,
        name: draft.name,
        brand: draft.brand,
        categoryId: draft.categoryId,
        subcategoryId: draft.subcategoryId ?? null,
        description: draft.description,
        highlights: draft.highlights,
        images: draft.images.length > 0 ? draft.images : [`p:\u{1F6CD}\u{FE0F}:${draft.name}`],
        video: draft.video ?? null,
        regularPrice: draft.regularPrice,
        salePrice: draft.salePrice ?? null,
        costPrice: draft.costPrice ?? null,
        sku: draft.sku,
        stock: draft.stock ?? 0,
        lowStockThreshold: draft.lowStockThreshold,
        variants: hasVariants ? draft.variants : [],
        hasVariants,
        status: saveAsDraft ? "draft" : "active",
        publishedAt: saveAsDraft ? null : new Date()
    });

    product.stock = productStock(product);
    await saveProduct(product);

    // A draft is not on the shelf, so it does not belong in the store counter.
    if (!saveAsDraft) await recomputeStoreCounters(sellerId);
    return product;
};

/**
 * GET /seller/products — the simulator's `sellerProductList`
 * (catalog-service.ts:962) with the same filter vocabulary, the same
 * substring search over `name brand sku`, the same price band applied to the
 * *effective* price, and the same sorts. Filtering happens before pagination
 * so `total` counts what the filters actually kept.
 *
 * The response is a superset of the storefront client's `{ products }`:
 * `total`, `limit` and `offset` make the page it just asked for explicit.
 */
const listProductsFor = async (profile, options) => {
    let products = await productRepository.findBySeller(profile._id);

    if (options.status && options.status !== "all") {
        if (options.status === "low") products = products.filter((product) => stockLevelOf(product) === "low");
        else if (options.status === "out") products = products.filter((product) => stockLevelOf(product) === "out");
        else products = products.filter((product) => product.status === options.status);
    }

    const search = String(options.search ?? "").trim().toLowerCase();
    if (search) {
        products = products.filter((product) =>
            `${product.name} ${product.brand} ${product.sku}`.toLowerCase().includes(search)
        );
    }

    if (options.categoryId) {
        const wanted = options.categoryId;
        products = products.filter(
            (product) => String(product.categoryId) === wanted || String(product.subcategoryId) === wanted
        );
    }

    if (options.minPrice !== undefined || options.maxPrice !== undefined) {
        const min = options.minPrice ?? 0;
        const max = options.maxPrice ?? Number.POSITIVE_INFINITY;
        products = products.filter((product) => {
            const price = effectivePrice(product);
            return price >= min && price <= max;
        });
    }

    const sorted = [...products];
    switch (options.sort) {
        case "name":
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case "price_asc":
            sorted.sort((a, b) => effectivePrice(a) - effectivePrice(b) || a.name.localeCompare(b.name));
            break;
        case "price_desc":
            sorted.sort((a, b) => effectivePrice(b) - effectivePrice(a) || a.name.localeCompare(b.name));
            break;
        case "stock":
            sorted.sort((a, b) => productStock(a) - productStock(b) || a.name.localeCompare(b.name));
            break;
        default:
            sorted.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }

    const total = sorted.length;
    return { products: sorted.slice(options.offset, options.offset + options.limit), total };
};

/** GET /seller/products/:id — one of the caller's own listings. */
const getProductFor = async (profile, productId) => ownedProduct(profile, productId);

/**
 * PATCH /seller/products/:id — merges the changes into the stored draft.
 *
 * `merged` mirrors the simulator's `updateProduct`: validate what the product
 * *would* look like after the patch (so a rule can be broken by an unchanged
 * neighbour, e.g. a sale price left above a newly lowered regular price), then
 * apply only the keys the caller actually sent. Stock and status are not
 * patchable here — each has its own endpoint — and an empty patch is refused
 * rather than answered with a silent no-op, matching how `PATCH /seller/store`
 * behaves in this codebase (a deviation from the simulator, which would accept
 * it and do nothing).
 *
 * Afterwards stock is re-aggregated and the status re-derived, exactly as the
 * simulator does: editing a name must not resurrect a sold-out listing.
 */
const updateProductFor = async (profile, productId, changes, shapeErrors = []) => {
    const product = await ownedProduct(profile, productId);
    const sellerId = profile._id;

    if (shapeErrors.length === 0 && Object.keys(changes).length === 0) {
        throw new ApiError(422, "No product fields were provided.", [], "", "validation_failed");
    }

    const merged = { ...productDraftFromProduct(product), ...changes };
    await rejectInvalidDraft(merged, { sellerId, exceptId: productId, shapeErrors });

    for (const [key, value] of Object.entries(changes)) {
        product[key] = value;
    }
    product.stock = productStock(product);
    product.status = statusFor(product);

    await saveProduct(product);
    await recomputeStoreCounters(sellerId);
    return product;
};

/**
 * PATCH /seller/products/:id/status — one transition, guarded exactly like a
 * bulk one by `bulkStatusBlock`, so "Already in that state." and "Restock
 * before publishing." read the same however a seller got here. A blocked
 * transition is a 422 whose message *is* the reason (it is a single cause, and
 * it is the sentence the app shows). `publishedAt` is stamped the first time a
 * listing goes live and never moved again.
 */
const setProductStatusFor = async (profile, productId, status) => {
    const product = await ownedProduct(profile, productId);

    const block = bulkStatusBlock(product, status);
    if (block) {
        throw new ApiError(422, block, [{ field: "status", message: block }], "", "validation_failed");
    }

    product.status = status;
    if (status === "active" && !product.publishedAt) product.publishedAt = new Date();

    await saveProduct(product);
    await recomputeStoreCounters(profile._id);
    return product;
};

/**
 * POST /seller/products/:id/stock — the simulator's `adjustStock`
 * (catalog-service.ts:877), step for step.
 *
 * A variant product is never adjusted "in total": its units live in the
 * variants, so the caller must say which one (`Choose the variant you want to
 * update.`) and the id it sends is matched against the variant's `_id` *or*
 * its SKU, so a client may quote either the id the DTO reports or the SKU it
 * typed. Balances
 * clamp at zero rather than going negative, which is why the ledger records
 * `applied` — what actually moved — and not what was asked for.
 *
 * The status is re-derived afterwards, the ledger row is written, the store
 * counter recomputed, and the seller pinged only if a balance crossed a line.
 */
const adjustStockFor = async (profile, productId, { delta, reason, variantId }) => {
    const product = await ownedProduct(profile, productId);

    const before = productStock(product);

    if (variantId) {
        const variant = (product.variants ?? []).find(
            (entry) =>
                productRepository.variantIdOf(entry) === variantId ||
                String(entry.sku ?? "") === variantId
        );
        if (!variant) {
            const message = "That variant no longer exists on this product.";
            throw new ApiError(422, message, [{ field: "variantId", message }], "", "validation_failed");
        }
        variant.stock = Math.max(0, (variant.stock ?? 0) + delta);
    } else if (product.hasVariants && (product.variants ?? []).length > 0) {
        const message = "Choose the variant you want to update.";
        throw new ApiError(422, message, [{ field: "variantId", message }], "", "validation_failed");
    } else {
        product.stock = Math.max(0, (product.stock ?? 0) + delta);
    }

    product.stock = productStock(product);
    product.status = statusFor(product);
    await saveProduct(product);

    const adjustment = await adjustmentRepository.insert({
        productId: product._id,
        sellerId: profile._id,
        variantId: variantId ?? null,
        quantity: product.stock - before,
        reason,
        referenceId: null
    });

    await recomputeStoreCounters(profile._id);
    await notifyLowStock(profile, before, product);

    return { product, adjustment };
};

/**
 * GET /seller/inventory/summary — the shelf as the seller sees it.
 *
 * Archived listings are off the shelf and left out entirely, which is what
 * makes `totalProducts` the count of live rows rather than of everything ever
 * created. Rows sort worst-first (`out` < `low` < `healthy`, then by name) so
 * what needs attention is at the top of the screen without the client having
 * to sort anything.
 */
const inventorySummaryFor = async (profile) => {
    const sellerId = profile._id;
    const store = await storeRepository.findBySellerId(sellerId);
    if (!store) throw storeNotFound();

    const rows = (await productRepository.findBySeller(sellerId))
        .filter((product) => product.status !== "archived")
        .map((product) => ({
            productId: String(product._id),
            name: product.name,
            status: product.status,
            stock: productStock(product),
            lowStockThreshold: product.lowStockThreshold ?? 5,
            level: stockLevelOf(product)
        }));

    const rank = { out: 0, low: 1, healthy: 2 };
    rows.sort((a, b) => rank[a.level] - rank[b.level] || a.name.localeCompare(b.name));

    return {
        sellerId: String(sellerId),
        storeId: String(store._id),
        totalProducts: rows.length,
        activeProducts: rows.filter((row) => row.status === "active").length,
        totalUnits: rows.reduce((sum, row) => sum + row.stock, 0),
        outOfStock: rows.filter((row) => row.level === "out").length,
        lowStock: rows.filter((row) => row.level === "low").length,
        healthy: rows.filter((row) => row.level === "healthy").length,
        rows
    };
};

/**
 * GET /seller/inventory/adjustments — the caller's ledger, newest first,
 * optionally scoped to one product. Scoping is ownership-checked through the
 * product, so asking for someone else's ledger answers the same 404 as asking
 * for their product.
 */
const listAdjustmentsFor = async (profile, { limit, productId }) => {
    if (productId) {
        const product = await ownedProduct(profile, productId);
        const rows = await adjustmentRepository.listForProduct(product._id, limit);
        return rows.map(adjustmentRepository.toAdjustmentDto);
    }

    const rows = await adjustmentRepository.listForSeller(profile._id, limit);
    return rows.map(adjustmentRepository.toAdjustmentDto);
};

export {
    createProductFor,
    listProductsFor,
    getProductFor,
    updateProductFor,
    setProductStatusFor,
    adjustStockFor,
    inventorySummaryFor,
    listAdjustmentsFor
};
