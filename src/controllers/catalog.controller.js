import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import {
    listStorefrontProducts,
    getStorefrontProduct,
    getStorefrontStore,
    getCatalogSummary
} from "../services/catalog.query.service.js";

/**
 * The four public catalog reads.
 *
 * Their only job is the envelope: the query service decides what is visible and
 * how it is ordered, the controller decides the status line, the human message
 * and — for the list — which of the two reading dialects the payload carries.
 *
 * The list answers BOTH names for the same rows because the contract does:
 * `ProductPage` in `vanta-api.ts` reads `items`/`total`/`page`/`pageSize`, while
 * the documented endpoint and the sibling `/seller/products` answer
 * `products`/`total`/`limit`/`offset`. One array, referenced twice, so a caller
 * holding either dictionary works without a second endpoint.
 *
 * Nothing here authenticates: a browse is what an anonymous visitor does, and
 * the visibility rule already lives in the service.
 */

// GET /catalog/products — the storefront list, filtered before it is paginated.
const listProducts = asyncHandlers(async (req, res) => {
    const page = await listStorefrontProducts(req.query);

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                items: page.products,
                products: page.products,
                total: page.total,
                page: page.page,
                pageSize: page.pageSize,
                limit: page.limit,
                offset: page.offset
            },
            "Products."
        )
    );
});

// GET /catalog/products/:id — one product with the store and price it needs.
const getProduct = asyncHandlers(async (req, res) => {
    const detail = await getStorefrontProduct(req.params.id);

    return res.status(200).json(new ApiResponse(200, detail, "Product."));
});

// GET /catalog/stores/:sellerOrStoreId — a storefront header and its shelf.
const getStore = asyncHandlers(async (req, res) => {
    const storeSummary = await getStorefrontStore(req.params.sellerOrStoreId);

    return res.status(200).json(new ApiResponse(200, storeSummary, "Store."));
});

// GET /catalog/summary — the marketplace counters, root keys for `CatalogSummary`.
const getSummary = asyncHandlers(async (req, res) => {
    const summary = await getCatalogSummary();

    // The storefront reads the counters off the root of `data` (typed as
    // `CatalogSummary`); `summary` carries the named object the endpoint is
    // documented as returning. Same numbers, both spellings.
    return res.status(200).json(new ApiResponse(200, { summary, ...summary }, "Catalog summary."));
});

export { listProducts, getProduct, getStore, getSummary };
