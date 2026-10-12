import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
    createFollow,
    deleteFollow,
    getFollowState,
    listFollowedStores
} from "../controllers/follow.controller.js";

/**
 * Vanta store-follow routes, mounted at `/api/v1`.
 *
 * Paths are the FULL client paths the store screen and the follows list call.
 * Everything is authenticated — a follow always belongs to `req.user.id`,
 * which the `authenticate` middleware guarantees — but nothing here requires
 * a seller role: following is a customer action. The store id lives in the
 * path; bodies must be empty (the validator rejects every key).
 */
const router = Router();

// follow / unfollow / current state for one store (desired state in, desired state out)
router.route("/stores/:id/follow").post(authenticate, createFollow);
router.route("/stores/:id/follow").delete(authenticate, deleteFollow);
router.route("/stores/:id/follow").get(authenticate, getFollowState);

// the caller's followed stores, follow-creation order, as toStoreDto
router.route("/me/follows").get(authenticate, listFollowedStores);

export default router;
