import { ApiError } from "../utils/ApiError.js";

/**
 * Review input validation — the exact rules and wording of the simulator's
 * `src/services/review-service.ts`, collected into ONE 422 like every other
 * Vanta validator.
 *
 * Field order follows the order the simulator throws in: rating, headline,
 * body text, then the order line ("Order item not found."). The envelope's
 * top-level `message` is therefore the message the simulator would have shown
 * first, while `error.fields` still carries every offending input at once, so
 * a form can highlight all of them in a single round trip.
 *
 * Body keys the service does not act on are read key by key and ignored, the
 * way the simulator builds its input — a hostile extra `userId`,
 * `verifiedPurchase` or `sellerReply` simply has nowhere to land. The four
 * optional match ids (`orderId`, `sellerOrderId`, `productId`, `sellerId`) are
 * the simulator's "This review does not match the delivered order item."
 * inputs: they are extracted here and compared against the real eligibility
 * outcome in the service, because only the datastore knows which line is real.
 *
 * `images` is the one place the simulator would crash rather than answer
 * (`.slice()` on a non-array is a TypeError): here a malformed value is a
 * field error instead of a 500, and a well-formed list keeps at most the
 * simulator's 4 newest entries with non-strings dropped.
 */
const MIN_TITLE = 3;
const MAX_TITLE = 80;
const MIN_TEXT = 10;
const MAX_TEXT = 1000;
const MAX_IMAGES = 4;
const MIN_REPLY = 5;

const MESSAGES = {
    notObject: "Request body must be an object.",
    rating: "Choose a rating between 1 and 5.",
    titleMin: "Add a short headline for your review.",
    titleMax: `Keep the headline under ${MAX_TITLE} characters.`,
    textMin: "Tell other shoppers a little more (at least 10 characters).",
    textMax: `Keep the review under ${MAX_TEXT} characters.`,
    orderItemId: "Order item not found.",
    images: `Attach up to ${MAX_IMAGES} images.`,
    replyMin: "Write a slightly longer reply (at least 5 characters).",
    replyMax: `Keep the reply under ${MAX_TEXT} characters.`
};

/** Top-level message = the first problem in simulator order; all stay in `fields`. */
const validationError = (fields) =>
    new ApiError(422, fields[0].message, fields, "", "validation_failed");

const notObject = () => new ApiError(422, MESSAGES.notObject, [], "", "validation_failed");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const trimish = (value) => (typeof value === "string" ? value.trim() : "");

/** `1..5` integers after truncation, exactly the simulator's `Math.trunc` bound. */
const checkRating = (value, fields) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fields.push({ field: "rating", message: MESSAGES.rating });
        return null;
    }
    const rating = Math.trunc(value);
    if (rating < 1 || rating > 5) {
        fields.push({ field: "rating", message: MESSAGES.rating });
        return null;
    }
    return rating;
};

const checkTitle = (value, fields) => {
    const title = trimish(value);
    if (title.length < MIN_TITLE) fields.push({ field: "title", message: MESSAGES.titleMin });
    else if (title.length > MAX_TITLE) fields.push({ field: "title", message: MESSAGES.titleMax });
    return title;
};

const checkText = (value, fields) => {
    const text = trimish(value);
    if (text.length < MIN_TEXT) fields.push({ field: "text", message: MESSAGES.textMin });
    else if (text.length > MAX_TEXT) fields.push({ field: "text", message: MESSAGES.textMax });
    return text;
};

const checkImages = (value, fields) => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        fields.push({ field: "images", message: MESSAGES.images });
        return [];
    }
    return value.filter((entry) => typeof entry === "string").slice(0, MAX_IMAGES);
};

/** Optional simulator match ids; `null` means "the client did not send it". */
const pickMatchId = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * POST /reviews — `{ orderItemId, rating, title, text, images? }` plus the
 * simulator's four optional cross-check ids.
 *
 * @returns {{orderItemId: string, rating: number, title: string, text: string,
 *   images: string[], match: object}}
 */
const validateCreateReview = (body) => {
    if (!isPlainObject(body)) throw notObject();

    const fields = [];
    const rating = checkRating(body.rating, fields);
    const title = checkTitle(body.title, fields);
    const text = checkText(body.text, fields);
    const images = checkImages(body.images, fields);

    const orderItemId = trimish(body.orderItemId);
    if (orderItemId === "") fields.push({ field: "orderItemId", message: MESSAGES.orderItemId });

    if (fields.length > 0) throw validationError(fields);

    return {
        orderItemId,
        rating,
        title,
        text,
        images,
        match: {
            orderId: pickMatchId(body.orderId),
            sellerOrderId: pickMatchId(body.sellerOrderId),
            productId: pickMatchId(body.productId),
            sellerId: pickMatchId(body.sellerId)
        }
    };
};

/**
 * PATCH /reviews/:id — only `rating`, `title`, `text` and `images` are
 * writable, each validated only when present (the simulator's `!== undefined`
 * checks), and an empty patch is a no-op the same way it is there. No window:
 * the simulator lets the author edit at any time.
 *
 * @returns {object} the patch, built key by key.
 */
const validatePatchReview = (body) => {
    if (!isPlainObject(body)) throw notObject();

    const fields = [];
    const patch = {};

    if (body.rating !== undefined) {
        const rating = checkRating(body.rating, fields);
        if (rating !== null) patch.rating = rating;
    }
    if (body.title !== undefined) {
        const title = checkTitle(body.title, fields);
        if (title.length >= MIN_TITLE && title.length <= MAX_TITLE) patch.title = title;
    }
    if (body.text !== undefined) {
        const text = checkText(body.text, fields);
        if (text.length >= MIN_TEXT && text.length <= MAX_TEXT) patch.text = text;
    }
    if (body.images !== undefined) {
        const images = checkImages(body.images, fields);
        if (Array.isArray(body.images)) patch.images = images;
    }

    if (fields.length > 0) throw validationError(fields);
    return patch;
};

/**
 * POST /seller/reviews/:id/reply — `{ reply }`, trimmed, 5..1000 characters,
 * with the simulator's exact wording. Re-replying is not an error anywhere in
 * the simulator: a second reply overwrites the first, and this validator only
 * decides whether the text itself is acceptable.
 *
 * @returns {{reply: string}}
 */
const validateReply = (body) => {
    if (!isPlainObject(body)) throw notObject();

    const fields = [];
    const reply = trimish(body.reply);
    if (reply.length < MIN_REPLY) fields.push({ field: "reply", message: MESSAGES.replyMin });
    else if (reply.length > MAX_TEXT) fields.push({ field: "reply", message: MESSAGES.replyMax });

    if (fields.length > 0) throw validationError(fields);
    return { reply };
};

export { validateCreateReview, validatePatchReview, validateReply };
