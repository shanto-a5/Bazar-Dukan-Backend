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

/**
 * All accounts that share a phone number, with secrets.
 *
 * `phone` is deliberately not unique (quick accounts record it as contact
 * detail, never as an identifier), so a phone sign-in has to look at every
 * candidate and let the caller verify the password against each. Ordered newest
 * first so a phone reused across accounts resolves to the most recent one when
 * more than one password happens to match.
 */
const findByPhoneWithSecrets = (phone) =>
    User.find({ phone }).sort({ createdAt: -1 }).select("+passwordHash +passwordSalt");

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
    findByPhoneWithSecrets,
    findById,
    findByEmail,
    insert,
    patch,
    emailOwnedByOther
};
