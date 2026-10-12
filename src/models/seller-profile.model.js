import mongoose, { Schema } from "mongoose";

/**
 * The Vanta seller application and profile.
 *
 * One document per user (`userId` is unique): a user can never have more than
 * one seller account, and `requireSeller` authorises every `/seller/*` route by
 * resolving the authenticated user to this document — never from the request
 * body. The server derives ownership, so a client that names a sellerId it
 * does not own is simply not that seller.
 *
 * `status` is server-controlled. An application starts as `pending`, a
 * `seller_approver` moves it to `active` (granting the `seller` role on the
 * user) or `rejected`, and an operator can `suspend` a live account later.
 * The address fields are flat strings, mirroring the simulator's
 * `pickupDivision`/`pickupDistrict`/`pickupArea`/`pickupAddressLine` shape.
 *
 * The store-intent fields (`storeName`, `storeDescription`, `logo`, `banner`)
 * ride on the application because the store document is only created once the
 * account is approved.
 */
const bankSchema = new Schema({
    bankName: {
        type: String,
        required: [true, "bank name is required"],
        trim: true
    },

    accountName: {
        type: String,
        required: [true, "account name is required"],
        trim: true
    },

    accountNumber: {
        type: String,
        required: [true, "account number is required"],
        trim: true
    },

    branch: {
        type: String,
        default: ""
    }
}, { _id: false });

const agreementSchema = new Schema({
    marketplaceTerms: {
        type: Boolean,
        default: false
    },

    sellerPolicies: {
        type: Boolean,
        default: false
    },

    productAuthenticity: {
        type: Boolean,
        default: false
    },

    fulfillmentResponsibility: {
        type: Boolean,
        default: false
    }
}, { _id: false });

/**
 * One entry of the append-only approval trail.
 *
 * `decision` is the outcome, `actorId`/`actorLabel` identify the operator who
 * made it (the approver's user id/email over HTTP, `dev-cli` for the
 * development `api:approve-seller` tool), `at` is when, and `note` carries a
 * rejection reason when there was one. Entries are only ever pushed — see
 * `approveApplication` / `rejectApplication` in `src/services/seller.service.js`
 * — so a decision that already happened can never be rewritten.
 */
const decisionEntrySchema = new Schema({
    decision: {
        type: String,
        enum: ["approved", "rejected"],
        required: true
    },

    actorId: {
        type: String,
        required: true
    },

    actorLabel: {
        type: String,
        default: ""
    },

    at: {
        type: Date,
        default: Date.now
    },

    note: {
        type: String,
        default: ""
    }
}, { _id: false });

const sellerProfileSchema = new Schema({
    userId: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
        unique: true
    },

    fullName: {
        type: String,
        required: [true, "full name is required"],
        trim: true
    },

    phone: {
        type: String,
        required: [true, "phone is required"],
        trim: true
    },

    email: {
        type: String,
        required: [true, "email is required"],
        lowercase: true,
        trim: true
    },

    nationalId: {
        type: String,
        required: [true, "national ID is required"],
        trim: true
    },

    sellerType: {
        type: String,
        enum: ["individual", "business"],
        required: true
    },

    entityName: {
        type: String,
        default: ""
    },

    storeName: {
        type: String,
        required: [true, "store name is required"],
        trim: true
    },

    storeDescription: {
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

    pickupDivision: {
        type: String,
        default: ""
    },

    pickupDistrict: {
        type: String,
        default: ""
    },

    pickupArea: {
        type: String,
        default: ""
    },

    pickupAddressLine: {
        type: String,
        default: ""
    },

    returnDivision: {
        type: String,
        default: ""
    },

    returnDistrict: {
        type: String,
        default: ""
    },

    returnArea: {
        type: String,
        default: ""
    },

    returnAddressLine: {
        type: String,
        default: ""
    },

    bank: {
        type: bankSchema,
        required: true
    },

    agreement: {
        type: agreementSchema,
        required: true
    },

    status: {
        type: String,
        enum: ["pending", "active", "rejected", "suspended"],
        default: "pending"
    },

    appliedAt: {
        type: Date,
        default: Date.now
    },

    decidedAt: {
        type: Date,
        default: null
    },

    decisionNote: {
        type: String,
        default: ""
    },

    // The append-only record of every decision ever made on this application.
    // `status` / `decidedAt` / `decisionNote` above stay the mutable
    // current-state view of the LATEST decision; this array is never rewritten,
    // only appended to (one entry per successful approve/reject).
    decisionHistory: {
        type: [decisionEntrySchema],
        default: []
    }
}, { timestamps: true });

export const SellerProfile = mongoose.model("SellerProfile", sellerProfileSchema);