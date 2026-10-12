import { Session } from "../models/session.model.js";

/**
 * Session data access. Every credential path here works with the token *hash*;
 * no caller ever handles a stored plaintext token, because none is stored.
 */
const insert = (doc) => Session.create(doc);

const findByTokenHash = (tokenHash) => Session.findOne({ tokenHash });

const findById = (sessionId) => Session.findById(sessionId);

/** Oldest first, which is the order the session cap evicts in. */
const listForUser = (userId) => Session.find({ userId }).sort({ createdAt: 1 });

const deleteById = (sessionId) => Session.deleteOne({ _id: sessionId });

/** `keepSessionId` is how "everywhere except the device I am holding" is said. */
const deleteForUser = (userId, keepSessionId) =>
    Session.deleteMany({ userId, ...(keepSessionId ? { _id: { $ne: keepSessionId } } : {}) });

export { insert, findByTokenHash, findById, listForUser, deleteById, deleteForUser };
