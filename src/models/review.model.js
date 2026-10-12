import mongoose, { Schema } from "mongoose";

/**
 * A customer's review of a purchased product.
 *
 * `orderItemId` is unique: each order line gets at most one review, so the
 * unique index is the "one review per order line" rule itself. `userId` is the
 * reviewer and `sellerId` is the product's seller, which is what makes a
 * "store review" a review row grouped by `sellerId`.
 *
 * `verifiedPurchase` defaults to true because reviews are only created from a
 * delivered order line the user actually owns — the simulator's eligibility
 * rule — rather than a claim the reviewer makes. Store-side counters
 * (product + store rating aggregates) are denormalised by services from these
 * rows; the seller may attach one `sellerReply`.
 */
const sellerReplySchema = new Schema({
    text: {
        type: String,
        required: true
    },

    at: {
        type: Date,
        default: Date.now
    }
}, { _id: false });

const reviewSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    userName: {
        type: String,
        default: ""
    },

    productId: {
        type: Schema.Types.ObjectId,
        ref: "Product",
        required: true
    },

    sellerId: {
        type: Schema.Types.ObjectId,
        ref: "SellerProfile",
        required: true
    },

    orderItemId: {
        type: String,
        required: true,
        unique: true
    },

    orderId: {
        type: Schema.Types.ObjectId,
        ref: "Order",
        required: true
    },

    rating: {
        type: Number,
        required: [true, "rating is required"],
        min: 1,
        max: 5
    },

    title: {
        type: String,
        default: ""
    },

    text: {
        type: String,
        default: ""
    },

    images: {
        type: [String],
        default: []
    },

    verifiedPurchase: {
        type: Boolean,
        default: true
    },

    sellerReply: {
        type: sellerReplySchema,
        default: null
    },

    helpfulCount: {
        type: Number,
        default: 0,
        min: 0
    }
}, { timestamps: true });

reviewSchema.index({ productId: 1 });
reviewSchema.index({ sellerId: 1, createdAt: -1 });

export const Review = mongoose.model("Review", reviewSchema);