import { PasswordReset } from "../models/password-reset.model.js";

/** Password-reset data access — token hashes in, single-use claims out. */
const insert = (doc) => PasswordReset.create(doc);

const findByTokenHash = (tokenHash) => PasswordReset.findOne({ tokenHash });

/**
 * Claims a ticket. Matching on `usedAt: null` is what makes redemption
 * single-use under concurrency: the second caller finds nothing to claim.
 */
const markUsed = (resetId) =>
    PasswordReset.findOneAndUpdate({ _id: resetId, usedAt: null }, { $set: { usedAt: new Date() } }, { new: true });

/** New request wins: everything outstanding for this account is dropped. */
const deleteForUser = (userId) => PasswordReset.deleteMany({ userId });

export { insert, findByTokenHash, markUsed, deleteForUser };
