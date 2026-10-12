import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { validateFollowBody } from "../validators/follow.validator.js";
import { followStore, unfollowStore, followState, followedStores } from "../services/follow.service.js";

/**
 * Vanta store-follow endpoints, all authenticated.
 *
 * The controller only shapes HTTP: it validates the (empty) body, calls the
 * follow service and wraps the result in the envelope. `req.user.id` is the
 * ONLY identity every operation is scoped to — a client-supplied `userId` or
 * `followerCount` never reaches this file (the validator rejects it). Every
 * response carries the DESIRED state: `following` is what the caller asked
 * for, `followerCount` the store's value after the write.
 */

// POST /stores/:id/follow — first follow inserts the row and `$inc`s the count;
// a duplicate is a no-op that still answers { following: true }.
const createFollow = asyncHandlers(async (req, res) => {
    validateFollowBody(req.body);
    const data = await followStore(req.user.id, req.params.id);
    return res.status(200).json(new ApiResponse(200, data, "Now following this store."));
});

// DELETE /stores/:id/follow — removes the caller's row and decrements (floored
// at 0); without a row it is a no-op that leaves the count untouched.
const deleteFollow = asyncHandlers(async (req, res) => {
    validateFollowBody(req.body);
    const data = await unfollowStore(req.user.id, req.params.id);
    return res.status(200).json(new ApiResponse(200, data, "No longer following this store."));
});

// GET /stores/:id/follow — the caller's current state plus the store's count.
const getFollowState = asyncHandlers(async (req, res) => {
    const data = await followState(req.user.id, req.params.id);
    return res.status(200).json(new ApiResponse(200, data, "Follow state loaded."));
});

// GET /me/follows — the caller's followed stores in follow-creation order,
// each as the exact `toStoreDto`.
const listFollowedStores = asyncHandlers(async (req, res) => {
    const data = await followedStores(req.user.id);
    return res.status(200).json(new ApiResponse(200, data, "Followed stores loaded."));
});

export { createFollow, deleteFollow, getFollowState, listFollowedStores };
