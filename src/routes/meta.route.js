import { Router } from "express";
import { getPaymentMethods, getDeliveryMethods, getMediaProviders } from "../controllers/meta.controller.js";

/**
 * Public capability metadata. The path is the FULL one, so the router mounts
 * straight onto the API prefix (`app.use("/api/v1", metaRouter)`).
 *
 * Unauthenticated by design: a shopper is offered "cash on delivery" and
 * "standard delivery" long before an account exists, and an upload form needs
 * to know what media it may send before anyone signs in to sell.
 */
const router = Router();

router.route("/meta/payment-methods").get(getPaymentMethods);
router.route("/meta/delivery-methods").get(getDeliveryMethods);
router.route("/meta/media-providers").get(getMediaProviders);

export default router;
