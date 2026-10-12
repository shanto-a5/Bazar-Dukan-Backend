import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import {
    normalizeProductCreate,
    normalizeProductPatch,
    validateStatusInput,
    validateStockInput,
    validateProductListQuery,
    validateAdjustmentQuery
} from "../validators/product.validator.js";
import {
    createProductFor,
    listProductsFor,
    getProductFor,
    updateProductFor,
    setProductStatusFor,
    adjustStockFor,
    inventorySummaryFor,
    listAdjustmentsFor
} from "../services/catalog.service.js";
import { toProductDto } from "../repositories/product.repository.js";

/**
 * The seller catalog surface: eight endpoints over `catalog.service`.
 *
 * The split with the validator is deliberate. Everything that can be decided
 * from the payload alone — normalising the draft, rejecting a key the request
 * may not set, checking a number is a number — runs here, synchronously and
 * without I/O; anything that needs the datastore (does this category exist, is
 * this SKU taken, is this product mine) belongs to the service, which merges
 * both into ONE 422. The controller's remaining job is the envelope: it picks
 * the status code and the message, and it decides whether the payload is
 * wrapped (`{ product }`) or served bare (the status, stock and summary reads
 * answer with the entity itself, the way the reference API does).
 *
 * Identity is `req.sellerProfile`, resolved from the session by
 * `requireSeller` — never anything the body could name.
 */
const createProduct = asyncHandlers(async (req, res) => {
    const { draft, fields } = normalizeProductCreate(req.body);
    const product = await createProductFor(req.sellerProfile, draft, fields);

    return res.status(201).json(new ApiResponse(201, { product: toProductDto(product) }, "Product created."));
});

const listProducts = asyncHandlers(async (req, res) => {
    const options = validateProductListQuery(req.query);
    const { products, total } = await listProductsFor(req.sellerProfile, options);

    return res.status(200).json(
        new ApiResponse(
            200,
            { products: products.map(toProductDto), total, limit: options.limit, offset: options.offset },
            "Products."
        )
    );
});

const getProduct = asyncHandlers(async (req, res) => {
    const product = await getProductFor(req.sellerProfile, req.params.id);

    return res.status(200).json(new ApiResponse(200, { product: toProductDto(product) }, "Product."));
});

const updateProduct = asyncHandlers(async (req, res) => {
    const { changes, fields } = normalizeProductPatch(req.body);
    const product = await updateProductFor(req.sellerProfile, req.params.id, changes, fields);

    return res.status(200).json(new ApiResponse(200, { product: toProductDto(product) }, "Product updated."));
});

const setProductStatus = asyncHandlers(async (req, res) => {
    const status = validateStatusInput(req.body);
    const product = await setProductStatusFor(req.sellerProfile, req.params.id, status);

    return res.status(200).json(new ApiResponse(200, toProductDto(product), "Product status updated."));
});

const adjustStock = asyncHandlers(async (req, res) => {
    const input = validateStockInput(req.body);
    const { product } = await adjustStockFor(req.sellerProfile, req.params.id, input);

    return res.status(200).json(new ApiResponse(200, toProductDto(product), "Stock updated."));
});

const getInventorySummary = asyncHandlers(async (req, res) => {
    const summary = await inventorySummaryFor(req.sellerProfile);

    return res.status(200).json(new ApiResponse(200, summary, "Inventory summary."));
});

const listInventoryAdjustments = asyncHandlers(async (req, res) => {
    const options = validateAdjustmentQuery(req.query);
    const adjustments = await listAdjustmentsFor(req.sellerProfile, options);

    return res.status(200).json(new ApiResponse(200, { adjustments }, "Inventory adjustments."));
});

export {
    createProduct,
    listProducts,
    getProduct,
    updateProduct,
    setProductStatus,
    adjustStock,
    getInventorySummary,
    listInventoryAdjustments
};
