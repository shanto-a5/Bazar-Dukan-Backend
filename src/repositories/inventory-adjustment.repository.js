import { InventoryAdjustment } from "../models/inventory-adjustment.model.js";

/**
 * Inventory ledger data access.
 *
 * One row is one movement of one sellable unit. `quantity` is signed —
 * positive for a restock or a return, negative when units leave — which is
 * what both the simulator's `InventoryAdjustment` and the seller inventory
 * screen (`seller-ui.tsx` reads `adjustment.quantity`) render. `sellerId` is
 * denormalised on the row so a seller's whole ledger can be listed with one
 * indexed query and never through the product.
 *
 * Newest first, `_id` as the tie-break: within one second two rows can share a
 * timestamp, and `_id` is monotonic, so the ordering a seller sees is stable.
 */
const insert = (doc) => InventoryAdjustment.create(doc);

const listForSeller = (sellerId, limit = 20) =>
    InventoryAdjustment.find({ sellerId }).sort({ createdAt: -1, _id: -1 }).limit(limit);

const listForProduct = (productId, limit = 20) =>
    InventoryAdjustment.find({ productId }).sort({ createdAt: -1, _id: -1 }).limit(limit);

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** The wire shape: `quantity` (signed), `id` as a string, no Mongo internals. */
const toAdjustmentDto = (adjustment) => ({
    id: String(adjustment._id),
    productId: String(adjustment.productId),
    variantId: adjustment.variantId ?? null,
    quantity: adjustment.quantity,
    reason: adjustment.reason,
    referenceId: adjustment.referenceId ?? null,
    sellerId: adjustment.sellerId ? String(adjustment.sellerId) : null,
    createdAt: iso(adjustment.createdAt),
    updatedAt: iso(adjustment.updatedAt)
});

export { insert, listForSeller, listForProduct, toAdjustmentDto };
