import mongoose, { Schema } from "mongoose";

/**
 * A product category in the category tree.
 *
 * Categories form a forest: `parentId` points at another Category (or null for
 * a top-level category) and `order` sorts siblings, so the tree is rendered as
 * "same level, ordered" exactly like the simulator (`parentId` + `order`).
 * `subcategoryId` on products references these same documents.
 */
const categorySchema = new Schema({
    name: {
        type: String,
        required: [true, "category name is required"],
        trim: true
    },

    icon: {
        type: String,
        default: ""
    },

    image: {
        type: String,
        default: ""
    },

    parentId: {
        type: Schema.Types.ObjectId,
        ref: "Category",
        default: null
    },

    order: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

categorySchema.index({ parentId: 1, order: 1 });

export const Category = mongoose.model("Category", categorySchema);