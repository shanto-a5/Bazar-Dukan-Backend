import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller } from "../middlewares/authz.middleware.js";
import {
    createProduct,
    listProducts,
    getProduct,
    updateProduct,
    setProductStatus,
    adjustStock,
    getInventorySummary,
    listInventoryAdjustments
} from "../controllers/seller-product.controller.js";

/**
 * Seller catalog routes. The paths are the FULL ones (`/seller/products`,
 * `/seller/inventory/summary`, …) so the router mounts straight onto the API
 * prefix (`app.use("/api/v1", sellerProductRouter)`) without a hidden segment,
 * exactly like `seller.route.js` and `category.route.js`.
 *
 * Every route is guarded the same way: `authenticate` reads the session, then
 * `requireSeller` resolves it to an active `SellerProfile` and attaches it as
 * `req.sellerProfile`. Ownership of an individual product is checked inside
 * the service, where a listing that is not the caller's answers the same 404
 * as one that does not exist.
 *
 * `/seller/inventory/*` sits beside `/seller/products` rather than under it
 * because it is a different resource — the ledger and its roll-up — and that
 * is the shape both the storefront client and the reference API use.
 */
const router = Router();

// the catalog: create and list, then one product's read/update/status/stock
router
    .route("/seller/products")
    .get(authenticate, requireSeller, listProducts)
    .post(authenticate, requireSeller, createProduct);

router
    .route("/seller/products/:id")
    .get(authenticate, requireSeller, getProduct)
    .patch(authenticate, requireSeller, updateProduct);

router.route("/seller/products/:id/status").patch(authenticate, requireSeller, setProductStatus);
router.route("/seller/products/:id/stock").post(authenticate, requireSeller, adjustStock);

// the inventory roll-up and the ledger behind it
router.route("/seller/inventory/summary").get(authenticate, requireSeller, getInventorySummary);
router.route("/seller/inventory/adjustments").get(authenticate, requireSeller, listInventoryAdjustments);

export default router;
