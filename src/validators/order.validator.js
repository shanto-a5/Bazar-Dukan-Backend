/**
 * Checkout and order input validation.
 *
 * Two shapes of address are accepted interchangeably — the simulator's
 * `{ recipientName, phone, division, district, area, addressLine, ... }` and
 * the imported backend's `{ fullName, phone, line1, line2, city, district,
 * postalCode, note }` — and normalised onto the Order address snapshot. The
 * five fields the imported backend demands (recipient name, phone, division,
 * district, address line) are required here too, with its exact wording, and
 * every problem is reported in ONE 422 like every other Vanta validator.
 *
 * Unknown checkout body keys (`total`, `subtotal`, `items`, `sellerId`) are
 * deliberately ignored: the server re-prices the cart itself and never trusts
 * a client-supplied number, so a hostile extra field is not a validation
 * failure. Only the keys this slice acts on are read.
 */
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { isDeliveryMethod } from "../core/delivery.js";

const PAYMENT_METHODS = ["cod", "bkash", "nagad", "card"];
export const DEFAULT_DELIVERY_METHOD = "standard";

const validationError = (fields) =>
    new ApiError(422, "Please fix the highlighted fields.", fields, "", "validation_failed");

const trimish = (value) => (typeof value === "string" ? value.trim() : "");

const isBlankString = (value) => !(typeof value === "string" && value.trim() !== "");

/** The stored address the snapshot keeps: recipientName/phone/division + the rest. */
const ADDRESS_FIELDS = [
    ["recipientName", "Recipient name"],
    ["phone", "Phone number"],
    ["division", "Division"],
    ["district", "District"],
    ["addressLine", "Address"]
];

/**
 * Normalises either accepted address shape onto the Order snapshot.
 *
 * SQL-ish fallbacks cover the task shape, whose `city` doubles as the
 * division: `division ?? city`, and whose `area` is derived from the district
 * when not supplied so the snapshot's required `area` stays populated.
 *
 * @returns {object} the mapped address ready to embed in an Order.
 */
export function resolveAddress(input) {
    const raw = input && typeof input === "object" && !Array.isArray(input) ? input : {};

    const joinLines = () => {
        const line1 = trimish(raw.line1);
        const line2 = trimish(raw.line2);
        const addressLine = trimish(raw.addressLine);
        if (addressLine) return addressLine;
        return [line1, line2].filter(Boolean).join(", ");
    };

    const address = {
        label: trimish(raw.label),
        recipientName: trimish(raw.fullName) || trimish(raw.recipientName),
        phone: trimish(raw.phone),
        division: trimish(raw.division) || trimish(raw.city),
        district: trimish(raw.district),
        area: trimish(raw.area) || trimish(raw.district) || trimish(raw.city),
        addressLine: joinLines(),
        postalCode: trimish(raw.postalCode),
        instructions: trimish(raw.instructions) || trimish(raw.note),
        isDefault: Boolean(raw.isDefault)
    };

    const fields = ADDRESS_FIELDS.filter(([key]) => isBlankString(address[key])).map(([key, message]) => ({
        field: key,
        message: `${message} is required.`
    }));
    if (fields.length > 0) throw validationError(fields);

    return address;
}

/** A payment method must be one of the four Vanta accepts. */
export function resolvePaymentMethod(value) {
    if (!PAYMENT_METHODS.includes(value)) {
        throw validationError([{ field: "paymentMethod", message: "Choose a payment method." }]);
    }
    return value;
}

/** Absent means "use the default"; anything else must be a known method. */
export function resolveDeliveryMethod(value) {
    if (value === undefined || value === null || value === "") return DEFAULT_DELIVERY_METHOD;
    if (!isDeliveryMethod(value)) {
        throw validationError([{ field: "deliveryMethod", message: "Choose a delivery method." }]);
    }
    return value;
}

/** Optional voucher code: only plain text up to the shared code length. */
export function resolveVoucherCode(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") {
        throw validationError([{ field: "voucherCode", message: "That voucher code is not valid." }]);
    }
    return value.trim().toUpperCase();
}

/** Optional client idempotency key, capped like every Vanta key. */
export function resolveIdempotencyKey(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") {
        throw validationError([{ field: "idempotencyKey", message: "Use at most 80 characters." }]);
    }
    const key = value.trim();
    if (key.length > 80) {
        throw validationError([{ field: "idempotencyKey", message: "Use at most 80 characters." }]);
    }
    return key;
}

/**
 * Optional cancellation reason, up to 400 characters of plain text. Empty is
 * treated as absent; a non-string is a validation error.
 */
export function resolveCancelReason(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") {
        throw validationError([{ field: "reason", message: "Tell the seller why you cancelled." }]);
    }
    const reason = value.trim();
    if (reason.length > 400) {
        throw validationError([{ field: "reason", message: "Keep the reason under 400 characters." }]);
    }
    return reason;
}

/** A path id that is not a real ObjectId can never match anything: 404. */
export function requireObjectId(value, message) {
    if (!mongoose.isValidObjectId(value)) {
        throw new ApiError(404, message, [], "", "not_found");
    }
    return String(value);
}

/**
 * Reads the keys checkout actually acts on and silently drops everything else.
 * The client may send whole-cart previews and totals; none of them are money or
 * ownership this server honours.
 *
 * @returns {object} `{ address, paymentMethod, deliveryMethod, voucherCode, idempotencyKey }`
 */
export function normaliseCheckoutBody(raw) {
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
        address: resolveAddress(body.address),
        paymentMethod: resolvePaymentMethod(body.paymentMethod),
        deliveryMethod: resolveDeliveryMethod(body.deliveryMethod),
        voucherCode: resolveVoucherCode(body.voucherCode),
        idempotencyKey: resolveIdempotencyKey(body.idempotencyKey)
    };
}

/** Normalises just the optional bits a preview accepts, keeping money out of it. */
export function normalisePreviewBody(raw) {
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
        address: body.address !== undefined ? resolveAddress(body.address) : null,
        paymentMethod: body.paymentMethod !== undefined ? resolvePaymentMethod(body.paymentMethod) : null,
        deliveryMethod: resolveDeliveryMethod(body.deliveryMethod),
        voucherCode: resolveVoucherCode(body.voucherCode)
    };
}