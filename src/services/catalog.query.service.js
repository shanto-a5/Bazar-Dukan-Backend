import mongoose from "mongoose";
import { Product } from "../models/product.model.js";
import { Store } from "../models/store.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Category } from "../models/category.model.js";
import { ApiError } from "../utils/ApiError.js";
import {
    customerVisibility,
    productIsAvailable,
    effectivePrice,
    productStock
} from "../core/catalog-rules.js";
import { roundMoney } from "../core/money.js";
import { toProductDto } from "../repositories/product.repository.js";
import { toStoreDto } from "./seller.service.js";
import { validationError } from "../validators/product.validator.js";

/**
 * Public storefront reads (M12 — "public browse + meta").
 *
 * The four queries behind `/catalog/products`, `/catalog/products/:id`,
 * `/catalog/stores/:sellerOrStoreId` and `/catalog/summary`. Every one of them
 * is unauthenticated and every one of them goes through the SAME rule the app
 * runs — `customerVisibility` from `core/catalog-rules.js` — so a listing the
 * device would hide (a draft, a paused row, an `out_of_stock` status, a paused
 * store, a pending or suspended seller) is hidden here too, byte for byte.
 *
 * Three seams are worth naming up front:
 *
 *   Visibility is status-first, stock-second. The simulator's storefront query
 *   defaults to `status === 'active'` and `productIsVisibleToCustomer` opens
 *   with the same test, so a row whose *status* is `out_of_stock` (the derived
 *   state the inventory services write) never reaches a buyer, while a row that
 *   is still `active` with a zero balance stays on the shelf showing "out of
 *   stock" — stock is a display concern, status is the gate.
 *
 *   Filtering happens in memory, before pagination, exactly as the simulator's
 *   repository-backed `catalogService.query` does: Mongo only narrows to
 *   `status: 'active'` (an indexed prefix), then search / category / price /
 *   sort run over the loaded set. `total` therefore counts what the filters
 *   actually kept, never the page.
 *
 *   Store resolution answers "store id, else seller profile id, else user id",
 *   and only an ACTIVE store with an ACTIVE seller is public: a store that is
 *   awaiting review or paused is a 404, because a public endpoint must not be
 *   the place a shopper learns either fact.
 */

const productNotFound = () => new ApiError(404, "Product not found.", [], "", "not_found");
const storeNotFound = () => new ApiError(404, "Store not found.", [], "", "not_found");

const isValidId = (value) => mongoose.isValidObjectId(value);

/** A query value is only text when it really is one; anything else is absent. */
const text = (value) => (typeof value === "string" ? value.trim() : "");

/** The storefront's sortable vocabulary — the simulator's `ProductQuery.sort`. */
const SORT_KEYS = ["relevance", "newest", "popularity", "price_asc", "price_desc", "rating"];

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * The lookups `customerVisibility` needs, resolved once from the product set so
 * the filter never issues its own queries (same shape cart-pricing builds).
 */
const lookupsFor = async (products) => {
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

/** The customer-visible subset of a product set, in one round trip each. */
const visibleOnly = async (products) => {
    if (products.length === 0) return [];
    const lookups = await lookupsFor(products);
    return products.filter((product) => customerVisibility(product, lookups).visible);
};

/**
 * A category and its direct children — the same one-level roll-up the
 * simulator's `categoryAndChildrenIds` does, so browsing a parent also matches
 * everything filed under its subcategory.
 */
const categoryAndChildrenIds = async (categoryId) => {
    const rows = await Category.find({});
    const ids = [String(categoryId)];
    for (const row of rows) {
        if (String(row.parentId ?? "") === String(categoryId)) ids.push(String(row._id));
    }
    return ids;
};

/** Creation order — what the simulator's `relevance` default leaves untouched. */
const byCreation = (left, right) => String(left._id).localeCompare(String(right._id));

/**
 * The simulator's sort switch (catalog-service.ts:445-470), comparator for
 * comparator, applied AFTER creation order so equal keys stay deterministic.
 */
const COMPARATORS = {
    price_asc: (left, right) => effectivePrice(left) - effectivePrice(right),
    price_desc: (left, right) => effectivePrice(right) - effectivePrice(left),
    rating: (left, right) =>
        (right.ratingAvg ?? 0) - (left.ratingAvg ?? 0) || (right.ratingCount ?? 0) - (left.ratingCount ?? 0),
    newest: (left, right) =>
        new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime(),
    popularity: (left, right) =>
        Number(productIsAvailable(right)) - Number(productIsAvailable(left)) ||
        (right.soldCount ?? 0) - (left.soldCount ?? 0) ||
        (right.viewCount ?? 0) - (left.viewCount ?? 0)
};

const sortRows = (rows, sort) => {
    rows.sort(byCreation);
    const compare = COMPARATORS[sort];
    if (compare) rows.sort(compare);
    return rows;
};

/** The same haystack the simulator searches: name, brand, description, SKU. */
const searchHaystack = (product) =>
    `${product.name ?? ""} ${product.brand ?? ""} ${product.description ?? ""} ${product.sku ?? ""}`.toLowerCase();

/**
 * `GET /catalog/products` input.
 *
 * Both pagination dialects are accepted because both exist in the contract:
 * `limit`/`offset` (the house style, and what `/seller/products` answers) and
 * `page`/`pageSize` (what `vanta-api.ts` sends). `limit`/`offset` win when both
 * are present, and an out-of-range size is ONE 422 listing every offending
 * field — the same answer the seller list gives for the same mistake.
 */
const parseProductListQuery = (rawQuery) => {
    const query = rawQuery ?? {};
    const fields = [];

    let limit = DEFAULT_LIMIT;
    const rawSize = query.limit ?? query.pageSize;
    if (rawSize !== undefined && rawSize !== "") {
        const parsed = Number(rawSize);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
            fields.push({ field: "limit", message: "Enter a page size between 1 and 100." });
        } else {
            limit = parsed;
        }
    }

    let offset = null;
    if (query.offset !== undefined && query.offset !== "") {
        const parsed = Number(query.offset);
        if (!Number.isInteger(parsed) || parsed < 0) {
            fields.push({ field: "offset", message: "Enter an offset of 0 or more." });
        } else {
            offset = parsed;
        }
    }

    let requestedPage = null;
    if (query.page !== undefined && query.page !== "") {
        const parsed = Number(query.page);
        if (!Number.isInteger(parsed) || parsed < 1) {
            fields.push({ field: "page", message: "Enter a page of 1 or more." });
        } else {
            requestedPage = parsed;
        }
    }
    if (offset === null) offset = requestedPage === null ? 0 : (requestedPage - 1) * limit;

    const priceBound = (key) => {
        if (query[key] === undefined || query[key] === "") return undefined;
        const parsed = Number(query[key]);
        if (!Number.isFinite(parsed) || parsed < 0) {
            fields.push({ field: key, message: "Enter a valid price." });
            return undefined;
        }
        return parsed;
    };
    const minPrice = priceBound("minPrice");
    const maxPrice = priceBound("maxPrice");

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return {
        search: text(query.search),
        categoryId: text(query.category) || text(query.categoryId),
        subcategoryId: text(query.subcategory) || text(query.subcategoryId),
        sellerId: text(query.sellerId),
        storeId: text(query.storeId),
        brand: text(query.brand),
        minPrice,
        maxPrice,
        // An unknown sort falls back to the default, as the simulator's
        // switch does rather than rejecting the request.
        sort: SORT_KEYS.includes(query.sort) ? query.sort : "relevance",
        limit,
        offset,
        page: Math.floor(offset / limit) + 1
    };
};

/**
 * GET /catalog/products — the storefront list.
 *
 * Only customer-visible products are considered, and `total` is the count
 * AFTER every filter, so a page is a window over what the caller actually
 * asked for.
 */
const listStorefrontProducts = async (rawQuery) => {
    const options = parseProductListQuery(rawQuery);

    let filtered = await visibleOnly(await Product.find({ status: "active" }));

    if (options.categoryId) {
        const ids = await categoryAndChildrenIds(options.categoryId);
        filtered = filtered.filter(
            (product) =>
                ids.includes(String(product.categoryId)) || ids.includes(String(product.subcategoryId ?? ""))
        );
    }
    if (options.subcategoryId) {
        filtered = filtered.filter((product) => String(product.subcategoryId ?? "") === options.subcategoryId);
    }
    if (options.sellerId) {
        filtered = filtered.filter((product) => String(product.sellerId) === options.sellerId);
    }
    if (options.storeId) {
        filtered = filtered.filter((product) => String(product.storeId) === options.storeId);
    }
    if (options.brand) {
        const wanted = options.brand.toLowerCase();
        filtered = filtered.filter((product) => String(product.brand ?? "").toLowerCase() === wanted);
    }
    if (options.search) {
        const needle = options.search.toLowerCase();
        filtered = filtered.filter((product) => searchHaystack(product).includes(needle));
    }
    if (options.minPrice !== undefined) {
        filtered = filtered.filter((product) => effectivePrice(product) >= options.minPrice);
    }
    if (options.maxPrice !== undefined) {
        filtered = filtered.filter((product) => effectivePrice(product) <= options.maxPrice);
    }

    sortRows(filtered, options.sort);

    const total = filtered.length;
    const rowsForPage = filtered.slice(options.offset, options.offset + options.limit);

    return {
        products: rowsForPage.map(toProductDto),
        total,
        limit: options.limit,
        offset: options.offset,
        page: options.page,
        pageSize: options.limit
    };
};

/**
 * GET /catalog/products/:id — one listing plus what its detail screen needs.
 *
 * Anything a buyer may not see answers the same 404 as an id that never
 * existed, so the endpoint cannot be used to probe for drafts. `visible` stays
 * `true` by construction: a non-visible product never gets a payload.
 */
const getStorefrontProduct = async (productId) => {
    if (!isValidId(productId)) throw productNotFound();

    const product = await Product.findById(productId);
    if (!product) throw productNotFound();

    const store = (await Store.findById(product.storeId)) ?? (await Store.findOne({ sellerId: product.sellerId }));
    const seller = await SellerProfile.findById(product.sellerId);

    const lookups = {
        getStoreById: () => store,
        getStoreBySellerId: () => store,
        getSellerById: () => seller
    };
    if (!customerVisibility(product, lookups).visible) throw productNotFound();

    return {
        product: toProductDto(product),
        store: store ? toStoreDto(store) : null,
        // The public projection of a seller: the identity a storefront shows.
        // The full profile carries national id and bank details and is never
        // part of a public read.
        seller: seller ? toPublicSellerDto(seller) : null,
        effectivePrice: roundMoney(effectivePrice(product)),
        availableStock: productStock(product),
        visible: true
    };
};

/** What a public response may say about a seller: identity, not paperwork. */
const toPublicSellerDto = (seller) => ({
    id: String(seller._id),
    fullName: seller.fullName,
    status: seller.status,
    sellerType: seller.sellerType
});

/**
 * Resolves `/catalog/stores/:sellerOrStoreId` for a store id, a seller profile
 * id or the seller's user id, in that order. A value that is not even an id
 * short-circuits to `null` so a malformed path segment is a 404 and never a
 * CastError.
 */
const resolveStoreDocument = async (value) => {
    if (!isValidId(value)) return null;

    const byId = await Store.findById(value);
    if (byId) return byId;

    const bySellerId = await Store.findOne({ sellerId: value });
    if (bySellerId) return bySellerId;

    const profile = (await SellerProfile.findById(value)) ?? (await SellerProfile.findOne({ userId: value }));
    if (!profile) return null;

    return Store.findOne({ sellerId: profile._id });
};

/**
 * GET /catalog/stores/:sellerOrStoreId — the storefront header and the shelf
 * behind it.
 *
 * The payload is a superset that satisfies both readers of this endpoint: the
 * store's own fields sit at the root with the `seller` pick and the live
 * `productCount` (what `vanta-api.ts` types as `StoreSummary`), while `store`
 * and `products` carry the same record and its customer-visible listings for
 * callers that read a wrapped shape.
 *
 * `productCount` is counted from the datastore rather than trusting the
 * denormalised column, so it can never advertise listings the list endpoint
 * would refuse to serve.
 */
const getStorefrontStore = async (value) => {
    const store = await resolveStoreDocument(value);
    if (!store || store.status !== "active") throw storeNotFound();

    const seller = await SellerProfile.findById(store.sellerId);
    if (!seller || seller.status !== "active") throw storeNotFound();

    const rows = await Product.find({
        $or: [{ storeId: store._id }, { sellerId: store.sellerId }],
        status: "active"
    });
    const products = sortRows(await visibleOnly(rows), "relevance");
    const productCount = products.length;

    const storeDto = toStoreDto(store);
    return {
        ...storeDto,
        productCount,
        seller: toPublicSellerDto(seller),
        store: { ...storeDto, productCount },
        products: products.map(toProductDto)
    };
};

/**
 * GET /catalog/summary — the marketplace roll-up in the shape
 * `vanta-api.ts` types as `CatalogSummary`.
 *
 * `productCount` counts every listing a seller ever created and `activeCount`
 * the live ones among them (the reference API answers the same way); no
 * product body leaves the server here, only counts.
 */
const getCatalogSummary = async () => {
    const [productCount, activeCount, storeCount, sellerCount, categoryCount] = await Promise.all([
        Product.countDocuments({}),
        Product.countDocuments({ status: "active" }),
        Store.countDocuments({}),
        SellerProfile.countDocuments({}),
        Category.countDocuments({})
    ]);

    return { productCount, activeCount, storeCount, sellerCount, categoryCount };
};

export {
    parseProductListQuery,
    listStorefrontProducts,
    getStorefrontProduct,
    getStorefrontStore,
    getCatalogSummary,
    toPublicSellerDto
};
