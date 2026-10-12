import { User } from "../models/user.model.js";

/**
 * User data access.
 *
 * The password columns are `select: false`, so the plain reads used by profile
 * and session code never load them; the two `*WithSecrets` reads are the only
 * callers that opt in, and both immediately sit behind `bcrypt.compare`.
 */
const findByEmailWithSecrets = (email) => User.findOne({ email }).select("+passwordHash +passwordSalt");

const findByIdWithSecrets = (userId) => User.findById(userId).select("+passwordHash +passwordSalt");

const findById = (userId) => User.findById(userId);

const findByEmail = (email) => User.findOne({ email });

const insert = (doc) => User.create(doc);

const patch = (userId, update) => User.findByIdAndUpdate(userId, update, { new: true });

/** Duplicate-email check that ignores the account being edited. */
const emailOwnedByOther = async (email, userId) => {
    const owner = await User.findOne({ email, _id: { $ne: userId } }).select("_id");
    return Boolean(owner);
};

export {
    findByEmailWithSecrets,
    findByIdWithSecrets,
    findById,
    findByEmail,
    insert,
    patch,
    emailOwnedByOther
};
