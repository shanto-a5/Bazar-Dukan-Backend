import mongoose, { Schema } from "mongoose";

/**
 * One "this user viewed this product" row (M13).
 *
 * Mirrors the simulator's `RecentlyViewedEntry` (`{userId, productId}` on a
 * timestamped entity). Two indexes, each serving one real query:
 *
 *   - unique `{userId, productId}` — the dedupe rule itself. `recordView`
 *     upserts on this pair, so a product the user already saw can never gain
 *     a second row; the existing row moves to the newest position instead.
 *   - `{userId, createdAt}` — the list query: the caller's rows newest-first.
 *
 * `createdAt` is declared here instead of being left entirely to
 * `{ timestamps: true }` on purpose: Mongoose's automatic `createdAt` is
 * `immutable`, and on an upsert an immutable path is relocated into
 * `$setOnInsert` — which would silently break "re-viewing moves the row to
 * the top". Declaring the field keeps it a plain Date (timestamps still stamp
 * it on insert); the upsert is then free to rewrite it to `now`.
 */
const recentlyViewedSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    productId: {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true
    },

    createdAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

recentlyViewedSchema.index({ userId: 1, productId: 1 }, { unique: true });
recentlyViewedSchema.index({ userId: 1, createdAt: -1 });

export const RecentlyViewed = mongoose.model("RecentlyViewed", recentlyViewedSchema);
