import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { Store } from "../models/store.model.js";
import { toStoreDto } from "./seller.service.js";
import { storeFollowerRepository } from "../repositories/store-follower.repository.js";

/**
 * Store-follow domain rules, mirroring `src/services/seller-service.ts`
 * (`setFollow`, `isFollowing`, `followedStores`).
 *
 * - Every endpoint answers the DESIRED state like `setFollow` does:
 *   `following` is what the caller asked for — a duplicate follow is a no-op
 *   that still answers `true` — and `followerCount` is re-read after the write.
 * - `followerCount` is denormalised on Store and moves only through atomic
 *   operators: `$inc` on a FIRST follow (the unique `{userId, storeId}` index
 *   gates it — a duplicate insert returns `false` and changes nothing), and an
 *   aggregation-pipeline update on unfollow that floors the result at 0
 *   (`$max: [0, {$add: [{$ifNull: ['$followerCount', 0]}, -1]}]`), so a
 *   double unfollow, a race, or a drifted count can never go negative. The
 *   no-op paths (nothing deleted / already following) never touch the count.
 * - The store must exist (404 "Store not found.", a malformed id included —
 *   the observable behaviour the simulator gives a missing store), but the
 *   follow itself is a customer action: no seller role, identity always
 *   `req.user.id`.
 * - `/me/follows` orders by follow-creation, mirroring `followedStores`:
 *   `listForUser` is an unsorted filter, so the local datastore's insertion
 *   order IS the order; `{createdAt: 1, _id: 1}` reproduces it deterministically,
 *   and rows whose store was deleted are dropped by the `.filter(Boolean)`.
 */
const storeNotFound = () => new ApiError(404, "Store not found.", [], "", "not_found");

const requireStore = async (storeId) => {
    if (!mongoose.isValidObjectId(storeId)) throw storeNotFound();
    const store = await Store.findById(storeId);
    if (!store) throw storeNotFound();
    return store;
};

const setFollow = async (userId, storeId, following) => {
    const store = await requireStore(storeId);

    if (following) {
        const inserted = await storeFollowerRepository.insertForUser(userId, storeId);
        if (!inserted) return { following: true, followerCount: store.followerCount };

        const updated = await Store.findOneAndUpdate(
            { _id: store._id },
            { $inc: { followerCount: 1 } },
            { new: true }
        );
        return { following: true, followerCount: updated ? updated.followerCount : store.followerCount + 1 };
    }

    const removed = await storeFollowerRepository.removeForUser(userId, storeId);
    if (!removed) return { following: false, followerCount: store.followerCount };

    // Pipeline update: floor the decrement at 0 in the database itself.
    // Mongoose 9 gates array updates behind an explicit per-query opt-in.
    const updated = await Store.findOneAndUpdate(
        { _id: store._id },
        [{ $set: { followerCount: { $max: [0, { $add: [{ $ifNull: ["$followerCount", 0] }, -1] }] } } }],
        { new: true, updatePipeline: true }
    );
    return { following: false, followerCount: updated ? updated.followerCount : Math.max(0, store.followerCount - 1) };
};

const followStore = (userId, storeId) => setFollow(userId, storeId, true);

const unfollowStore = (userId, storeId) => setFollow(userId, storeId, false);

const followState = async (userId, storeId) => {
    const store = await requireStore(storeId);
    const existing = await storeFollowerRepository.getForUser(userId, storeId);
    return { following: Boolean(existing), followerCount: store.followerCount };
};

/** The caller's followed stores, follow-creation order, exact `toStoreDto`. */
const followedStores = async (userId) => {
    const follows = await storeFollowerRepository.listForUser(userId);
    if (follows.length === 0) return { stores: [] };

    const stores = await Store.find({ _id: { $in: follows.map((follow) => follow.storeId) } });
    const byId = new Map(stores.map((store) => [String(store._id), store]));

    const ordered = follows.map((follow) => byId.get(String(follow.storeId))).filter(Boolean);
    return { stores: ordered.map(toStoreDto) };
};

export { followStore, unfollowStore, followState, followedStores };
