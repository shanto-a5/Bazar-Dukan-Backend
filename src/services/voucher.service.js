/**
 * Voucher domain service — validation, eligibility and seller management.
 *
 * Mirrors the simulator's `src/services/voucher-service.ts` (messages verbatim)
 * and delegates every eligibility decision to the ported core
 * (`core/voucher-rules.js` → `evaluateVoucherQuotes`); this file never
 * re-derives those rules, it only feeds them.
 *
 * Two shapes matter and are kept apart on purpose:
 *
 *   - the DTO (`toDto`) a client reads: `id`, never `_id`/`__v`, money rounded,
 *     `usageLimit`/`perUserLimit` as `null` when unlimited;
 *   - the rules view (`toRules`) the core evaluates: `sellerId`/`categoryId`
 *     as STRINGS (the cart's groups carry strings, so an ObjectId would never
 *     match a set lookup) and `usageLimit`/`perUserLimit` as `undefined` when
 *     unlimited — the core tests them with `!== undefined`, where the model's
 *     `null` default would read as "limit 0, already exhausted".
 *
 * The exported functions are a STABLE API other slices import:
 *
 *   findByCode(code)
 *   eligibleForCart({ userId, groups, subtotal, shippingTotal, now })
 *   quoteForResolved(voucher, { userId, groups, subtotal, shippingTotal, now })
 *   resolveForCheckout({ userId, code, groups, subtotal, shippingTotal })
 *   markUsed(voucherId, userId)
 *   validateDraft(input, { sellerId, voucherId })
 *   toSellerView(voucher)
 *   toDto(voucher)
 */
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { Category } from "../models/category.model.js";
import { voucherRepository } from "../repositories/voucher.repository.js";
import { evaluateVoucherQuotes } from "../core/voucher-rules.js";
import { roundMoney } from "../core/money.js";

/** After `trim().toUpperCase()`, exactly what the simulator accepts. */
const CODE_PATTERN = /^[A-Z0-9_-]{3,20}$/;
const VOUCHER_TYPES = ["percentage", "fixed", "free_shipping"];

const validationError = (fields) =>
    new ApiError(422, "Please fix the highlighted fields.", fields, "", "validation_failed");
const notFound = () => new ApiError(404, "Voucher not found.", [], "", "not_found");

const normaliseCode = (code) => String(code ?? "").trim().toUpperCase();

const isBlank = (value) => value === undefined || value === null || value === "";

const toPlain = (voucher) =>
    voucher && typeof voucher.toObject === "function" ? voucher.toObject() : { ...(voucher ?? {}) };

const asIso = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// ------------------------------------------------------------------ projections

/** Public projection: `id` as a string, never `_id`/`__v`, ids as strings. */
export function toDto(voucher) {
    if (!voucher) return null;
    const plain = toPlain(voucher);
    const dto = { ...plain, id: String(plain._id ?? plain.id ?? "") };
    delete dto._id;
    delete dto.__v;
    delete dto.perUserUsed;
    dto.sellerId = plain.sellerId ? String(plain.sellerId) : null;
    dto.categoryId = plain.categoryId ? String(plain.categoryId) : null;
    dto.usageLimit = plain.usageLimit ?? null;
    dto.perUserLimit = plain.perUserLimit ?? null;
    dto.maximumDiscount = plain.maximumDiscount ?? null;
    dto.productIds = Array.isArray(plain.productIds) ? plain.productIds.map(String) : [];
    dto.startAt = asIso(plain.startAt);
    dto.expiry = asIso(plain.expiry);
    return dto;
}

/**
 * The view the eligibility core consumes: same document, but with the two
 * "unlimited" limits expressed as `undefined` and every id as a string so the
 * cart's set lookups can actually match.
 */
const toRules = (voucher) => {
    const plain = toPlain(voucher);
    return {
        ...plain,
        id: String(plain._id ?? plain.id ?? ""),
        sellerId: plain.sellerId ? String(plain.sellerId) : undefined,
        categoryId: plain.categoryId ? String(plain.categoryId) : undefined,
        usageLimit: plain.usageLimit ?? undefined,
        perUserLimit: plain.perUserLimit ?? undefined,
        perUserUsed: plain.perUserUsed ?? {},
        productIds: Array.isArray(plain.productIds) ? plain.productIds.map(String) : []
    };
};

/** The exact quote payload the `/vouchers/eligible` endpoint returns. */
const toQuoteDto = (quote) => ({
    id: String(quote.voucher.id ?? quote.voucher._id ?? ""),
    code: quote.voucher.code,
    title: quote.voucher.title,
    type: quote.voucher.type,
    discountValue: quote.voucher.discountValue,
    scope: quote.voucher.scope,
    sellerId: quote.voucher.sellerId ? String(quote.voucher.sellerId) : null,
    categoryId: quote.voucher.categoryId ? String(quote.voucher.categoryId) : null,
    productIds: Array.isArray(quote.voucher.productIds) ? quote.voucher.productIds.map(String) : [],
    description: quote.voucher.description ?? "",
    minimumOrder: quote.voucher.minimumOrder,
    maximumDiscount: quote.voucher.maximumDiscount ?? null,
    expiry: asIso(quote.voucher.expiry),
    valid: Boolean(quote.valid),
    reason: quote.reason ?? null,
    discount: roundMoney(quote.discount ?? 0)
});

const discountLabel = (voucher) => {
    if (voucher.type === "percentage") {
        return voucher.maximumDiscount
            ? `${voucher.discountValue}% off, up to ${voucher.maximumDiscount}`
            : `${voucher.discountValue}% off`;
    }
    if (voucher.type === "fixed") return `${voucher.discountValue} off`;
    return "Free delivery";
};

/**
 * The seller's card for one voucher: the DTO plus the derived state, in the
 * simulator's priority order (inactive → expired → exhausted → scheduled →
 * live), the usage percentage and the human `problems` list.
 */
export function toSellerView(voucher, now = Date.now()) {
    const dto = toDto(voucher);
    const at = now instanceof Date ? now.getTime() : Number(now) || Date.now();

    const expired = Date.parse(dto.expiry ?? "") < at;
    const scheduled = Date.parse(dto.startAt ?? "") > at;
    const exhausted = dto.usageLimit !== null && dto.usageCount >= dto.usageLimit;
    const state = !dto.active
        ? "inactive"
        : expired
          ? "expired"
          : exhausted
            ? "exhausted"
            : scheduled
              ? "scheduled"
              : "live";

    const problems = [];
    if (!dto.active) problems.push("Disabled — customers cannot apply it.");
    if (expired) problems.push("Expired.");
    if (scheduled) problems.push("Starts later.");
    if (exhausted) problems.push("Usage limit reached.");
    if (dto.minimumOrder > 0) problems.push(`Needs a ${dto.minimumOrder} minimum.`);
    if (dto.productIds.length) problems.push(`Limited to ${dto.productIds.length} listing(s).`);
    if (dto.categoryId) problems.push("Limited to one category.");

    return {
        ...dto,
        state,
        usedByPercent:
            dto.usageLimit !== null && dto.usageLimit > 0
                ? Math.min(100, Math.round((dto.usageCount / dto.usageLimit) * 100))
                : 0,
        discountLabel: discountLabel(dto),
        problems
    };
}

// ------------------------------------------------------------------ lookups

/** Case-insensitive code lookup (codes are stored UPPERCASE). */
export async function findByCode(code) {
    const normalised = normaliseCode(code);
    if (!normalised) return null;
    return voucherRepository.findByCode(normalised);
}

/** The caller's own voucher, or a 404 — never somebody else's. */
export async function getForSeller(sellerId, voucherId) {
    const voucher = await voucherRepository.findById(voucherId);
    if (!voucher || voucher.scope !== "seller" || String(voucher.sellerId) !== String(sellerId)) {
        throw notFound();
    }
    return voucher;
}

/** The seller's own vouchers, newest first. */
export async function listForSeller(sellerId) {
    return voucherRepository.listForSeller(sellerId);
}

// ------------------------------------------------------------------ eligibility

/**
 * Every voucher the core quotes for this cart, best discount first, plus the
 * winning quote. Inactive and out-of-window vouchers are dropped by the core
 * (they are not quotes at all), which is what makes `resolveForCheckout` able
 * to answer "not found" for an expired code.
 */
export async function eligibleForCart({ userId, groups = [], subtotal = 0, shippingTotal = 0, now = Date.now() }) {
    const vouchers = await voucherRepository.listAll();
    const at = now instanceof Date ? now.getTime() : Number(now) || Date.now();
    const quotes = evaluateVoucherQuotes(vouchers.map(toRules), groups, subtotal, userId, at).map(toQuoteDto);
    const best = quotes.find((quote) => quote.valid) ?? null;
    return { quotes, best };
}

/**
 * The cart's single-code quote: the caller already resolved the document
 * (active + in-window) and this asks the core for its verdict on exactly the
 * groups being priced. Returns the `PricedCart.vouchers` entry shape, or null
 * when there is no resolved voucher at all.
 */
export function quoteForResolved(
    voucher,
    { userId = null, groups = [], subtotal = 0, shippingTotal = 0, now = Date.now() } = {}
) {
    if (!voucher) return null;
    const at = now instanceof Date ? now.getTime() : Number(now) || Date.now();
    const [quote] = evaluateVoucherQuotes([toRules(voucher)], groups, subtotal, userId, at);
    return {
        voucher: toDto(voucher),
        valid: Boolean(quote?.valid),
        discount: roundMoney(quote?.discount ?? 0),
        reason: quote?.reason ?? null
    };
}

/**
 * Checkout-time authority for one submitted code.
 *
 * An empty code is not an error (the customer simply is not using one); any
 * other failure is a 422 carrying either the core's own `reason` or the
 * generic fallback, so the customer sees why the code was refused.
 */
export async function resolveForCheckout({ userId, code, groups = [], subtotal = 0, shippingTotal = 0 }) {
    if (isBlank(code)) return { voucher: null };

    const normalised = normaliseCode(code);
    const { quotes } = await eligibleForCart({ userId, groups, subtotal, shippingTotal });
    const quote = quotes.find((entry) => normaliseCode(entry.code) === normalised);

    if (!quote) {
        throw new ApiError(422, "That voucher code could not be found.", [], "", "validation_failed");
    }
    if (!quote.valid) {
        throw new ApiError(422, quote.reason || "This voucher cannot be applied.", [], "", "validation_failed");
    }

    const voucher = await voucherRepository.findByCode(normalised);
    return { voucher: toDto(voucher) };
}

/**
 * One atomic redemption: `$inc` on the global tally and on this customer's
 * bucket in the same operation, so concurrent checkouts cannot lose a count.
 * The repository's conditional filter refuses a redemption that would cross a
 * usage or per-customer limit — that is reported as the core's own wording so
 * the customer sees the same message whichever layer noticed first.
 */
export async function markUsed(voucherId, userId) {
    const updated = await voucherRepository.markUsed(voucherId, userId ? String(userId) : null);
    if (!updated) throw new ApiError(422, "Usage limit reached", [], "", "validation_failed");
    return toDto(updated);
}

// ------------------------------------------------------------------ validation

/**
 * Full draft validation — ALL field problems reported in one 422, with the
 * simulator's exact wording. Returns the normalised draft ready to persist.
 *
 * `voucherId` makes this an update: the voucher must still exist and belong to
 * `sellerId` (otherwise 404 `Voucher not found.`), and `usageLimit` may not be
 * set below the tally already recorded.
 */
export async function validateDraft(input, { sellerId = null, voucherId = null } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw validationError([{ field: "body", message: "Request body must be an object." }]);
    }

    let current = null;
    if (voucherId) {
        current = await voucherRepository.findById(voucherId);
        if (!current) throw notFound();
        if (sellerId && !(current.scope === "seller" && String(current.sellerId) === String(sellerId))) {
            throw notFound();
        }
    }

    // A plain map (not an array) so a later rule can overwrite an earlier one
    // exactly as the simulator does — one message per field reaches the client.
    const errors = {};
    const reject = (field, message) => {
        errors[field] = message;
    };

    const code = normaliseCode(input.code);
    if (!CODE_PATTERN.test(code)) {
        reject("code", "Use 3-20 letters, numbers, dashes or underscores.");
    } else {
        const clash = await voucherRepository.findByCode(code);
        if (clash && String(clash._id) !== String(voucherId ?? "")) {
            if (sellerId && clash.scope === "seller" && String(clash.sellerId) === String(sellerId)) {
                reject("code", "You already have a voucher with this code.");
            } else {
                reject("code", "That code is already used on Vanta.");
            }
        }
    }

    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length < 3) reject("title", "Give the promotion a name customers will recognise.");

    const type = input.type;
    if (!VOUCHER_TYPES.includes(type)) {
        reject("type", "Choose percentage, fixed or free shipping.");
    }

    const discountValue = isBlank(input.discountValue) ? 0 : Number(input.discountValue);
    if (type === "percentage") {
        if (!Number.isFinite(discountValue) || discountValue <= 0 || discountValue > 100) {
            reject("discountValue", "A percentage discount must be between 1 and 100.");
        }
    } else if (type === "fixed") {
        if (!Number.isFinite(discountValue) || discountValue <= 0) {
            reject("discountValue", "Enter a discount greater than 0.");
        }
    } else if (type === "free_shipping" && discountValue !== 0) {
        reject("discountValue", "A free-delivery promotion does not use a discount amount.");
    }

    const minimumOrder = isBlank(input.minimumOrder) ? 0 : Number(input.minimumOrder);
    if (!Number.isFinite(minimumOrder) || minimumOrder < 0) {
        reject("minimumOrder", "The minimum spend cannot be negative.");
    }

    if (!isBlank(input.maximumDiscount)) {
        const cap = Number(input.maximumDiscount);
        if (!Number.isFinite(cap) || cap <= 0) {
            reject("maximumDiscount", "The maximum discount must be greater than 0, or clear it.");
        } else if (type === "percentage" && discountValue > 0) {
            if (cap > (minimumOrder || 0)) {
                reject("maximumDiscount", "The cap is above the minimum spend, so it can never apply.");
            }
        } else if (type === "fixed" && discountValue > 0 && cap < discountValue) {
            reject("maximumDiscount", "The cap is lower than the discount you set.");
        }
    }

    const startAt = isBlank(input.startAt) ? null : new Date(input.startAt);
    const expiry = isBlank(input.expiry) ? null : new Date(input.expiry);
    if (!startAt || Number.isNaN(startAt.getTime())) reject("startAt", "Choose a valid start date.");
    if (!expiry || Number.isNaN(expiry.getTime())) reject("expiry", "Choose a valid expiry date.");
    if (startAt && expiry && !Number.isNaN(startAt.getTime()) && !Number.isNaN(expiry.getTime())) {
        if (expiry.getTime() <= startAt.getTime()) {
            reject("expiry", "The expiry must be after the start date.");
        }
    }

    let usageLimit = null;
    if (!isBlank(input.usageLimit)) {
        usageLimit = Number(input.usageLimit);
        if (!Number.isInteger(usageLimit) || usageLimit < 1) {
            reject("usageLimit", "The usage limit must be a whole number of 1 or more.");
        } else if (current && usageLimit < (current.usageCount ?? 0)) {
            reject(
                "usageLimit",
                `This code was already used ${current.usageCount} time(s), so the limit cannot go below that.`
            );
        }
    }

    let perUserLimit = null;
    if (!isBlank(input.perUserLimit)) {
        perUserLimit = Number(input.perUserLimit);
        if (!Number.isInteger(perUserLimit) || perUserLimit < 1) {
            reject("perUserLimit", "The per-customer limit must be a whole number of 1 or more.");
        }
    }

    const categoryId = isBlank(input.categoryId) ? null : String(input.categoryId);
    if (categoryId) {
        const exists = mongoose.isValidObjectId(categoryId) ? Boolean(await Category.findById(categoryId)) : false;
        if (!exists) reject("code", "That category no longer exists.");
    }

    if (Object.keys(errors).length > 0) {
        throw validationError(Object.entries(errors).map(([field, message]) => ({ field, message })));
    }

    const productIds = Array.isArray(input.productIds)
        ? input.productIds.filter((id) => !isBlank(id)).map(String)
        : isBlank(input.productIds)
          ? []
          : [String(input.productIds)];

    return {
        code,
        title,
        type,
        discountValue,
        minimumOrder,
        maximumDiscount: isBlank(input.maximumDiscount) ? null : Number(input.maximumDiscount),
        startAt,
        expiry,
        usageLimit,
        perUserLimit,
        categoryId,
        productIds,
        active: isBlank(input.active) ? true : Boolean(input.active),
        description: typeof input.description === "string" ? input.description.trim() : ""
    };
}

// ------------------------------------------------------------------- seller ops

/** Persists an already-normalised draft as THIS seller's voucher. */
export async function createForSeller(sellerId, draft) {
    return voucherRepository.create({
        ...draft,
        scope: "seller",
        sellerId,
        usageCount: 0,
        perUserUsed: {}
    });
}

/** Persists an already-normalised draft over the seller's own voucher. */
export async function updateForSeller(sellerId, voucherId, draft) {
    await getForSeller(sellerId, voucherId);
    return voucherRepository.update(voucherId, { ...draft, updatedAt: new Date() });
}

/**
 * Archive-style delete: a used voucher keeps its history (it stops being
 * usable instead), an unused one leaves the database entirely.
 *
 * @returns {{ deleted: boolean, voucher: object|null }}
 */
export async function deleteForSeller(sellerId, voucherId) {
    const voucher = await getForSeller(sellerId, voucherId);
    if ((voucher.usageCount ?? 0) > 0) {
        const now = new Date();
        const archived = await voucherRepository.update(voucherId, { active: false, expiry: now, updatedAt: now });
        return { deleted: false, voucher: archived ?? voucher };
    }
    await voucherRepository.remove(voucherId);
    return { deleted: true, voucher: null };
}
