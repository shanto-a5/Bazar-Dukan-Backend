/**
 * Notification domain service — the in-app inbox rules, with no HTTP concerns.
 *
 * Mirrors the simulator's `src/services/notification-service.ts` semantics on
 * top of the owner-scoped repository: a write names its recipient, reads are
 * always scoped to one user, and every mutation of somebody else's row is a
 * silent no-op that the controller turns into a 404 (`markRead`/`remove` return
 * `null`/`false` rather than throwing, so callers decide the status).
 *
 * The exported functions are a STABLE API other slices import:
 *
 *   create({ userId, type, title, body, data })
 *   list(userId, { unreadOnly, limit })  -> { notifications, unreadCount }
 *   unreadCount(userId)                  -> number
 *   markRead(userId, id)                 -> notification | null
 *   markAllRead(userId)                  -> number of rows updated
 *   remove(userId, id)                   -> boolean
 *
 * `type` is validated against the model's own enum (never a hand-kept copy),
 * so a new emission category can never be rejected here by drift.
 */
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { Notification } from "../models/notification.model.js";
import { notificationRepository } from "../repositories/notification.repository.js";

const VALID_TYPES = Notification.schema.path("type").enumValues;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const validationError = (fields) => new ApiError(422, "Please fix the highlighted fields.", fields, "", "validation_failed");

/** Public projection: `id` as a string, never `_id`/`__v`, `userId` as a string. */
const toDto = (notification) => {
    if (!notification) return null;
    const plain = typeof notification.toObject === "function" ? notification.toObject() : { ...notification };
    const dto = { ...plain, id: String(plain._id ?? plain.id ?? "") };
    delete dto._id;
    delete dto.__v;
    if (dto.userId !== undefined && dto.userId !== null) dto.userId = String(dto.userId);
    return dto;
};

/** The `limit` a client asked for, clamped to the API's contract: 1..100, default 50. */
const normaliseLimit = (limit) => {
    const parsed = Number(limit);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
    return Math.min(Math.floor(parsed), MAX_LIMIT);
};

/**
 * Create one notification for one user.
 *
 * An unknown `type` is a 422 that names the `type` field, so a caller that
 * mistyped an emission category is told which input was wrong instead of
 * getting a 500 from the schema's enum validator.
 */
async function create({ userId, type, title, body = "", data = null }) {
    const fields = [];
    if (!userId || !mongoose.isValidObjectId(userId)) {
        fields.push({ field: "userId", message: "Name a recipient for this notification." });
    }
    if (!VALID_TYPES.includes(type)) {
        fields.push({ field: "type", message: "That notification type is not supported." });
    }
    if (typeof title !== "string" || title.trim() === "") {
        fields.push({ field: "title", message: "A notification needs a title." });
    }
    if (fields.length > 0) throw validationError(fields);

    const created = await notificationRepository.create({
        userId,
        type,
        title: title.trim(),
        body: typeof body === "string" ? body : "",
        read: false,
        data: data ?? null
    });
    return toDto(created);
}

/**
 * Newest-first page of a user's inbox plus that user's TOTAL unread count
 * (the count is independent of the page, so the badge never shrinks because
 * the client asked for fewer rows).
 */
async function list(userId, { unreadOnly = false, limit = DEFAULT_LIMIT } = {}) {
    if (!userId) return { notifications: [], unreadCount: 0 };
    const docs = await notificationRepository.listForUser(userId, {
        unreadOnly: Boolean(unreadOnly),
        limit: normaliseLimit(limit)
    });
    const unreadCount = await notificationRepository.countUnread(userId);
    return { notifications: docs.map(toDto), unreadCount };
}

async function unreadCount(userId) {
    if (!userId) return 0;
    return notificationRepository.countUnread(userId);
}

/** Marks one owned notification read; `null` when it is missing or not yours. */
async function markRead(userId, id) {
    if (!userId || !id) return null;
    const owned = await notificationRepository.findByIdForUser(id, userId);
    if (!owned) return null;
    const updated = await notificationRepository.update(id, { read: true });
    return toDto(updated ?? owned);
}

/** Marks every unread row of this user read; returns how many changed. */
async function markAllRead(userId) {
    if (!userId) return 0;
    const result = await notificationRepository.updateMany({ userId, read: false }, { read: true });
    return result.modifiedCount ?? result.nModified ?? 0;
}

/** Deletes one owned notification; `false` when it is missing or not yours. */
async function remove(userId, id) {
    if (!userId || !id) return false;
    const owned = await notificationRepository.findByIdForUser(id, userId);
    if (!owned) return false;
    return notificationRepository.remove(id);
}

export { create, list, unreadCount, markRead, markAllRead, remove, toDto };
