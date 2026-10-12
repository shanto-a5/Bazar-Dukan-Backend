/**
 * Data access for ReturnRequest documents (slice "returns + refunds").
 *
 * Every lookup is owner-scoped in the query itself rather than filtered after
 * the fact: `findByIdForSeller` makes "somebody else's return" and "no such
 * return" the same `null`, so the service can answer both with the simulator's
 * single 404 — `Return request not found.` — and there is no code path that
 * could load a foreign row and then "check" it. Malformed ids resolve to
 * `null` instead of throwing a CastError for the same reason.
 *
 * Reads sort newest first (`{ createdAt: -1, _id: -1 }`), with the id as a
 * deterministic tie-break for rows written inside the same millisecond.
 */
import mongoose from "mongoose";
import { ReturnRequest } from "../models/return-request.model.js";

class ReturnRequestRepository {
    async create(payload) {
        return ReturnRequest.create(payload);
    }

    async findById(id) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        return ReturnRequest.findById(id);
    }

    async findByIdForSeller(id, sellerId) {
        if (!id || !sellerId) return null;
        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(sellerId)) return null;
        return ReturnRequest.findOne({ _id: id, sellerId });
    }

    async listForUser(userId) {
        if (!userId) return [];
        return ReturnRequest.find({ userId }).sort({ createdAt: -1, _id: -1 });
    }

    async listForOrder(orderId) {
        if (!orderId || !mongoose.isValidObjectId(orderId)) return [];
        return ReturnRequest.find({ orderId }).sort({ createdAt: -1, _id: -1 });
    }

    async listForSeller(sellerId, { status = null } = {}) {
        if (!sellerId) return [];
        const filter = { sellerId };
        if (status) filter.status = status;
        return ReturnRequest.find(filter).sort({ createdAt: -1, _id: -1 });
    }

    /**
     * The one-open-per-line guard: only a still-undecided (`pending`) or
     * approved-but-not-yet-processed request blocks the next one. A
     * `rejected`/`returned`/`refunded` request deliberately does not — a
     * partly returned line must be able to hand its remaining units back.
     */
    async findOpenForLine(userId, orderItemId) {
        if (!userId || !orderItemId) return null;
        return ReturnRequest.findOne({
            userId,
            orderItemId,
            status: { $in: ["pending", "approved"] }
        });
    }

    async update(id, patch) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        return ReturnRequest.findByIdAndUpdate(id, patch, { new: true });
    }
}

export const returnRequestRepository = new ReturnRequestRepository();
