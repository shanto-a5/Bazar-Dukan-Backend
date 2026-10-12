import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
    listNotifications,
    unreadCount,
    markRead,
    markAllRead,
    deleteNotification
} from "../controllers/notification.controller.js";

/**
 * Vanta notification routes. The paths are the FULL client paths so the router
 * mounts straight onto the API prefix (`app.use("/api/v1", notificationRouter)`)
 * without a hidden segment.
 *
 * Every route is authenticated and every handler scopes to `req.user.id`, so
 * the inbox is always the caller's own; the concrete `/:id` routes are declared
 * after their literal siblings (`unread-count`, `read-all`) so a literal path
 * can never be swallowed by a param.
 */
const router = Router();

// the inbox: a page of rows (optionally unread only) plus the unread badge
router.route("/notifications").get(authenticate, listNotifications);

// the badge on its own
router.route("/notifications/unread-count").get(authenticate, unreadCount);

// sweep the whole inbox in one call
router.route("/notifications/read-all").post(authenticate, markAllRead);

// one row: mark it read / delete it, owner only
router.route("/notifications/:id/read").patch(authenticate, markRead);
router.route("/notifications/:id").delete(authenticate, deleteNotification);

export default router;
