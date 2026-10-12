/**
 * Data access for Voucher documents.
 *
 * Every read that takes an id validates it first, so a malformed id from a
 * request is a `null` lookup (which the service answers with 404) instead of a
 * Mongoose CastError escaping as a 500. Codes are compared in their stored
 * UPPERCASE form — the model uppercases on write — which makes the lookup
 * case-insensitive for free.
 *
 * `markUsed` is the one atomic writer: a single `$inc` bumps the global tally
 * and the per-customer tally together, so two concurrent redemptions can never
 * interleave a read-modify-write and lose a count.
 */
import mongoose from "mongoose";
import { Voucher } from "../models/voucher.model.js";

class VoucherRepository {
    async create(voucher) {
        return Voucher.create(voucher);
    }

    async findById(id) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        return Voucher.findById(id);
    }

    async findByCode(code) {
        const normalised = String(code ?? "").trim().toUpperCase();
        if (!normalised) return null;
        return Voucher.findOne({ code: normalised });
    }

    async listAll(filters = {}) {
        return Voucher.find(filters).sort({ createdAt: -1, _id: -1 });
    }

    async listForSeller(sellerId) {
        if (!sellerId) return [];
        return Voucher.find({ scope: "seller", sellerId }).sort({ createdAt: -1, _id: -1 });
    }

    async update(id, updates) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        return Voucher.findByIdAndUpdate(id, updates, { new: true });
    }

    /**
     * The one atomic writer: a single conditional `$inc` bumps the global
     * tally and the per-customer tally together, so two concurrent redemptions
     * can never interleave a read-modify-write and lose a count. The limits are
     * part of the filter itself — a redemption that would cross a limit matches
     * nothing and returns null instead of silently over-incring.
     */
    async markUsed(id, userId) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        const voucher = await Voucher.findById(id).select({ usageLimit: 1, perUserLimit: 1 });
        if (!voucher) return null;

        const filter = { _id: id };
        if (voucher.usageLimit !== null && voucher.usageLimit !== undefined) {
            filter.usageCount = { $lt: voucher.usageLimit };
        }
        if (userId && voucher.perUserLimit !== null && voucher.perUserLimit !== undefined) {
            // A customer never seen before has NO key in the map, and a Mongo
            // `$lt` does not match a missing field — treat absent as 0.
            filter.$or = [
                { [`perUserUsed.${userId}`]: { $exists: false } },
                { [`perUserUsed.${userId}`]: { $lt: voucher.perUserLimit } }
            ];
        }

        const inc = { usageCount: 1 };
        if (userId) inc[`perUserUsed.${userId}`] = 1;
        return Voucher.findOneAndUpdate(filter, { $inc: inc }, { new: true });
    }

    async remove(id) {
        if (!id || !mongoose.isValidObjectId(id)) return false;
        const deleted = await Voucher.findByIdAndDelete(id);
        return Boolean(deleted);
    }
}

export const voucherRepository = new VoucherRepository();
