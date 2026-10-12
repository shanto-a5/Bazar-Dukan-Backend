import { RecentlyViewed } from "../models/recently-viewed.model.js";

/**
 * Recently-viewed persistence.
 *
 * Data access only — the service owns the `viewCount` bump and the product
 * existence rule. One quirk is worth naming:
 *
 *   - `recordForUser` is an UPSERT on the unique `{userId, productId}` pair
 *     that rewrites `createdAt` to `now`. The simulator's `recordView` deletes
 *     the old row and inserts a fresh one (move-to-newest); the upsert is the
 *     single-document equivalent of that delete+insert. `{ timestamps: false }`
 *     stops Mongoose's timestamp middleware from relocating the explicit
 *     `createdAt` into `$setOnInsert` (where it could never update an
 *     existing row), and `new: true` returns the resulting row. A unique-index
 *     race (two simultaneous first views of the same product) surfaces as
 *     E11000 and is retried once with the same upsert.
 *   - `listForUser` sorts `createdAt` DESC with no `_id` tiebreak, exactly
 *     like the local repository's stable newest-first sort: a row's `_id`
 *     never changes on re-view, so a tiebreak on it would contradict
 *     move-to-newest.
 */
const listForUser = (userId) => RecentlyViewed.find({ userId }).sort({ createdAt: -1 });

const recordForUser = async (userId, productId) => {
    const now = new Date();
    const filter = { userId, productId };
    const update = { $set: { createdAt: now, updatedAt: now } };
    const options = { upsert: true, new: true, timestamps: false };

    try {
        return await RecentlyViewed.findOneAndUpdate(filter, update, options);
    } catch (error) {
        if (error?.code !== 11000) throw error;
        // Lost the first-view race: the unique index rejected the insert, so
        // the row exists now — the same $set moves it to the newest position.
        return RecentlyViewed.findOneAndUpdate(filter, update, options);
    }
};

const removeForUser = (userId, productId) => RecentlyViewed.deleteOne({ userId, productId });

const recentlyViewedRepository = { listForUser, recordForUser, removeForUser };

export default recentlyViewedRepository;
export { recentlyViewedRepository };
