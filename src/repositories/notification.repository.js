/**
 * Data access for Notification documents.
 *
 * Every lookup is scoped to the owner (`userId`) in the query itself rather
 * than filtered afterwards, so a notification that belongs to somebody else is
 * simply not found — there is no code path that could return a foreign row and
 * then "check" it. Malformed ids resolve to `null` instead of throwing a
 * CastError, which keeps "not yours" and "does not exist" indistinguishable.
 *
 * Reads sort by `{ createdAt: -1, _id: -1 }`: the newest first, with the id as
 * a deterministic tie-break for rows written inside the same millisecond.
 */
import mongoose from "mongoose";
import { Notification } from "../models/notification.model.js";

class NotificationRepository {
    async create(notification) {
        return Notification.create(notification);
    }

    async findById(id) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        return Notification.findById(id);
    }

    async findByIdForUser(id, userId) {
        if (!id || !userId) return null;
        if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(userId)) return null;
        return Notification.findOne({ _id: id, userId });
    }

    async listForUser(userId, { unreadOnly = false, limit = 0 } = {}) {
        if (!userId) return [];
        const filter = { userId };
        if (unreadOnly) filter.read = false;

        let query = Notification.find(filter).sort({ createdAt: -1, _id: -1 });
        if (Number.isFinite(limit) && limit > 0) query = query.limit(limit);
        return query;
    }

    async countForUser(userId, { unreadOnly = false } = {}) {
        if (!userId) return 0;
        const filter = { userId };
        if (unreadOnly) filter.read = false;
        return Notification.countDocuments(filter);
    }

    async countUnread(userId) {
        return this.countForUser(userId, { unreadOnly: true });
    }

    async update(id, updates) {
        if (!id || !mongoose.isValidObjectId(id)) return null;
        return Notification.findByIdAndUpdate(id, updates, { new: true });
    }

    async updateMany(filter, updates) {
        return Notification.updateMany(filter, updates);
    }

    async remove(id) {
        if (!id || !mongoose.isValidObjectId(id)) return false;
        const deleted = await Notification.findByIdAndDelete(id);
        return Boolean(deleted);
    }
}

export const notificationRepository = new NotificationRepository();
