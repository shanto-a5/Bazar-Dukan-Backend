import mongoose, { Schema } from "mongoose";

/**
 * A customer's saved delivery address (M13).
 *
 * Flat BD address shape, mirroring `Address` in the frontend
 * (`src/domain/types/user.ts`): `instructions` is optional and stored as
 * `null` when blank, `label` falls back to "Address", and `isDefault` holds
 * the single-default invariant maintained by the address service.
 *
 * `{ userId: 1, createdAt: 1 }` serves both the list order (insertion order,
 * oldest first) and the default lookup.
 */
const addressSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },

    label: {
        type: String,
        default: "Address",
        trim: true
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
        required: true,
        trim: true
    },

    district: {
        type: String,
        required: true,
        trim: true
    },

    area: {
        type: String,
        default: "",
        trim: true
    },

    addressLine: {
        type: String,
        required: true,
        trim: true
    },

    postalCode: {
        type: String,
        default: "",
        trim: true
    },

    instructions: {
        type: String,
        default: null
    },

    isDefault: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

addressSchema.index({ userId: 1, createdAt: 1 });

export const Address = mongoose.model("Address", addressSchema);