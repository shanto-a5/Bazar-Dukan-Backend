import { Router } from "express";
import { listProducts, getProduct, getStore, getSummary } from "../controllers/catalog.controller.js";

/**
 * Public storefront catalog routes. The path is the FULL one, so the router
 * mounts straight onto the API prefix (`app.use("/api/v1", catalogRouter)`).
 *
 * No `authenticate`, no `requireSeller`: these four reads are what an anonymous
 * visitor does, and the visibility rule that keeps drafts, paused rows and
 * inactive sellers off the shelf is enforced in the query service instead —
 * the same rule the app itself runs, so a shelf the device hides never has to
 * be hidden again at the edge.
 *
 * `/catalog/categories` is NOT here — `category.route.js` already owns it.
 */
const router = Router();

router.route("/catalog/products").get(listProducts);
router.route("/catalog/products/:id").get(getProduct);
router.route("/catalog/stores/:sellerOrStoreId").get(getStore);
router.route("/catalog/summary").get(getSummary);

export default router;
