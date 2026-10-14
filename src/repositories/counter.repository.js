import { Counter } from "../models/counter.model.js";

/**
 * Atomic named counters.
 *
 * `nextValue` is a single `findOneAndUpdate` with `$inc` and `upsert`, so two
 * concurrent callers can never read the same number: MongoDB applies each
 * increment atomically and `new: true` returns the value *after* the caller's
 * own increment. The first call for a key creates it at `seq: 1`.
 *
 * The one race the atomic increment does not cover is two upserts trying to
 * *create* the same key at once, which one of them loses with a duplicate-key
 * error. That is not a real collision — the document now exists — so the loser
 * simply retries and lands on the atomic path.
 */
const nextValue = async (key) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const counter = await Counter.findOneAndUpdate(
                { _id: key },
                { $inc: { seq: 1 } },
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );
            return counter.seq;
        } catch (error) {
            if (error?.code === 11000) continue;
            throw error;
        }
    }
    throw new Error(`Could not advance counter "${key}".`);
};

export { nextValue };
