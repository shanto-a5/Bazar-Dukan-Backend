import mongoose, { Schema } from "mongoose";

/**
 * A product in a seller's catalog.
 *
 * `sellerId` and `storeId` are set from the authenticated seller, never from
 * the request body — `requireSeller` resolves the actor and the product is
 * owned by that profile. `status` is server-authoritative: a draft is invisible
 * to buyers, a paused product is hidden, and `out_of_stock` is derived by
 * inventory services rather than typed by a client.
 *
 * Prices are the price data used by checkout: `regularPrice` is the base,
 * `salePrice` (when present) is the current customer price, and `costPrice`
 * never leaves this process beyond admin use. Variants are embedded documents;
 * when `hasVariants` is true the sellable units are the variants and product
 * `stock` is the aggregate across them.
 *
 * Search is substring-based in the simulator, so no text index exists here:
 * the compound status-aware indexes below serve the public listings.
 */
const variantSchema = new Schema({
    sku: {
        type: String,
        required: true,
        trim: true
    },

    attributes: {
        type: Map,
        of: String,
        default: {}
    },

    price: {
        type: Number,
        required: true,
        min: 0
    },

    compareAtPrice: {
        type: Number,
        default: null,
        min: 0
    },

    stock: {
        type: Number,
        default: 0,
        min: 0
    },

    image: {
        type: String,
        default: ""
    }
});

const productSchema = new Schema({
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

    name: {
        type: String,
        required: [true, "product name is required"],
        trim: true
    },

    brand: {
        type: String,
        default: "",
        trim: true
    },

    categoryId: {
        type: Schema.Types.ObjectId,
        ref: "Category",
        required: true
    },

    subcategoryId: {
        type: Schema.Types.ObjectId,
        ref: "Category",
        default: null
    },

    description: {
        type: String,
        default: ""
    },

    highlights: {
        type: [String],
        default: []
    },

    images: {
        type: [String],
        default: []
    },

    video: {
        type: {
            placeholder: { type: String, default: "" },
            uri: { type: String, default: "" }
        },
        default: null
    },

    regularPrice: {
        type: Number,
        required: true,
        min: 0
    },

    salePrice: {
        type: Number,
        default: null,
        min: 0
    },

    costPrice: {
        type: Number,
        default: null,
        min: 0
    },

    sku: {
        type: String,
        required: [true, "SKU is required"],
        trim: true
    },

    stock: {
        type: Number,
        default: 0,
        min: 0
    },

    lowStockThreshold: {
        type: Number,
        default: 5,
        min: 0
    },

    variants: {
        type: [variantSchema],
        default: []
    },

    hasVariants: {
        type: Boolean,
        default: false
    },

    status: {
        type: String,
        enum: ["draft", "pending", "active", "paused", "out_of_stock", "archived"],
        default: "draft"
    },

    publishedAt: {
        type: Date,
        default: null
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

    soldCount: {
        type: Number,
        default: 0,
        min: 0
    },

    viewCount: {
        type: Number,
        default: 0,
        min: 0
    },

    isNewArrival: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

productSchema.index({ sellerId: 1, status: 1 });
productSchema.index({ storeId: 1, status: 1 });
productSchema.index({ categoryId: 1, status: 1 });

export const Product = mongoose.model("Product", productSchema);