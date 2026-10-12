import mongoose, { Schema } from "mongoose";

/**
 * The per-user wishlist (M13).
 *
 * One document per user (`userId` is unique); the contents live in `items`.
 * Each item is a handle into the live catalog: `productId` plus the moment it
 * was added. Items are keyed by product in the client spec
 * (`Wishlist.items: { productId, addedAt }[]`), so subdocuments keep their
 * opaque Mongo `_id` but the wire shape never exposes it — the list is rebuilt
 * from the catalog on every read, pruning products that no longer exist.
 */
const wishlistItemSchema = new Schema({
    productId: {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true
    },

    addedAt: {
        type: Date,
        required: true,
        default: Date.now
    }
});

const wishlistSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true
    },

    items: {
        type: [wishlistItemSchema],
        default: []
    }
}, { timestamps: true });

export const Wishlist = mongoose.model("Wishlist", wishlistSchema);