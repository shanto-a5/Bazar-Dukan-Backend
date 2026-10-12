/**
 * Return request input validation (slice "returns + refunds", milestone M12).
 *
 * Mirrors the simulator's `OrderService.requestReturn` input contract from
 * `src/services/order-service.ts` (the SPEC): one entry per order line, keyed
 * by `lineId` (the simulator's `orderItemId`, `orderItemId` is accepted as the
 * alias the model uses), an optional whole-unit `quantity`, one of the seven
 * `ReturnReason` values, a note (the simulator's `description`), optional
 * `images` and the optional refund/replacement resolution.
 *
 * Structural problems are collected and reported in ONE 422, exactly like
 * `validators/auth.validator.js`. The line-dependent rules — delivery state,
 * one-open-per-line, the `[1..returnable]` quantity range — need the order
 * line itself, so they live in the service and keep the simulator's wording
 * verbatim (see `services/return.service.js`).
 */
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";

const RETURN_REASONS = [
    "damaged",
    "defective",
    "wrong_item",
    "missing_item",
    "does_not_match_description",
    "incorrect_size",
    "other"
];

const RETURN_STATUSES = ["pending", "approved", "rejected", "returned", "refunded"];

const RESOLUTIONS = ["refund", "replacement"];

const MAX_ITEMS = 20;
const MAX_NOTE_LENGTH = 1000;
const MAX_IMAGES = 10;
const MAX_IMAGE_LENGTH = 1024;

const validationError = (fields, message = "Please fix the highlighted fields.") =>
    new ApiError(422, message, fields, "", "validation_failed");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const trimish = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * A path id that is not a real ObjectId can never match anything: 404 with the
 * caller's message, so an unknown and a malformed id answer identically.
 */
export function requireObjectId(value, message) {
    if (!mongoose.isValidObjectId(value)) {
        throw new ApiError(404, message, [], "", "not_found");
    }
    return String(value);
}

/**
 * Normalises the POST /orders/:orderId/returns body onto one plan entry per
 * order line.
 *
 * `lineId` and `orderItemId` are two names for the same input (the task shape
 * and the simulator/model shape); `note` and `description` likewise, with
 * `note` winning when both arrive.
 *
 * @returns {object} `{ items: [{ lineId, quantity, reason, description, images, preferredResolution }] }`
 */
export function normaliseReturnBody(raw) {
    if (!isPlainObject(raw)) throw validationError([], "Request body must be an object.");

    const fields = [];
    if (!Array.isArray(raw.items) || raw.items.length === 0) {
        throw validationError(
            [{ field: "items", message: "Add at least one item to return." }],
            "Add at least one item to return."
        );
    }
    if (raw.items.length > MAX_ITEMS) {
        fields.push({ field: "items", message: `Return at most ${MAX_ITEMS} items at a time.` });
    }

    const entries = raw.items.map((entry, index) => {
        const at = (key) => `items[${index}].${key}`;
        const row = isPlainObject(entry) ? entry : null;
        if (!row) {
            fields.push({ field: at("lineId"), message: "Name the item you want to return." });
            return null;
        }

        const lineId = trimish(row.lineId) || trimish(row.orderItemId);
        if (lineId === "") {
            fields.push({ field: at("lineId"), message: "Name the item you want to return." });
        }

        const reason = trimish(row.reason);
        if (reason === "") {
            fields.push({ field: at("reason"), message: "Choose a reason for this return." });
        } else if (!RETURN_REASONS.includes(reason)) {
            fields.push({ field: at("reason"), message: "That return reason is not supported." });
        }

        // Absent/null means "every remaining unit" (the model's own default).
        // Anything else passes straight through: only the service knows the
        // line's returnable quantity, and the simulator answers a bad count
        // with one range message that folds the integer and bound checks
        // together (`Enter a return quantity between 1 and N.`).
        const quantity = row.quantity === undefined || row.quantity === null ? null : row.quantity;

        const description = trimish(row.note) || trimish(row.description);
        if (description.length > MAX_NOTE_LENGTH) {
            fields.push({ field: at("note"), message: `Keep the note under ${MAX_NOTE_LENGTH} characters.` });
        }

        let images = [];
        if (row.images !== undefined && row.images !== null) {
            if (!Array.isArray(row.images)) {
                fields.push({ field: at("images"), message: "Images must be a list." });
            } else if (row.images.length > MAX_IMAGES) {
                fields.push({ field: at("images"), message: `Attach at most ${MAX_IMAGES} images.` });
            } else if (row.images.some((image) => typeof image !== "string" || image.length > MAX_IMAGE_LENGTH)) {
                fields.push({ field: at("images"), message: "Each image must be a short link." });
            } else {
                images = row.images.map((image) => image.trim()).filter((image) => image !== "");
            }
        }

        let preferredResolution = "refund";
        if (row.preferredResolution !== undefined && row.preferredResolution !== null && row.preferredResolution !== "") {
            if (!RESOLUTIONS.includes(row.preferredResolution)) {
                fields.push({ field: at("preferredResolution"), message: "Choose refund or replacement." });
            } else {
                preferredResolution = row.preferredResolution;
            }
        }

        return { lineId, quantity, reason, description, images, preferredResolution };
    });

    if (fields.length > 0) throw validationError(fields);
    return { items: entries.filter(Boolean) };
}

/**
 * The seller list's `?status=` filter: absent means "every status", anything
 * else must be one of the five states the return state machine can hold.
 */
export function resolveStatusFilter(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || !RETURN_STATUSES.includes(value)) {
        throw validationError(
            [{ field: "status", message: "That return status is not supported." }],
            "That return status is not supported."
        );
    }
    return value;
}

export { RETURN_REASONS, RETURN_STATUSES, RESOLUTIONS };
