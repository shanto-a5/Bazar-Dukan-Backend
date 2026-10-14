import mongoose, { Schema } from "mongoose";

/**
 * The Vanta user.
 *
 * `passwordHash` and `passwordSalt` are `select: false`: they are not part of a
 * normal query result, and `toPublicUser` is the only projection that ever
 * leaves this process, so a hash cannot reach an API response by accident.
 *
 * `passwordSet` distinguishes an account whose owner chose its password from a
 * quick account whose password was minted at random and never shown. A normal
 * register leaves it at the default `true`; quick-account creation is the only
 * path that writes `false`, and exactly one endpoint (`/auth/me/password/initial`)
 * reads it. The default matters for accounts created before the field existed:
 * they hydrate as `true`, so they can never use the no-current-password path.
 *
 * Roles are server-controlled. `seller_approver` exists here only because the
 * server may grant it; nothing in the request path writes it (see
 * `rejectSecurityFields`), because a client that can name its own role is an
 * admin already.
 */
const userSchema = new Schema({
    name: {
        type: String,
        required: [true, "name is required"],
        trim: true
    },

    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true
    },

    phone: {
        type: String,
        default: "",
        trim: true
    },

    passwordHash: {
        type: String,
        required: true,
        select: false
    },

    passwordSalt: {
        type: String,
        required: true,
        select: false
    },

    passwordSet: {
        type: Boolean,
        default: true
    },

    avatar: {
        type: String,
        default: ""
    },

    roles: {
        type: [String],
        enum: ["customer", "seller", "seller_approver"],
        default: () => ["customer"]
    }
}, { timestamps: true });

/**
 * The public projection: every field a client is allowed to see, and nothing
 * else. This is the single place that decides what a "user" is over the wire.
 */
const toPublicUser = (user) => ({
    id: user.id ?? String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone ?? "",
    avatar: user.avatar ?? "",
    // `!== false` rather than the raw field: an account hydrated before
    // `passwordSet` existed reads `undefined`, and only an explicit `false`
    // (a quick account awaiting its owner's password) counts as "no password".
    hasPassword: user.passwordSet !== false,
    roles: [...(user.roles ?? [])],
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : "",
    updatedAt: user.updatedAt ? new Date(user.updatedAt).toISOString() : ""
});

export const User = mongoose.model("User", userSchema);
export { toPublicUser };
