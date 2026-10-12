import mongoose, { Schema } from "mongoose";

/**
 * The Vanta storefront owned by one approved seller.
 *
 * `sellerId` is unique: a seller account maps to exactly one store, which is
 * created when the application is approved. `verified` defaults to true because
 * approval of the seller profile is the verification step (a store can only be
 * born from an approved profile).
 *
 * The commerce-facing counters (`ratingAvg`, `ratingCount`, `responseRate`,
 * `responseTimeMinutes`, `productCount`, `followerCount`) are denormalised
 * aggregates maintained by services, not derived at read time. `shippingFee`,
 * `freeShippingThreshold` and `deliveryEstimateDays` are the seller-set
 * shipping policy used at checkout and mirror the simulator's defaults
 * (fee 60, free over 999, 2–4 days).
 */
const deliveryEstimateSchema = new Schema({
    min: {
        type: Number,
        default: 2,
        min: 1
    },

    max: {
        type: Number,
        default: 4,
        min: 1
    }
}, { _id: false });

const storeSchema = new Schema({
    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        required: true,
        unique: true
    },

    name: {
        type: String,
        required: [true, "store name is required"],
        trim: true
    },

    description: {
        type: String,
        default: ""
    },

    logo: {
        type: String,
        default: ""
    },

    banner: {
        type: String,
        default: ""
    },

    status: {
        type: String,
        enum: ["active", "paused"],
        default: "active"
    },

    ratingAvg: {
        type: Number,
        default: 0,
        min: 0
    },

    ratingCount: {
        type: Number,
        default: 0,
        min: 0
    },

    responseRate: {
        type: Number,
        default: 100,
        min: 0,
        max: 100
    },

    responseTimeMinutes: {
        type: Number,
        default: 120,
        min: 0
    },

    productCount: {
        type: Number,
        default: 0,
        min: 0
    },

    followerCount: {
        type: Number,
        default: 0,
        min: 0
    },

    shippingFee: {
        type: Number,
        default: 60,
        min: 0
    },

    freeShippingThreshold: {
        type: Number,
        default: 999,
        min: 0
    },

    deliveryEstimateDays: {
        type: deliveryEstimateSchema,
        default: () => ({ min: 2, max: 4 })
    },

    location: {
        type: String,
        default: ""
    },

    verified: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

storeSchema.index({ status: 1 });

export const Store = mongoose.model("Store", storeSchema);