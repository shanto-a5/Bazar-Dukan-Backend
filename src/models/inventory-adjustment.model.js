import mongoose, { Schema } from "mongoose";

/**
 * An inventory ledger entry: one stock movement for one sellable unit.
 *
 * Every change to a product's (or a variant's) stock balance is recorded here
 * with its `quantity` (signed: negative for a `sale`, positive for a
 * `restock`/`return`) and its `reason`, so stock can always be audited back to
 * what moved it. `referenceId` cross-links the movement to the order or return
 * that caused it when one exists; `sellerId` is denormalised so the seller's
 * ledger can be listed without joining through the product.
 *
 * Stock is applied by services (decrement at order placement, increment on
 * cancellation/return), never by schema hooks.
 */
const inventoryAdjustmentSchema = new Schema({
    productId: {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true
    },

    variantId: {
        type: String,
        default: null
    },

    quantity: {
        type: Number,
        required: true
    },

    reason: {
        type: String,
        enum: ["sale", "restock", "manual", "cancellation", "return"],
        required: true
    },

    referenceId: {
        type: String,
        default: null
    },

    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        default: null
    }
}, { timestamps: true });

inventoryAdjustmentSchema.index({ productId: 1, createdAt: -1 });
inventoryAdjustmentSchema.index({ sellerId: 1, createdAt: -1 });

export const InventoryAdjustment = mongoose.model("InventoryAdjustment", inventoryAdjustmentSchema);