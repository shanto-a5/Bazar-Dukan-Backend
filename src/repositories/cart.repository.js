import { Cart } from "../models/cart.model.js";

/**
 * Cart persistence.
 *
 * One Cart document per user with embedded items; each item's subdocument
 * `_id` is the item id the client addresses in PATCH/DELETE (exposed as `id`
 * in the DTOs). Nothing here re-derives a business rule — it only reads,
 * creates and saves documents, so the service layer stays the single owner of
 * cart logic.
 */
const findByUserId = async (userId) => Cart.findOne({ userId });

const createForUser = async (userId) => Cart.create({ userId, items: [] });

/**
 * Returns the caller's cart, creating an empty one on first touch. Two
 * requests adding their first item at the same moment can race the unique
 * `userId` index; whoever loses re-reads the winner's row instead of failing.
 */
const ensureCart = async (userId) => {
    const existing = await Cart.findOne({ userId });
    if (existing) return existing;

    try {
        return await Cart.create({ userId, items: [] });
    } catch (error) {
        if (error?.code === 11000) {
            const raced = await Cart.findOne({ userId });
            if (raced) return raced;
        }
        throw error;
    }
};

const save = async (cart) => cart.save();

const cartRepository = {
    findByUserId,
    createForUser,
    ensureCart,
    save
};

export default cartRepository;
export { cartRepository };