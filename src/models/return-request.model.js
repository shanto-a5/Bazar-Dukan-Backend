import mongoose, { Schema } from "mongoose";

/**
 * A customer's return request for one order line.
 *
 * Requests are item-level: `orderItemId` is the snapshot line id (see
 * SellerOrder.items[].id), and the parent `orderId`/`sellerOrderId` link the
 * line to both the customer order and its seller slice. `quantity` defaults to
 * null, which means "all remaining units" of the line; a partial return stores
 * the number of units actually taken back.
 *
 * `status` is server-controlled: `pending` until the seller decides, then
 * `approved`/`rejected`, and once goods arrive the line moves to `returned`
 * and, if money is owed, `refunded`. `timeline` records each transition for the
 * customer and seller views.
 */
const timelineEntrySchema = new Schema({
    status: {
        type: String,
        required: true
    },

    at: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const returnRequestSchema = new Schema({
    orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
        required: true
    },

    sellerOrderId: {
        type: Schema.Types.ObjectId,
        ref: "SellerOrder",
        required: true
    },

    orderItemId: {
        type: String,
        required: true
    },

    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        required: true
    },

    productName: {
        type: String,
        default: ""
    },

    quantity: {
        type: Number,
        default: null,
        min: 1
    },

    reason: {
        type: String,
        enum: [
            "damaged", "defective", "wrong_item", "missing_item",
            "does_not_match_description", "incorrect_size", "other"
        ],
        required: true
    },

    description: {
        type: String,
        default: ""
    },

    images: {
        type: [String],
        default: []
    },

    preferredResolution: {
        type: String,
        enum: ["refund", "replacement"],
        default: "refund"
    },

    status: {
        type: String,
        enum: ["pending", "approved", "rejected", "returned", "refunded"],
        default: "pending"
    },

    timeline: {
        type: [timelineEntrySchema],
        default: []
    }
}, { timestamps: true });

returnRequestSchema.index({ userId: 1, orderItemId: 1 });
returnRequestSchema.index({ sellerId: 1, status: 1 });

export const ReturnRequest = mongoose.model("ReturnRequest", returnRequestSchema);