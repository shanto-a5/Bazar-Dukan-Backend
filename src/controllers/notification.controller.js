/**
 * Notification endpoints — HTTP shaping only.
 *
 * Identity comes exclusively from `req.user.id`: every query, mark and delete
 * is scoped to the signed-in user inside the service, and a notification that
 * belongs to somebody else is a 404 — never a 403, which would confirm the id
 * exists.
 *
 * `unreadCount` is returned alongside the page because the badge counts the
 * whole inbox while the list is a bounded window: `limit` defaults to 50 and
 * is clamped to 100, `unread=true` narrows the page to unread rows but does
 * not change the count.
 */
import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import * as notificationService from "../services/notification.service.js";

const notFound = () => new ApiError(404, "Notification not found.", [], "", "not_found");

/** `limit` → an integer in 1..100, defaulting to 50 for anything unparseable. */
const parseLimit = (value) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 50;
    return Math.min(parsed, 100);
};

// GET /notifications?unread=true&limit=50 — newest first, plus the unread badge.
const listNotifications = asyncHandlers(async (req, res) => {
    const unreadOnly = String(req.query.unread ?? "") === "true";
    const limit = parseLimit(req.query.limit);

    const result = await notificationService.list(req.user.id, { unreadOnly, limit });
    return res.status(200).json(new ApiResponse(200, result, "Notifications listed."));
});

// GET /notifications/unread-count — the badge on its own.
const unreadCount = asyncHandlers(async (req, res) => {
    const count = await notificationService.unreadCount(req.user.id);
    return res.status(200).json(new ApiResponse(200, { unreadCount: count }, "Unread count."));
});

// PATCH /notifications/:id/read — 404 when the row is not the caller's.
const markRead = asyncHandlers(async (req, res) => {
    const notification = await notificationService.markRead(req.user.id, req.params.id);
    if (!notification) throw notFound();

    return res.status(200).json(new ApiResponse(200, { notification }, "Notification marked as read."));
});

// POST /notifications/read-all — sweeps the caller's inbox only.
const markAllRead = asyncHandlers(async (req, res) => {
    const updated = await notificationService.markAllRead(req.user.id);
    return res.status(200).json(new ApiResponse(200, { updated }, "All notifications marked as read."));
});

// DELETE /notifications/:id — 404 when the row is not the caller's.
const deleteNotification = asyncHandlers(async (req, res) => {
    const removed = await notificationService.remove(req.user.id, req.params.id);
    if (!removed) throw notFound();

    return res.status(200).json(new ApiResponse(200, { deleted: true }, "Notification deleted."));
});

export { listNotifications, unreadCount, markRead, markAllRead, deleteNotification };
