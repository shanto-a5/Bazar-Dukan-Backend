import { Store } from "../models/store.model.js";

/**
 * Store data access.
 *
 * Ownership is always the seller profile id (`sellerId`), which the store
 * schema keeps unique: one seller, one store, so resolving a store from the
 * authenticated profile is both the read path and the IDOR defence — there is
 * no store id in any request for a client to swap for someone else's.
 */
const findBySellerId = (sellerId) => Store.findOne({ sellerId });

const findById = (storeId) => Store.findById(storeId);

const insert = (doc) => Store.create(doc);

const patchById = (storeId, update) =>
    Store.findByIdAndUpdate(storeId, { $set: update }, { new: true, runValidators: true });

export { findBySellerId, findById, insert, patchById };
