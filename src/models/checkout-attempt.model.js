import mongoose, { Schema } from "mongoose";

/**
 * One checkout submission, claimed by the unique userId+fingerprint pair.
 *
 * Checkout is not transactional in this deployment, so idempotency is claim
 * based (M8): the key a client retries with — or the server-computed
 * fingerprint of an identical resubmit — is written into this collection
 * *before* any side effect and marked `completed` only after the order, its
 * seller splits, the payment, the voucher redemption, the stock movements and
 * the notifications have all landed. A repeat inside the retry window replays
 * the stored order; an `in_flight` claim that never resolved is presumed dead
 * after the window and released.
 *
 * `fingerprint` is scoped per `userId` (compound unique index), so two
 * customers never collide on the same hash.
 */
const checkoutAttemptSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    /** The dedupe key: `k:<client idempotency key>` or `f:<server fingerprint>`. */
    fingerprint: {
        type: String,
        required: true,
        trim: true
    },

    /**
     * The payload hash of the request that won this key. A replay compares it
     * against the new submission, so the same key with different order details
     * is a 409 rather than a silently-wrong answer.
     */
    requestFingerprint: {
        type: String,
        required: true,
        trim: true
    },

    state: {
        type: String,
        enum: ["in_flight", "completed", "released"],
        default: "in_flight"
    },

    /** The order this claim produced, written once the order row exists. */
    orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
        default: null
    },

    /** The HTTP status a replay of this claim should answer with. */
    responseStatus: {
        type: Number,
        default: null
    }
}, { timestamps: true });

checkoutAttemptSchema.index({ userId: 1, fingerprint: 1 }, { unique: true });

export const CheckoutAttempt = mongoose.model("CheckoutAttempt", checkoutAttemptSchema);