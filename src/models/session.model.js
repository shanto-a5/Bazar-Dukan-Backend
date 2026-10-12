import mongoose, { Schema } from "mongoose";

/**
 * Server-side session for an opaque bearer token.
 *
 * Only the SHA-256 of the token is stored, so the collection is not a list of
 * usable credentials. `expiresAt` carries both meanings of expiry: the service
 * refuses an expired row on every request, and the TTL index lets MongoDB reap
 * rows nobody came back for.
 */
const sessionSchema = new Schema({
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
    }
}, { timestamps: true });

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
