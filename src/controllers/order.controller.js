import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import {
    previewCheckout,
    createOrder,
    listOrders,
    getOrderForCustomer,
    cancelOrder,
    listSellerOrders,
    getSellerOrder,
    advanceSellerOrder
} from "../services/order.service.js";

/**
 * Order + checkout controllers.
 *
 * Every handler is thin: identity comes from the session (`req.user.id` for a
 * customer, `req.sellerProfile._id` for a seller — set by `requireSeller`),
 * money and contents are recomputed by the service, and the envelope is the
 * same `ApiResponse` every other Vanta slice returns. No controller here ever
 * trusts a client-supplied total, seller id or price.
 *
 * The imported client pairs with these request/response shapes:
 *   POST /orders        -> { order, sellerOrders, payment, cart }  (201)
 *   GET  /orders        -> { orders }
 *   GET  /orders/:id    -> { order, sellerOrders, payment }
 *   POST /orders/:id/cancel -> the order itself
 *   GET  /seller/orders -> { orders }
 *   GET/POST /seller/orders/:id[/advance] -> the seller order view
 */

const respond = (res, status, data, message) => res.status(status).json(new ApiResponse(status, data, message));

export const preview = asyncHandlers(async (req, res) => {
    const data = await previewCheckout(req.user.id, req.body);
    respond(res, 200, data, "Checkout preview ready.");
});

export const create = asyncHandlers(async (req, res) => {
    // The dedupe key may arrive in the body or the standard `Idempotency-Key`
    // header; the header is preferred when both are present.
    const headerKey = req.header("idempotency-key")?.trim();
    const body = { ...(req.body ?? {}) };
    if (headerKey) body.idempotencyKey = headerKey;

    const receipt = await createOrder(req.user.id, body);
    respond(res, receipt.created ? 201 : 200, receipt, receipt.created ? "Order placed." : "Order already placed.");
});

export const list = asyncHandlers(async (req, res) => {
    const orders = await listOrders(req.user.id);
    respond(res, 200, { orders }, "Orders fetched.");
});

export const detail = asyncHandlers(async (req, res) => {
    const data = await getOrderForCustomer(req.user.id, req.params.id);
    respond(res, 200, data, "Order fetched.");
});

export const cancel = asyncHandlers(async (req, res) => {
    const order = await cancelOrder(req.user.id, req.params.id, req.body?.reason);
    respond(res, 200, order, "Order cancelled.");
});

export const sellerList = asyncHandlers(async (req, res) => {
    const orders = await listSellerOrders(req.sellerProfile._id);
    respond(res, 200, { orders }, "Orders fetched.");
});

export const sellerDetail = asyncHandlers(async (req, res) => {
    const data = await getSellerOrder(req.sellerProfile._id, req.params.id);
    respond(res, 200, data, "Order fetched.");
});

export const advance = asyncHandlers(async (req, res) => {
    const data = await advanceSellerOrder(req.sellerProfile._id, req.params.id);
    respond(res, 200, data, "Order updated.");
});