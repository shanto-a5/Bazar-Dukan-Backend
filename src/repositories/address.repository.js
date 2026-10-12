import mongoose from "mongoose";
import { Address } from "../models/address.model.js";

/**
 * Address book persistence.
 *
 * Reads are owner-scoped at the service layer; here the collection is keyed
 * one row per address. `listByUser` answers in insertion order (the compound
 * `{ userId, createdAt }` index), which is the order the simulator's array
 * repository keeps. A value that cannot be an ObjectId short-circuits to
 * `null` so a malformed path segment is a 404, never a CastError.
 */
const isValidId = (value) => mongoose.isValidObjectId(value);

const listByUser = (userId) => Address.find({ userId }).sort({ createdAt: 1, _id: 1 });

const findById = async (id) => (isValidId(id) ? Address.findById(id) : null);

const create = (doc) => Address.create(doc);

const updateById = (id, patch) =>
    Address.findByIdAndUpdate(id, { $set: patch }, { returnDocument: "after", runValidators: true });

const removeById = (id) => Address.findByIdAndDelete(id);

const countByUser = (userId) => Address.countDocuments({ userId });

const addressRepository = {
    listByUser,
    findById,
    create,
    updateById,
    removeById,
    countByUser
};

export default addressRepository;
export { addressRepository };