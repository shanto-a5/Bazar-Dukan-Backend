import mongoose, { Schema } from "mongoose";

/**
 * The Vanta user.
 *
 * `passwordHash` and `passwordSalt` are `select: false`: they are not part of a
 * normal query result, and `toPublicUser` is the only projection that ever
 * leaves this process, so a hash cannot reach an API response by accident.
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
    roles: [...(user.roles ?? [])],
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : "",
    updatedAt: user.updatedAt ? new Date(user.updatedAt).toISOString() : ""
});

export const User = mongoose.model("User", userSchema);
export { toPublicUser };
