import { ApiError } from "../utils/ApiError.js";
import { roundMoney } from "../core/money.js";

/**
 * Request validation for the seller catalog surface.
 *
 * Mirrors the simulator's `validateDraft` (`src/services/catalog-service.ts`,
 * lines 201-262) rule for rule and message for message: every sentence below
 * is the exact one a seller already sees in the Vanta app, because these
 * strings are shown to users. All offending fields are collected into one
 * `422 / validation_failed` — a form that reveals one problem per round trip
 * is a bad form.
 *
 * The module stays synchronous and free of queries: the two checks that need
 * the datastore (category existence and per-seller SKU uniqueness) are passed
 * into `validateDraft` by the catalog service as a boolean and a Set. What
 * lives here is everything that can be decided from the payload alone,
 * including the updatable-field whitelist: `stock` and `status` are moved by
 * their own endpoints and are rejected loudly on a product update rather than
 * silently dropped.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value) => (typeof value === "string" ? value : "");

/** Only a real JS number is money; a numeric string stays invalid, as in the simulator. */
const asMoney = (value) => (typeof value === "number" ? roundMoney(value) : value);

/** Reasons a stock adjustment accepts; `restock` is the default. */
const STOCK_REASONS = ["restock", "manual", "cancellation", "return"];

/** The statuses a seller may move a listing to by hand. */
const STATUS_TARGETS = ["active", "paused", "draft", "archived"];

/** The only keys a create payload may carry; everything else is server-owned. */
const CREATE_KEYS = [
    "name",
    "brand",
    "categoryId",
    "subcategoryId",
    "description",
    "highlights",
    "images",
    "regularPrice",
    "salePrice",
    "costPrice",
    "sku",
    "stock",
    "lowStockThreshold",
    "hasVariants",
    "variants",
    "video",
    "saveAsDraft"
];

/** Product fields a seller may patch. `stock` and `status` are deliberately absent. */
const PATCH_KEYS = CREATE_KEYS.filter((key) => key !== "stock" && key !== "saveAsDraft");

/** List-valued fields: a non-list is refused so a bad value can never reach a schema cast. */
const LIST_MESSAGES = {
    highlights: "Enter a list of highlight lines.",
    images: "Enter a list of image links.",
    variants: "Enter a list of variants."
};

const rejectUnknownKeys = (body, allowed, fields) => {
    for (const key of Object.keys(body)) {
        if (allowed.includes(key)) continue;
        fields.push({ field: key, message: `${key} cannot be set from a request.` });
    }
};

const rejectNonLists = (body, fields) => {
    for (const key of Object.keys(LIST_MESSAGES)) {
        if (body[key] !== undefined && !Array.isArray(body[key])) {
            fields.push({ field: key, message: LIST_MESSAGES[key] });
        }
    }
};

const stringList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);

/**
 * The preview video, stored as `{placeholder, uri}` exactly as the product
 * form sends it. An absent video means "no video" (`null`); anything that is
 * not that shape is a field error rather than a silent drop.
 * Returns `{ video, error }` where `error` is a field message or `null`.
 */
const normalizeVideo = (value) => {
    if (value === undefined || value === null) return { video: null, error: null };
    if (typeof value === "string") return { video: value ? { placeholder: "", uri: value } : null, error: null };
    if (isPlainObject(value)) {
        return { video: { placeholder: asString(value.placeholder), uri: asString(value.uri) }, error: null };
    }
    return { video: null, error: "Enter a valid video." };
};

/** One variant entry, normalised the way the embedded schema will store it. */
const normalizeVariant = (variant) => {
    const entry = isPlainObject(variant) ? variant : {};
    // A hydrated document hands us a `Map`, a lean query or a payload a plain
    // object; `{...map}` on a Map yields `{}`, so unwrap it explicitly.
    const rawAttributes = entry.attributes instanceof Map ? Object.fromEntries(entry.attributes)
        : isPlainObject(entry.attributes) ? entry.attributes
        : {};
    const compareAtPrice = typeof entry.compareAtPrice === "number" && Number.isFinite(entry.compareAtPrice) && entry.compareAtPrice > 0
        ? roundMoney(entry.compareAtPrice)
        : null;
    return {
        sku: asString(entry.sku).trim(),
        attributes: { ...rawAttributes },
        price: asMoney(entry.price),
        compareAtPrice,
        stock: entry.stock,
        image: typeof entry.image === "string" ? entry.image : ""
    };
};

/**
 * The draft a create payload describes, with the documented defaults applied
 * (mirrors `ProductDraftInput` + the create endpoint's optionality).
 */
const normalizeProductCreate = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectUnknownKeys(body, CREATE_KEYS, fields);
    rejectNonLists(body, fields);
    const video = normalizeVideo(body.video);
    if (video.error) fields.push({ field: "video", message: video.error });

    const draft = {
        name: asString(body.name),
        brand: asString(body.brand),
        categoryId: asString(body.categoryId),
        subcategoryId: body.subcategoryId === "" || body.subcategoryId === undefined ? null : body.subcategoryId ?? null,
        description: asString(body.description),
        highlights: stringList(body.highlights),
        images: stringList(body.images),
        regularPrice: asMoney(body.regularPrice),
        salePrice: body.salePrice === undefined ? undefined : asMoney(body.salePrice),
        costPrice: body.costPrice === undefined ? undefined : asMoney(body.costPrice),
        sku: asString(body.sku),
        stock: body.stock,
        lowStockThreshold: body.lowStockThreshold === undefined ? 5 : body.lowStockThreshold,
        hasVariants: body.hasVariants === true,
        variants: Array.isArray(body.variants) ? body.variants.map(normalizeVariant) : [],
        video: video.video,
        saveAsDraft: body.saveAsDraft === true
    };

    return { draft, fields };
};

/**
 * The updatable subset of a patch payload. Unknown keys (including
 * `stock`, `status`, `sellerId`, `storeId`, `rating*`, `soldCount`) become
 * field errors so nothing is dropped in silence.
 */
const normalizeProductPatch = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectUnknownKeys(body, PATCH_KEYS, fields);
    rejectNonLists(body, fields);
    const video = normalizeVideo(body.video);
    if (video.error && body.video !== undefined) fields.push({ field: "video", message: video.error });

    const changes = {};
    for (const key of PATCH_KEYS) {
        if (body[key] === undefined) continue;
        if (key === "hasVariants") changes.hasVariants = body.hasVariants === true;
        else if (key === "variants") changes.variants = Array.isArray(body.variants) ? body.variants.map(normalizeVariant) : [];
        else if (key === "highlights" || key === "images") changes[key] = stringList(body[key]);
        else if (key === "regularPrice" || key === "salePrice" || key === "costPrice") changes[key] = asMoney(body[key]);
        else if (key === "subcategoryId") changes.subcategoryId = body.subcategoryId === "" ? null : body.subcategoryId;
        else if (key === "video") changes.video = video.video;
        else changes[key] = body[key];
    }

    return { changes, fields };
};

/**
 * The draft a stored product describes — the patch-side twin of
 * `draftFrom` in the simulator. A stored `null` sale/cost price means
 * "no sale price", so it is presented as `undefined` and never trips the
 * `salePrice` rule on an unrelated update.
 */
const productDraftFromProduct = (product) => ({
    name: product.name ?? "",
    brand: product.brand ?? "",
    categoryId: String(product.categoryId ?? ""),
    subcategoryId: product.subcategoryId ? String(product.subcategoryId) : null,
    description: product.description ?? "",
    highlights: [...(product.highlights ?? [])],
    images: [...(product.images ?? [])],
    regularPrice: product.regularPrice,
    salePrice: product.salePrice ?? undefined,
    costPrice: product.costPrice ?? undefined,
    sku: product.sku ?? "",
    stock: product.stock ?? 0,
    lowStockThreshold: product.lowStockThreshold ?? 5,
    hasVariants: Boolean(product.hasVariants),
    variants: (product.variants ?? []).map((variant) => normalizeVariant(variant))
});

/**
 * The simulator's `validateDraft` (catalog-service.ts:201-262), byte for byte
 * on the messages. `takenSkus` is the seller's other SKUs lowercased;
 * `categoryExists` / `subcategoryExists` carry the datastore results.
 *
 * @returns {Array<{field: string, message: string}>} every offending field.
 */
const validateDraft = (draft, { takenSkus = new Set(), categoryExists = true, subcategoryExists = true } = {}) => {
    const fields = [];

    const name = asString(draft.name).trim();
    if (name.length < 3) fields.push({ field: "name", message: "Enter a product name of at least 3 characters." });
    else if (name.length > 80) fields.push({ field: "name", message: "Keep the product name under 80 characters." });

    if (asString(draft.brand).trim().length < 2) fields.push({ field: "brand", message: "Enter the brand shown on the listing." });

    if (!categoryExists) fields.push({ field: "categoryId", message: "Choose a category." });
    else if (draft.subcategoryId && !subcategoryExists) fields.push({ field: "subcategoryId", message: "Choose a subcategory from the list." });

    if (asString(draft.description).trim().length < 10) fields.push({ field: "description", message: "Describe the product in at least 10 characters." });

    if (!Number.isFinite(draft.regularPrice) || draft.regularPrice <= 0) {
        fields.push({ field: "regularPrice", message: "Enter a regular price greater than 0." });
    }
    if (draft.salePrice !== undefined && draft.salePrice !== null) {
        if (!Number.isFinite(draft.salePrice) || draft.salePrice <= 0) {
            fields.push({ field: "salePrice", message: "Enter a sale price greater than 0, or clear it." });
        } else if (Number.isFinite(draft.regularPrice) && draft.salePrice >= draft.regularPrice) {
            fields.push({ field: "salePrice", message: "The sale price must be lower than the regular price." });
        }
    }
    if (draft.costPrice !== undefined && draft.costPrice !== null && (!Number.isFinite(draft.costPrice) || draft.costPrice <= 0)) {
        fields.push({ field: "costPrice", message: "Enter a cost price greater than 0, or clear it." });
    }

    const sku = asString(draft.sku).trim();
    if (sku.length < 3) fields.push({ field: "sku", message: "Enter a SKU of at least 3 characters." });
    else if (takenSkus.has(sku.toLowerCase())) fields.push({ field: "sku", message: "This SKU is already used by one of your products." });

    if (!Number.isInteger(draft.lowStockThreshold) || draft.lowStockThreshold < 0) {
        fields.push({ field: "lowStockThreshold", message: "Enter a low-stock alert level of 0 or more." });
    }

    if (draft.hasVariants) {
        const variants = Array.isArray(draft.variants) ? draft.variants : [];
        if (variants.length === 0) {
            fields.push({ field: "variants", message: "Add at least one variant." });
        } else {
            const seen = new Set();
            let problem;
            variants.forEach((variant, index) => {
                if (problem) return;
                const label = `Variant ${index + 1}`;
                const entry = isPlainObject(variant) ? variant : {};
                const variantSku = asString(entry.sku).trim();
                const attributes = isPlainObject(entry.attributes) ? entry.attributes : {};
                if (!variantSku) problem = `${label} needs its own SKU.`;
                else if (seen.has(variantSku.toLowerCase())) problem = `${label} repeats a SKU already used by another variant.`;
                else if (!Number.isFinite(entry.price) || entry.price <= 0) problem = `${label} needs a price greater than 0.`;
                else if (!Number.isInteger(entry.stock) || entry.stock < 0) problem = `${label} needs a stock count of 0 or more.`;
                else if (Object.values(attributes).some((value) => typeof value !== "string" || !value.trim())) problem = `${label} has an empty option.`;
                seen.add(variantSku.toLowerCase());
            });
            if (problem) fields.push({ field: "variants", message: problem });
        }
    } else if (!Number.isInteger(draft.stock) || draft.stock < 0) {
        fields.push({ field: "stock", message: "Enter a stock count of 0 or more." });
    }

    return fields;
};

/** Validates the target of `PATCH /seller/products/:id/status`. */
const validateStatusInput = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectUnknownKeys(body, ["status"], fields);
    if (!STATUS_TARGETS.includes(body.status)) {
        fields.push({ field: "status", message: "Choose a valid listing status." });
    }
    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return body.status;
};

/**
 * Validates `POST /seller/products/:id/stock`: a non-zero whole-number delta
 * (the simulator's single sentence covers both a fraction and a zero) and a
 * known reason, defaulting to `restock`.
 *
 * The movement may be named `delta` — the simulator's `adjustStock` parameter,
 * and what this endpoint's rule comes from — or `quantity`, which is what the
 * storefront's own API client sends (`vanta-api.ts`). Whichever the caller
 * used is the field a rejection is reported under.
 */
const validateStockInput = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectUnknownKeys(body, ["delta", "quantity", "variantId", "reason"], fields);
    const deltaField = body.delta !== undefined ? "delta" : body.quantity !== undefined ? "quantity" : "delta";
    const delta = body[deltaField];
    if (!Number.isInteger(delta) || delta === 0) {
        fields.push({ field: deltaField, message: "Enter a whole number of units to add or remove." });
    }
    const reason = body.reason === undefined ? "restock" : body.reason;
    if (!STOCK_REASONS.includes(reason)) {
        fields.push({ field: "reason", message: "Choose a valid reason for this adjustment." });
    }
    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    const variantId = body.variantId === undefined || body.variantId === null || body.variantId === ""
        ? null
        : String(body.variantId);

    return { delta, reason, variantId };
};

const pageLimit = (value, fields) => {
    if (value === undefined || value === "") return 20;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
        fields.push({ field: "limit", message: "Enter a page size between 1 and 100." });
        return 20;
    }
    return parsed;
};

/** `GET /seller/products` — pagination, price band and filter options. */
const validateProductListQuery = (query) => {
    const fields = [];

    const limit = pageLimit(query.limit, fields);

    let offset = 0;
    if (query.offset !== undefined && query.offset !== "") {
        const parsed = Number(query.offset);
        if (!Number.isInteger(parsed) || parsed < 0) fields.push({ field: "offset", message: "Enter an offset of 0 or more." });
        else offset = parsed;
    }

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
        // An unknown status value filters literally and simply matches
        // nothing — the simulator's `sellerProductList` behaves the same.
        status: typeof query.status === "string" && query.status !== "" ? query.status : "all",
        search: typeof query.search === "string" ? query.search : "",
        categoryId: typeof query.categoryId === "string" && query.categoryId !== "" ? query.categoryId : null,
        minPrice,
        maxPrice,
        // An unknown sort silently falls back to newest-first, again as the
        // simulator's switch does.
        sort: typeof query.sort === "string" && query.sort !== "" ? query.sort : "default",
        limit,
        offset
    };
};

/** `GET /seller/inventory/adjustments` — limit and the optional product scope. */
const validateAdjustmentQuery = (query) => {
    const fields = [];
    const limit = pageLimit(query.limit, fields);
    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return {
        limit,
        productId: typeof query.productId === "string" && query.productId !== "" ? query.productId : null
    };
};

export {
    validationError,
    isPlainObject,
    normalizeProductCreate,
    normalizeProductPatch,
    productDraftFromProduct,
    validateDraft,
    validateStatusInput,
    validateStockInput,
    validateProductListQuery,
    validateAdjustmentQuery
};
