/**
 * Voucher endpoints — HTTP shaping only.
 *
 * Identity comes exclusively from the session: `req.sellerProfile._id` (set by
 * `requireSeller`) owns every `/seller/vouchers*` write and `req.user.id` owns
 * the eligibility read. A voucher id that belongs to another seller never
 * reaches the mutation — `getForSeller` answers 404 `Voucher not found.`,
 * which is also what the simulator shows so an id probe cannot confirm that a
 * foreign voucher exists.
 *
 * `/vouchers/eligible` is the only customer-facing read: it resolves the
 * caller's cart through the shared pricing engine and lets the core
 * (`evaluateVoucherQuotes`, via the voucher service) decide every quote — this
 * file never re-derives a discount or a reason.
 */
import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { Cart } from "../models/cart.model.js";
import { resolveCartGroups, cartTotals } from "../services/cart-pricing.service.js";
import { validateVoucherCreate, validateVoucherUpdate } from "../validators/voucher.validator.js";
import * as voucherService from "../services/voucher.service.js";

// POST /seller/vouchers — scope/sellerId are ours, never the body's.
const createVoucher = asyncHandlers(async (req, res) => {
    const sellerId = req.sellerProfile._id;
    const draft = await validateVoucherCreate(req.body, { sellerId });
    const voucher = await voucherService.createForSeller(sellerId, draft);

    return res.status(201).json(new ApiResponse(201, { voucher: voucherService.toSellerView(voucher) }, "Voucher created."));
});

// GET /seller/vouchers — the caller's own vouchers, newest first.
const listVouchers = asyncHandlers(async (req, res) => {
    const stored = await voucherService.listForSeller(req.sellerProfile._id);
    const vouchers = stored.map((voucher) => voucherService.toSellerView(voucher));

    return res.status(200).json(new ApiResponse(200, { vouchers }, "Vouchers listed."));
});

// GET /seller/vouchers/:id — 404 for a voucher that is not the caller's.
const getVoucher = asyncHandlers(async (req, res) => {
    const voucher = await voucherService.getForSeller(req.sellerProfile._id, req.params.id);

    return res.status(200).json(new ApiResponse(200, { voucher: voucherService.toSellerView(voucher) }, "Voucher retrieved."));
});

// PATCH /seller/vouchers/:id — only the writable columns; code and type are frozen.
const updateVoucher = asyncHandlers(async (req, res) => {
    const sellerId = req.sellerProfile._id;
    const { id } = req.params;

    const existing = await voucherService.getForSeller(sellerId, id);
    const draft = await validateVoucherUpdate(req.body, { sellerId, voucherId: id, existing });
    const updated = await voucherService.updateForSeller(sellerId, id, draft);

    return res.status(200).json(new ApiResponse(200, { voucher: voucherService.toSellerView(updated) }, "Voucher updated."));
});

// DELETE /seller/vouchers/:id — a used voucher is archived, an unused one removed.
const deleteVoucher = asyncHandlers(async (req, res) => {
    const result = await voucherService.deleteForSeller(req.sellerProfile._id, req.params.id);

    if (result.deleted) {
        return res.status(200).json(new ApiResponse(200, { deleted: true }, "Voucher deleted."));
    }
    return res.status(200).json(new ApiResponse(200, { voucher: voucherService.toSellerView(result.voucher) }, "Voucher archived."));
});

// GET /vouchers/eligible — quotes for the caller's own cart, best discount first.
const eligibleVouchers = asyncHandlers(async (req, res) => {
    const userId = req.user.id;

    const cart = await Cart.findOne({ userId });
    const items = cart?.items ?? [];
    if (items.length === 0) {
        return res.status(200).json(new ApiResponse(200, { quotes: [] }, "Eligible vouchers."));
    }

    const groups = await resolveCartGroups(items);
    if (groups.length === 0) {
        return res.status(200).json(new ApiResponse(200, { quotes: [] }, "Eligible vouchers."));
    }

    const totals = cartTotals(groups);
    const { quotes } = await voucherService.eligibleForCart({
        userId,
        groups,
        subtotal: totals.subtotal,
        shippingTotal: totals.shippingTotal
    });

    return res.status(200).json(new ApiResponse(200, { quotes }, "Eligible vouchers."));
});

export { createVoucher, listVouchers, getVoucher, updateVoucher, deleteVoucher, eligibleVouchers };
