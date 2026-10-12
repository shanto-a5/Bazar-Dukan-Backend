import mongoose, { Schema } from "mongoose";

/**
 * An in-app notification for one user.
 *
 * `type` is one of the 16 simulator emission categories plus `system`, and each
 * type is emitted by exactly one ownership side: customer types
 * (order/return/review_reminder/review_reply) land on customers, seller types
 * (seller_*) land on sellers, and `promotion`/`voucher` carry marketing.
 *
 * `data` is an opaque payload the client renders alongside `title`/`body` (e.g.
 * the order id to deep-link to). `read` is mutable by the owner; unread counts
 * and inbox orderings are served by the compound index on
 * `{userId, read, createdAt}`.
 */
const notificationSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    type: {
        type: String,
        enum: [
            "order_placed", "order_confirmed", "order_shipped",
            "order_delivered", "order_cancelled", "return_update",
            "promotion", "voucher", "review_reminder", "review_reply",
            "seller_new_order", "seller_order_cancelled", "seller_low_stock",
            "seller_return_request", "seller_review_received",
            "seller_account_status", "system"
        ],
        required: true
    },

    title: {
        type: String,
        required: true
    },

    body: {
        type: String,
        default: ""
    },

    read: {
        type: Boolean,
        default: false
    },

    data: {
        type: Schema.Types.Mixed,
        default: null
    }
}, { timestamps: true });

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);