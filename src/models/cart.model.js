import mongoose, { Schema } from "mongoose";

/**
 * The per-user shopping cart.
 *
 * One document per user (`userId` is unique); the contents live in `items`.
 * Each line is an address into the live catalog plus a snapshot of the price
 * the user first saw (`priceSnapshot`), so the cart view is stable even if a
 * price changes before checkout. `selected` marks lines the user wants to
 * order — unselected lines are kept but excluded from totals.

 * `variantId` is a string, not a reference, because variants are embedded
 * inside the product document; `variantAttributes` mirrors the variant the
 * customer picked. Stock is never reserved here: checkout re-validates
 * quantities and decrements at order creation only.
 */
const cartItemSchema = new Schema({
    productId: {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true
    },

    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        required: true
    },

    variantId: {
        type: String,
        default: null
    },

    variantAttributes: {
        type: Schema.Types.Mixed,
        default: null
    },

    quantity: {
        type: Number,
        default: 1,
        min: 1
    },

    selected: {
        type: Boolean,
        default: true
    },

    priceSnapshot: {
        type: Number,
        default: 0,
        min: 0
    },

    addedAt: {
        type: Date,
        default: Date.now
    },

    updatedAt: {
        type: Date,
        default: null
    }
});

const cartSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true
    },

    items: {
        type: [cartItemSchema],
        default: []
    }
}, { timestamps: true });

export const Cart = mongoose.model("Cart", cartSchema);