import { ApiError } from "../utils/ApiError.js";
import { emailValidator } from "../utils/helper/email.validator.js";
import { PHONE_PATTERN } from "../constance.js";
import { roundMoney } from "../core/money.js";

/**
 * Request validation for the seller surface.
 *
 * Same contract as `auth.validator.js`: one 422 / `validation_failed` carrying
 * *every* offending field at once, shaped `{ field, message }`, so a form can
 * highlight every problem in a single round trip. The customer-facing strings
 * are the ones the simulator's apply form already shows
 * (`src/app/(seller)/seller-apply.tsx` and `seller-store-settings.tsx`), so a
 * person sees the same wording whichever surface validates their input.
 *
 * Nothing here reads identity: the caller's user id arrives from
 * `req.user` / `req.sellerProfile` in the controller, never from the body.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Trimmed string, or "" for anything a client should have sent as text. */
const readText = (body, key) => (typeof body[key] === "string" ? body[key].trim() : "");

/** The four checkboxes, with the exact label each one shows in the UI. */
const AGREEMENT_LABELS = Object.freeze({
    marketplaceTerms: "I accept the marketplace terms.",
    sellerPolicies: "I accept the seller policies.",
    productAuthenticity: "Everything I list is genuine.",
    fulfillmentResponsibility: "I am responsible for fulfilling orders."
});

const ADDRESS_FIELDS = [
    "pickupDivision",
    "pickupDistrict",
    "pickupArea",
    "pickupAddressLine",
    "returnDivision",
    "returnDistrict",
    "returnArea",
    "returnAddressLine"
];

/**
 * POST /seller/register body — the simulator's `BecomeSellerInput`.
 *
 * Every rule mirrors the apply form: name 2+, phone per PHONE_PATTERN, email
 * per the shared email rule, national id 4+, store name 2+, a store
 * description of at least a sentence, bank fields, and all four agreements
 * accepted. `entityName` is only demanded for a business seller. The return
 * value is built key by key, so a key that is not named here — `status`,
 * `agreement` extras, anything server-controlled — has nowhere to land.
 */
const validateBecomeSeller = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];

    const fullName = readText(body, "fullName");
    const phone = readText(body, "phone");
    const email = readText(body, "email").toLowerCase();
    const nationalId = readText(body, "nationalId");
    const sellerType = readText(body, "sellerType");
    const entityName = readText(body, "entityName");
    const storeName = readText(body, "storeName");
    const storeDescription = readText(body, "storeDescription");
    const storeLogo = readText(body, "storeLogo");
    const storeBanner = readText(body, "storeBanner");
    const bankName = readText(body, "bankName");
    const accountName = readText(body, "accountName");
    const accountNumber = readText(body, "accountNumber");
    const branch = readText(body, "branch");

    if (fullName.length < 2) fields.push({ field: "fullName", message: "Enter your full name." });
    if (!PHONE_PATTERN.test(phone)) fields.push({ field: "phone", message: "Enter a valid phone number." });
    if (!emailValidator(email)) fields.push({ field: "email", message: "Enter a valid email address." });
    if (nationalId.length < 4) fields.push({ field: "nationalId", message: "Enter your national ID." });

    if (sellerType !== "individual" && sellerType !== "business") {
        fields.push({ field: "sellerType", message: "Choose an individual or a business account." });
    }
    if (sellerType === "business" && entityName === "") {
        fields.push({ field: "entityName", message: "Enter the registered entity name." });
    }

    if (storeName.length < 2) fields.push({ field: "storeName", message: "Enter a store name." });
    if (storeDescription.length < 10) {
        fields.push({ field: "storeDescription", message: "Describe your store in a sentence or two." });
    }
    if (storeLogo.length > 1024) fields.push({ field: "storeLogo", message: "That image reference is too long." });
    if (storeBanner.length > 1024) fields.push({ field: "storeBanner", message: "That image reference is too long." });

    // Addresses are optional text — the apply form does not gate on them — but
    // they still cannot be arbitrarily large.
    const address = {};
    for (const key of ADDRESS_FIELDS) {
        const value = readText(body, key);
        const limit = key.endsWith("AddressLine") ? 300 : 200;
        if (value.length > limit) fields.push({ field: key, message: "That address is too long." });
        address[key] = value;
    }

    if (bankName.length < 2) fields.push({ field: "bankName", message: "Enter your bank name." });
    if (accountName.length < 2) fields.push({ field: "accountName", message: "Enter the account holder name." });
    if (accountNumber.length < 4) fields.push({ field: "accountNumber", message: "Enter your account number." });

    // All four agreements, each reported under its own name so the form can
    // mark the exact checkbox that is still unticked.
    const agreementBody = isPlainObject(body.agreement) ? body.agreement : {};
    const agreement = {};
    for (const [key, label] of Object.entries(AGREEMENT_LABELS)) {
        agreement[key] = agreementBody[key] === true;
        if (!agreement[key]) fields.push({ field: key, message: label });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);

    return {
        fullName,
        phone,
        email,
        nationalId,
        sellerType,
        entityName,
        storeName,
        storeDescription,
        storeLogo,
        storeBanner,
        ...address,
        bank: { bankName, accountName, accountNumber, branch },
        agreement
    };
};

/**
 * Fields a seller may edit on their own store. Everything else — `sellerId`,
 * `status`, the rating/counter aggregates, `verified`, `id` — is server-owned
 * and rejected by name rather than silently dropped, so the client learns the
 * rule instead of believing a write it never made.
 */
const STORE_PATCH_FIELDS = [
    "name",
    "description",
    "logo",
    "banner",
    "shippingFee",
    "freeShippingThreshold",
    "deliveryEstimateDays",
    "location"
];

/**
 * PATCH /seller/store body.
 *
 * Only the editable store settings the store-settings screen writes, with the
 * same messages that screen shows for a bad value. Money goes through
 * `roundMoney` so the stored figure is the one checkout will compute with.
 */
const validateStorePatch = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    const patch = {};

    for (const key of Object.keys(body)) {
        if (!STORE_PATCH_FIELDS.includes(key)) {
            fields.push({ field: key, message: `${key} cannot be set from a request.` });
        }
    }

    if (body.name !== undefined) {
        const name = readText(body, "name");
        if (name.length < 3) fields.push({ field: "name", message: "Enter a store name of at least 3 characters." });
        else patch.name = name;
    }

    if (body.description !== undefined) {
        const description = readText(body, "description");
        if (description.length > 2000) {
            fields.push({ field: "description", message: "Store description must be 2000 characters or fewer." });
        } else patch.description = description;
    }

    for (const key of ["logo", "banner"]) {
        if (body[key] === undefined) continue;
        const value = readText(body, key);
        if (value.length > 1024) fields.push({ field: key, message: "That image reference is too long." });
        else patch[key] = value;
    }

    if (body.shippingFee !== undefined) {
        const fee = body.shippingFee;
        if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) {
            fields.push({ field: "shippingFee", message: "Enter a delivery fee of 0 or more." });
        } else patch.shippingFee = roundMoney(fee);
    }

    if (body.freeShippingThreshold !== undefined) {
        const threshold = body.freeShippingThreshold;
        if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) {
            fields.push({ field: "freeShippingThreshold", message: "Enter a free-delivery threshold of 0 or more." });
        } else patch.freeShippingThreshold = roundMoney(threshold);
    }

    if (body.deliveryEstimateDays !== undefined) {
        const estimate = body.deliveryEstimateDays;
        const min = isPlainObject(estimate) ? estimate.min : undefined;
        const max = isPlainObject(estimate) ? estimate.max : undefined;
        const usable = Number.isInteger(min) && Number.isInteger(max) && min >= 0 && max >= min;
        if (!usable) {
            fields.push({
                field: "deliveryEstimateDays",
                message: "Delivery days must be whole numbers, with the maximum at least the minimum."
            });
        } else patch.deliveryEstimateDays = { min, max };
    }

    if (body.location !== undefined) {
        const location = readText(body, "location");
        if (location.length > 200) {
            fields.push({ field: "location", message: "Location must be 200 characters or fewer." });
        } else patch.location = location;
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    if (Object.keys(patch).length === 0) throw validationError("No store fields were provided.", []);

    return patch;
};

/**
 * POST /seller/store/status body. The store has exactly two states, so
 * anything else is a field error rather than a guess.
 */
const validateStoreStatus = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const status = readText(body, "status");
    if (status !== "active" && status !== "paused") {
        throw validationError("Please fix the highlighted fields.", [
            { field: "status", message: "Store status must be active or paused." }
        ]);
    }
    return { status };
};

/** POST /approvals/sellers/:id/reject body — an optional reviewer note. */
const validateDecisionNote = (body) => {
    if (body === undefined || body === null) return { note: "" };
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const note = readText(body, "note");
    if (note.length > 500) {
        throw validationError("Please fix the highlighted fields.", [
            { field: "note", message: "The note must be 500 characters or fewer." }
        ]);
    }
    return { note };
};

export {
    validationError,
    validateBecomeSeller,
    validateStorePatch,
    validateStoreStatus,
    validateDecisionNote
};
