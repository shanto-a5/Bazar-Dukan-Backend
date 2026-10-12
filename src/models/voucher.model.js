import mongoose, { Schema } from "mongoose";

/**
 * A discount voucher redeemable at checkout.
 *
 * `code` is stored UPPERCASE with a unique index, and every comparison is
 * performed on the uppercased code (the "compare in one case" strategy), so two
 * codes that differ only by case are the same voucher rather than two secrets
 * waiting to be typed wrong.
 *
 * `scope` decides eligibility: a `platform` voucher works anywhere, a `seller`
 * voucher is bound to `sellerId`. `startAt`/`expiry` bound the usable window,
 * `usageLimit` caps total redemptions (`usageCount` is the tally) and
 * `perUserLimit` caps redemptions per customer, tracked in the `perUserUsed`
 * map. The index on `{active, startAt, expiry}` serves the checkout-time
 * "is this voucher live right now" lookup.
 */
const voucherSchema = new Schema({
    code: {
        type: String,
        required: [true, "voucher code is required"],
        uppercase: true,
        trim: true,
        unique: true
    },

    title: {
        type: String,
        required: [true, "voucher title is required"],
        trim: true
    },

    type: {
        type: String,
        enum: ["percentage", "fixed", "free_shipping"],
        required: true
    },

    discountValue: {
        type: Number,
        default: 0,
        min: 0
    },

    minimumOrder: {
        type: Number,
        default: 0,
        min: 0
    },

    maximumDiscount: {
        type: Number,
        default: null,
        min: 0
    },

    scope: {
        type: String,
        enum: ["platform", "seller"],
        default: "platform"
    },

    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        default: null
    },

    categoryId: {
        type: Schema.Types.ObjectId,
        ref: "Category",
        default: null
    },

    productIds: {
        type: [String],
        default: []
    },

    startAt: {
        type: Date,
        required: true
    },

    expiry: {
        type: Date,
        required: true
    },

    usageLimit: {
        type: Number,
        default: null,
        min: 1
    },

    usageCount: {
        type: Number,
        default: 0,
        min: 0
    },

    perUserLimit: {
        type: Number,
        default: null,
        min: 1
    },

    perUserUsed: {
        type: Schema.Types.Mixed,
        default: {}
    },

    active: {
        type: Boolean,
        default: true
    },

    description: {
        type: String,
        default: ""
    }
}, { timestamps: true });

voucherSchema.index({ scope: 1, sellerId: 1 });
voucherSchema.index({ active: 1, startAt: 1, expiry: 1 });

export const Voucher = mongoose.model("Voucher", voucherSchema);