import mongoose, { Schema } from "mongoose";

/**
 * The seller-side slice of an order.
 *
 * Checkout groups cart lines by seller and creates one SellerOrder per seller;
 * each carries an immutable snapshot of its line items, prices, shipping policy
 * and the customer's shipping address. Snapshots are history: changing the
 * product, variant or store later never rewrites what a placed order remembers.
 *
 * `items[].id` is a plain string — the order-line id used by customer and seller
 * views and by `ReturnRequest.orderItemId` / `Review.orderItemId` — not a Mongo
 * ObjectId, and each line is unique only within its own array. The `status` of
 * a seller order follows the same lifecycle enum as the parent Order; the
 * seller-visible progression is `new` → … → `delivered`, and the per-line
 * `status` tracks the wait, delivery and any return states independently.
 */
const orderItemSnapshotSchema = new Schema({
    id: {
        type: String,
        required: true
    },

    productId: {
        type: String,
        required: true
    },

    productName: {
        type: String,
        required: true
    },

    brand: {
        type: String,
        default: ""
    },

    image: {
        type: String,
        default: ""
    },

    variantId: {
        type: String,
        default: null
    },

    variantAttributes: {
        type: Schema.Types.Mixed,
        default: null
    },

    unitPrice: {
        type: Number,
        required: true,
        min: 0
    },

    discount: {
        type: Number,
        default: 0,
        min: 0
    },

    quantity: {
        type: Number,
        required: true,
        min: 1
    },

    subtotal: {
        type: Number,
        required: true,
        min: 0
    },

    status: {
        type: String,
        enum: [
            "pending", "delivered", "cancelled", "return_requested",
            "return_approved", "partially_returned", "returned", "refunded"
        ],
        default: "pending"
    },

    reviewId: {
        type: String,
        default: null
    },

    hasReview: {
        type: Boolean,
        default: false
    },

    returnRequestId: {
        type: String,
        default: null
    },

    returnedQuantity: {
        type: Number,
        default: 0,
        min: 0
    },

    remainingQuantity: {
        type: Number,
        default: null,
        min: 0
    }
}, { _id: false });

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

const shippingAddressSchema = new Schema({
    label: {
        type: String,
        default: ""
    },

    recipientName: {
        type: String,
        required: true,
        trim: true
    },

    phone: {
        type: String,
        required: true,
        trim: true
    },

    division: {
        type: String,
        required: true
    },

    district: {
        type: String,
        required: true
    },

    area: {
        type: String,
        required: true
    },

    addressLine: {
        type: String,
        required: true
    },

    postalCode: {
        type: String,
        default: ""
    },

    instructions: {
        type: String,
        default: ""
    },

    isDefault: {
        type: Boolean,
        default: false
    }
}, { _id: false });

const sellerOrderSchema = new Schema({
    orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
        required: true
    },

    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        required: true
    },

    storeId: {
        type: Schema.Types.ObjectId,
        ref: "Store",
        required: true
    },

    storeName: {
        type: String,
        default: ""
    },

    storeLogo: {
        type: String,
        default: ""
    },

    status: {
        type: String,
        enum: [
            "placed", "new", "confirmed", "processing", "packed",
            "ready_to_ship", "shipped", "out_for_delivery", "delivered",
            "cancelled", "return_requested", "return_approved",
            "partially_returned", "returned", "refunded"
        ],
        default: "new"
    },

    items: {
        type: [orderItemSnapshotSchema],
        default: []
    },

    subtotal: {
        type: Number,
        default: 0,
        min: 0
    },

    shippingFee: {
        type: Number,
        default: 0,
        min: 0
    },

    vouchersDiscount: {
        type: Number,
        default: 0,
        min: 0
    },

    total: {
        type: Number,
        default: 0,
        min: 0
    },

    shippingAddress: {
        type: shippingAddressSchema,
        required: true
    },

    carrier: {
        type: String,
        default: ""
    },

    trackingNumber: {
        type: String,
        default: ""
    },

    timeline: {
        type: [timelineEntrySchema],
        default: []
    },

    fulfilledAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

sellerOrderSchema.index({ orderId: 1 });
sellerOrderSchema.index({ sellerId: 1, status: 1 });

export const SellerOrder = mongoose.model("SellerOrder", sellerOrderSchema);