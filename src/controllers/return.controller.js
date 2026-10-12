import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import {
    createReturnsForOrder,
    listReturnsForCustomer,
    listReturnsForOrder,
    listReturnsForSeller,
    getReturnForSeller,
    decideReturnForSeller,
    markReturnedForSeller
} from "../services/return.service.js";

/**
 * Returns + refunds controllers (slice "returns + refunds", milestone M12).
 *
 * Every handler is thin: identity comes from the session (`req.user.id` for a
 * customer, `req.sellerProfile._id` for a seller — set by `requireSeller`),
 * eligibility, money and state transitions are the service's job, and the
 * envelope is the same `ApiResponse` every other Vanta slice returns.
 *
 * Request/response shapes:
 *   POST /orders/:id/returns          -> { returns }   (201, one per requested line)
 *   GET  /orders/:id/returns          -> { returns }
 *   GET  /returns                     -> { returns }   (the caller's own)
 *   GET  /seller/returns[?status=]    -> { returns }
 *   GET  /seller/returns/:id          -> the return itself
 *   POST /seller/returns/:id/approve  -> the return itself
 *   POST /seller/returns/:id/reject   -> the return itself
 *   POST /seller/returns/:id/returned -> the return itself
 */

const respond = (res, status, data, message) => res.status(status).json(new ApiResponse(status, data, message));

export const create = asyncHandlers(async (req, res) => {
    const returns = await createReturnsForOrder(req.user.id, req.params.id, req.body);
    respond(res, 201, { returns }, "Return requested.");
});

export const listForOrder = asyncHandlers(async (req, res) => {
    const returns = await listReturnsForOrder(req.user.id, req.params.id);
    respond(res, 200, { returns }, "Returns fetched.");
});

export const listMine = asyncHandlers(async (req, res) => {
    const returns = await listReturnsForCustomer(req.user.id);
    respond(res, 200, { returns }, "Returns fetched.");
});

export const sellerList = asyncHandlers(async (req, res) => {
    const returns = await listReturnsForSeller(req.sellerProfile._id, req.query.status);
    respond(res, 200, { returns }, "Returns fetched.");
});

export const sellerDetail = asyncHandlers(async (req, res) => {
    const request = await getReturnForSeller(req.sellerProfile._id, req.params.id);
    respond(res, 200, request, "Return fetched.");
});

export const approve = asyncHandlers(async (req, res) => {
    const request = await decideReturnForSeller(req.sellerProfile._id, req.params.id, true);
    respond(res, 200, request, "Return approved.");
});

export const reject = asyncHandlers(async (req, res) => {
    const request = await decideReturnForSeller(req.sellerProfile._id, req.params.id, false);
    respond(res, 200, request, "Return rejected.");
});

export const markReturned = asyncHandlers(async (req, res) => {
    const request = await markReturnedForSeller(req.sellerProfile._id, req.params.id);
    respond(res, 200, request, "Return processed.");
});
