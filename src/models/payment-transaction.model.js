import mongoose, { Schema } from "mongoose";

/**
 * The payment record for an order.
 *
 * The order's payment is a single transaction: `orderId` is unique, which is
 * also the idempotency guard for payment creation — one order can never get two
 * payment rows. `method` mirrors the order's `paymentMethod`; `status` tracks
 * the lifecycle from `pending` to `paid` (COD: set on delivery) or `failed`,
 * and `refundedAt`/`refundedAmount` record a refund against this payment
 * (refund headroom is `amount - refundedAmount`, shared across any returns on
 * the order).
 */
const paymentTransactionSchema = new Schema({
    orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
        required: true,
        unique: true
    },

    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    method: {
        type: String,
        enum: ["cod", "bkash", "nagad", "card"],
        required: true
    },

    amount: {
        type: Number,
        required: true,
        min: 0
    },

    status: {
        type: String,
        enum: ["pending", "authorized", "paid", "failed", "refunded"],
        default: "pending"
    },

    reference: {
        type: String,
        default: ""
    },

    paidAt: {
        type: Date,
        default: null
    },

    refundedAt: {
        type: Date,
        default: null
    },

    refundedAmount: {
        type: Number,
        default: 0,
        min: 0
    }
}, { timestamps: true });

export const PaymentTransaction = mongoose.model("PaymentTransaction", paymentTransactionSchema);