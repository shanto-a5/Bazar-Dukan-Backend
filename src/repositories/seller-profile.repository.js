import { SellerProfile } from "../models/seller-profile.model.js";

/**
 * Seller application data access.
 *
 * The `userId` unique index on the model is the real one-application-per-user
 * guarantee; `findByUserId` is the read every seller route resolves ownership
 * with, so a request never names the profile it wants — it asks "who am I?" and
 * gets the profile back.
 */
const findByUserId = (userId) => SellerProfile.findOne({ userId });

const findById = (profileId) => SellerProfile.findById(profileId);

const insert = (doc) => SellerProfile.create(doc);

/** The approver queue: one status, newest application first. */
const listByStatus = (status) => SellerProfile.find({ status }).sort({ appliedAt: -1, _id: -1 });

const patchById = (profileId, update) =>
    SellerProfile.findByIdAndUpdate(profileId, { $set: update }, { new: true, runValidators: true });

/**
 * One decision, atomically: the current-state fields (`status`, `decidedAt`,
 * `decisionNote`) are `$set` while the append-only `decisionHistory` array
 * gets exactly one `$push`. Existing entries are never named by the update,
 * so no decision can rewrite an earlier one.
 */
const applyDecision = (profileId, current, entry) =>
    SellerProfile.findByIdAndUpdate(
        profileId,
        { $set: current, $push: { decisionHistory: entry } },
        { new: true, runValidators: true }
    );

export { findByUserId, findById, insert, listByStatus, patchById, applyDecision };
