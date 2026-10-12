import { StoreFollower } from "../models/store-follower.model.js";

/**
 * Store-follow persistence.
 *
 * `insertForUser` reports `false` when the pair already follows (the unique
 * `{userId, storeId}` index raised E11000). That boolean is the service's
 * gate for `store.followerCount`: only an actual insert may `$inc`, which is
 * what makes a duplicate follow a strict no-op.
 *
 * `listForUser` is an UNSORTED filter, mirroring the simulator's
 * `listForUser(userId)` (`local-repositories.ts:433-435`), so MongoDB's
 * natural order — insertion order for freshly written rows — is the order
 * `/me/follows` lists in. It is sorted `{createdAt: 1, _id: 1}` here, which
 * reproduces that insertion order deterministically (follow rows are always
 * fresh inserts, never rewritten, so `createdAt` never changes under them).
 */
const getForUser = (userId, storeId) => StoreFollower.findOne({ userId, storeId });

const insertForUser = async (userId, storeId) => {
    try {
        await StoreFollower.create({ userId, storeId });
        return true;
    } catch (error) {
        if (error?.code === 11000) return false;
        throw error;
    }
};

const removeForUser = (userId, storeId) => StoreFollower.findOneAndDelete({ userId, storeId });

const listForUser = (userId) => StoreFollower.find({ userId }).sort({ createdAt: 1, _id: 1 });

const listForStore = (storeId) => StoreFollower.find({ storeId });

const storeFollowerRepository = { getForUser, insertForUser, removeForUser, listForUser, listForStore };

export default storeFollowerRepository;
export { storeFollowerRepository };
