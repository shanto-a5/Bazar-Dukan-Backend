import mongoose, { Schema } from "mongoose";

/**
 * One "this user follows this store" row (M13).
 *
 * Mirrors the simulator's `StoreFollower` (`{userId, storeId}` on a
 * timestamped entity). Two indexes, each serving one real query:
 *
 *   - unique `{userId, storeId}` — the one-follow-per-pair rule. Following
 *     twice can never create a second row, which is what makes a duplicate
 *     POST a no-op that leaves `store.followerCount` untouched.
 *   - `{storeId}` — the store-side read (`listForStore`), which the compound
 *     index cannot serve: its prefix is `userId`.
 *
 * `followerCount` deliberately does NOT live here: it is the denormalised
 * counter on Store, moved only by the service's atomic `$inc` (follow) and
 * the pipeline update floored at 0 (unfollow).
 */
const storeFollowerSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    storeId: {
        type: Schema.Types.ObjectId,
        ref: "Store",
        required: true
    }
}, { timestamps: true });

storeFollowerSchema.index({ userId: 1, storeId: 1 }, { unique: true });
storeFollowerSchema.index({ storeId: 1 });

export const StoreFollower = mongoose.model("StoreFollower", storeFollowerSchema);
