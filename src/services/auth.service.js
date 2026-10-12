import bcrypt from "bcrypt";
import { ApiError } from "../utils/ApiError.js";
import { generateOpaqueToken, hashToken, isWellFormedToken } from "../utils/token.js";
import { toPublicUser } from "../models/user.model.js";
import {
    bcryptRounds,
    sessionTtlMs,
    sessionMaxPerUser,
    passwordResetTtlMs,
    publicAppUrl
} from "../constance.js";
import * as userRepo from "../repositories/user.repository.js";
import * as sessionRepo from "../repositories/session.repository.js";
import * as passwordResetRepo from "../repositories/password-reset.repository.js";
import { sendMail } from "./mailer.js";

/**
 * Vanta identity: User + Session + opaque bearer token.
 *
 * The token the client stores carries no claims. It is a random string whose
 * hash is what the session collection holds, so every request resolves the
 * actor server-side and logout is real — a revoked session stops working
 * immediately instead of at the next expiry.
 *
 * Passwords are bcrypt (cost from config, salt generated per password and
 * stored alongside so the field exists for the domain without ever being sent).
 *
 * The status/code pairs follow the Vanta contract exactly: 409 for a duplicate
 * email, 401 for credentials and bearer sessions, 422 `validation_failed` for
 * field errors, 404 for an account that vanished under an authenticated call.
 */
const unauthorized = (message) => new ApiError(401, message, [], "", "unauthorized");
const conflict = (message) => new ApiError(409, message, [], "", "conflict");
const notFound = (message) => new ApiError(404, message, [], "", "not_found");
const validation = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const fieldError = (field, message) => ({ field, message });

/**
 * Spent when the email is unknown, so a login attempt costs the same work
 * whether or not the account exists and the endpoint cannot be used as an
 * oracle. Built on first use; never compared against a real user.
 */
let placeholderHash = null;
const getPlaceholderHash = () => {
    placeholderHash ??= bcrypt.hash("vanta-placeholder-password", bcryptRounds());
    return placeholderHash;
};

const hashPassword = async (password) => {
    const passwordSalt = await bcrypt.genSalt(bcryptRounds());
    const passwordHash = await bcrypt.hash(password, passwordSalt);
    return { passwordHash, passwordSalt };
};

const defaultAvatar = (email) => `p:\u{1F464}:${email}`;

// ----------------------------------------------------------------- sessions

const issueSession = async (userId) => {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + sessionTtlMs());

    const session = await sessionRepo.insert({ userId, tokenHash: hashToken(token), expiresAt });
    await enforceSessionLimit(userId, session);

    return { token, expiresAt: expiresAt.toISOString() };
};

/**
 * Keep at most `SESSION_MAX_PER_USER` live sessions, dropping the oldest first.
 * Without a cap a leaked credential can mint sessions forever and the
 * collection grows without bound. The session just issued is always kept.
 */
const enforceSessionLimit = async (userId, issuedSession) => {
    const max = sessionMaxPerUser();
    if (max <= 0) return;

    const live = (await sessionRepo.listForUser(userId)).filter(
        (entry) => String(entry._id) !== String(issuedSession._id) && entry.expiresAt.getTime() > Date.now()
    );

    for (const stale of live.slice(0, Math.max(0, live.length - (max - 1)))) {
        await sessionRepo.deleteById(stale._id);
    }
};

/** Resolves a bearer token to its live session and public user, or throws 401. */
const authenticateToken = async (token) => {
    if (!token) throw unauthorized("Sign in to continue.");
    if (!isWellFormedToken(token)) throw unauthorized("Your session is no longer valid. Sign in again.");

    const session = await sessionRepo.findByTokenHash(hashToken(token));
    if (!session) throw unauthorized("Your session is no longer valid. Sign in again.");

    if (session.expiresAt.getTime() < Date.now()) {
        // Lazy reaping: the TTL index also removes it, but a row the index has
        // not reached yet must never authenticate anybody.
        await sessionRepo.deleteById(session._id);
        throw unauthorized("Your session has expired. Sign in again.");
    }

    const user = await userRepo.findById(session.userId);
    if (!user) {
        await sessionRepo.deleteById(session._id);
        throw unauthorized("Your session is no longer valid. Sign in again.");
    }

    return { user: toPublicUser(user), sessionId: session._id };
};

// -------------------------------------------------------------------- auth

const register = async (input) => {
    const existing = await userRepo.findByEmail(input.email);
    if (existing) throw conflict("An account with this email already exists.");

    const { passwordHash, passwordSalt } = await hashPassword(input.password);

    let user;
    try {
        user = await userRepo.insert({
            name: input.name,
            email: input.email,
            phone: input.phone,
            passwordHash,
            passwordSalt,
            avatar: defaultAvatar(input.email),
            // Registration is never allowed to name a role: the request body was
            // rejected in the validator, so this is the only value that exists.
            roles: ["customer"]
        });
    } catch (error) {
        // Unique-index race: two registrations for the same email at once.
        if (error?.code === 11000) throw conflict("An account with this email already exists.");
        throw error;
    }

    const session = await issueSession(user._id);
    return { user: toPublicUser(user), token: session.token, expiresAt: session.expiresAt };
};

const login = async (input) => {
    const user = await userRepo.findByEmailWithSecrets(input.email);

    // Same message and the same work for both failure modes.
    const hash = user ? user.passwordHash : await getPlaceholderHash();
    const matches = await bcrypt.compare(input.password, hash);
    if (!user || !matches) throw unauthorized("Those credentials do not match an account.");

    const session = await issueSession(user._id);
    return { user: toPublicUser(user), token: session.token, expiresAt: session.expiresAt };
};

const logout = async (sessionId) => {
    if (sessionId) await sessionRepo.deleteById(sessionId);
    return { loggedOut: true };
};

/** Kills every session of this account — and only this account's. */
const logoutAll = async (userId) => {
    await sessionRepo.deleteForUser(userId);
    return { loggedOutEverywhere: true };
};

// ----------------------------------------------------------------- profile

const updateProfile = async (userId, patch) => {
    const user = await userRepo.findById(userId);
    if (!user) throw notFound("Account not found.");

    const fields = [];
    const update = {};

    if (patch.name !== undefined) update.name = patch.name;

    if (patch.email !== undefined) {
        if (await userRepo.emailOwnedByOther(patch.email, user._id)) {
            fields.push(fieldError("email", "An account with this email already exists."));
        } else {
            update.email = patch.email;
        }
    }

    if (patch.phone !== undefined) update.phone = patch.phone;
    if (patch.avatar !== undefined) update.avatar = patch.avatar;

    if (fields.length > 0) throw validation("Please fix the highlighted fields.", fields);

    const updated = await userRepo.patch(userId, update);
    if (!updated) throw notFound("Account not found.");

    return toPublicUser(updated);
};

/**
 * Changes the password and revokes every *other* session.
 *
 * Keeping the caller's session is deliberate: forcing a sign-in immediately
 * after a successful password change punishes the one person who proved they
 * know both passwords, and the client contract says as much
 * (`otherSessionsRevoked`). Every other device is signed out, which is the
 * point of changing a password.
 */
const changePassword = async (userId, currentPassword, newPassword, activeSessionId) => {
    const user = await userRepo.findByIdWithSecrets(userId);
    if (!user) throw notFound("Account not found.");

    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) {
        throw validation("Current password is incorrect.", [
            fieldError("currentPassword", "Current password is incorrect.")
        ]);
    }

    const { passwordHash, passwordSalt } = await hashPassword(newPassword);
    await userRepo.patch(userId, { passwordHash, passwordSalt });

    const result = await sessionRepo.deleteForUser(userId, activeSessionId);
    return { changed: true, otherSessionsRevoked: (result?.deletedCount ?? 0) > 0 };
};

// ------------------------------------------------------------ reset (M8-G)

/**
 * Starts a password reset.
 *
 * The answer is identical for a known and an unknown address — same status,
 * same body, same `expiresInMinutes` — so the endpoint cannot be used to
 * discover who has an account. Only the SHA-256 of the token is stored, a
 * second request deletes the first ticket, and a mail transport failure drops
 * the ticket rather than leaving a live link nobody received. A failed send
 * is logged server-side and otherwise answered like every other request: the
 * contract has one outward response, and no provider detail may widen it.
 */
const requestPasswordReset = async (email) => {
    const user = await userRepo.findByEmail(email);

    if (user) {
        const token = generateOpaqueToken();
        const expiresAt = new Date(Date.now() + passwordResetTtlMs());

        await passwordResetRepo.deleteForUser(user._id);
        await passwordResetRepo.insert({ userId: user._id, tokenHash: hashToken(token), expiresAt });

        try {
            await sendMail({
                to: user.email,
                subject: "Reset your Vanta password",
                text: [
                    `Hello ${user.name},`,
                    "",
                    "Use the link below to choose a new password. It works once and expires in",
                    `${Math.round(passwordResetTtlMs() / 60_000)} minutes.`,
                    "",
                    `${publicAppUrl()}?token=${token}`,
                    "",
                    "If you did not ask for this, you can ignore it — nothing has changed yet."
                ].join("\n")
            });
        } catch (error) {
            // Delivery failed. The ticket is dropped so the link nobody
            // received cannot be used, and the failure is recorded server-side
            // — but the answer stays byte-for-byte the one an unknown address
            // gets, because a different answer would tell the caller whether
            // the account exists. Resend's reason, and any provider detail,
            // never leaves this process.
            await passwordResetRepo.deleteForUser(user._id);
            console.error(`[password-reset] mail transport failed: ${error.message}`);
        }
    }

    return { accepted: true, expiresInMinutes: Math.round(passwordResetTtlMs() / 60_000) };
};

/**
 * Finishes a reset.
 *
 * Unknown, expired and already-used tickets are indistinguishable to the
 * caller: one status, one code, one message, so a token cannot be probed. The
 * claim happens before the password write so two simultaneous confirms cannot
 * both win, and every session for the account dies — a reset that left the old
 * sessions alive would not be a reset.
 */
const confirmPasswordReset = async (token, newPassword) => {
    const invalid = () =>
        validation("That reset link is not valid. Request a new one.", [
            fieldError("token", "That reset link is not valid. Request a new one.")
        ]);
    const spent = () =>
        validation("That reset link has expired or was already used. Request a new one.", [
            fieldError("token", "That reset link has expired or was already used. Request a new one.")
        ]);

    if (!isWellFormedToken(token)) throw invalid();

    const record = await passwordResetRepo.findByTokenHash(hashToken(token));
    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) throw spent();

    const user = await userRepo.findById(record.userId);
    if (!user) throw invalid();

    const claimed = await passwordResetRepo.markUsed(record._id);
    if (!claimed) throw spent();

    const { passwordHash, passwordSalt } = await hashPassword(newPassword);
    await userRepo.patch(user._id, { passwordHash, passwordSalt });

    const revoked = await sessionRepo.deleteForUser(user._id);
    await passwordResetRepo.deleteForUser(user._id);

    return { reset: true, sessionsRevoked: revoked?.deletedCount ?? 0 };
};

export {
    register,
    login,
    authenticateToken,
    logout,
    logoutAll,
    updateProfile,
    changePassword,
    requestPasswordReset,
    confirmPasswordReset
};
