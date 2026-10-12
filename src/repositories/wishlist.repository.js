import { Wishlist } from "../models/wishlist.model.js";

/**
 * Wishlist persistence.
 *
 * One Wishlist document per user; `findByUserId` is the whole read path and
 * `ensureWishlist` creates the empty document lazily on first touch, exactly
 * like the simulator's `getOrCreate`. The unique `userId` index means two
 * first-touch requests can race; whoever loses re-reads the winner's row
 * instead of failing.
 */
const findByUserId = async (userId) => Wishlist.findOne({ userId });

const ensureWishlist = async (userId) => {
    const existing = await Wishlist.findOne({ userId });
    if (existing) return existing;

    try {
        return await Wishlist.create({ userId, items: [] });
    } catch (error) {
        if (error?.code === 11000) {
            const raced = await Wishlist.findOne({ userId });
            if (raced) return raced;
        }
        throw error;
    }
};

const save = async (wishlist) => wishlist.save();

const wishlistRepository = {
    findByUserId,
    ensureWishlist,
    save
};

export default wishlistRepository;
export { wishlistRepository };