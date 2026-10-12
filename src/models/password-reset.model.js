import mongoose, { Schema } from "mongoose";

/**
 * A single password-reset ticket.
 *
 * Same rule as the session: the token itself is never stored, only its SHA-256.
 * `usedAt` is what makes redemption single-use (claimed with a conditional
 * write, so two simultaneous confirms cannot both win), and `expiresAt` is
 * both checked and enforced by a TTL index.
 *
 * A request deletes the user's previous tickets first, so only the newest link
 * in an inbox works — which is what somebody who pressed "send again" expects.
 */
const passwordResetSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },

    tokenHash: {
        type: String,
        required: true,
        unique: true
    },

    expiresAt: {
        type: Date,
        required: true
    },

    usedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset = mongoose.model("PasswordReset", passwordResetSchema);
