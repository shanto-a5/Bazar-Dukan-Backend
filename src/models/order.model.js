import mongoose, { Schema } from "mongoose";

/**
 * A customer order, the customer-side root of a checkout.
 *
 * An order is split into one SellerOrder per seller at placement; `sellerOrderIds`
 * links this document to its children. The totals are computed server-side and
 * are authoritative — the client's numbers are advisory only. The order owns the
 * payment state (`paymentMethod`, `paymentStatus`) because a single checkout
 * produces one order (COD stays `pending` until delivery; online methods are
 * `paid` at placement).
 *
 * `shippingAddress` is a snapshot of what the customer typed at checkout, not a
 * reference to an address-book row, so history never moves when the address
 * book does. `orderCode` is the human-facing code shown to the user and is
 * unique. Delivery timestamps (`cancelledAt`, `deliveredAt`) are null until the
 * lifecycle reaches that terminal state.
 */
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

const orderSchema = new Schema({
    customerId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    orderCode: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },

    status: {
        type: String,
        enum: [
            "placed", "new", "confirmed", "processing", "packed",
            "ready_to_ship", "shipped", "out_for_delivery", "delivered",
            "cancelled", "return_requested", "return_approved",
            "partially_returned", "returned", "refunded"
        ],
        default: "placed"
    },

    sellerOrderIds: {
        type: [String],
        default: []
    },

    subtotal: {
        type: Number,
        default: 0,
        min: 0
    },

    shippingTotal: {
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

    paymentMethod: {
        type: String,
        enum: ["cod", "bkash", "nagad", "card"],
        default: "cod"
    },

    paymentStatus: {
        type: String,
        enum: ["pending", "authorized", "paid", "failed", "refunded"],
        default: "pending"
    },

    deliveryMethod: {
        type: String,
        enum: ["standard", "express"],
        default: "standard"
    },

    shippingAddress: {
        type: shippingAddressSchema,
        required: true
    },

    voucherCodes: {
        type: [String],
        default: []
    },

    placedAt: {
        type: Date,
        default: Date.now
    },

    cancelledAt: {
        type: Date,
        default: null
    },

    deliveredAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

orderSchema.index({ customerId: 1, placedAt: -1 });
orderSchema.index({ status: 1 });

export const Order = mongoose.model("Order", orderSchema);