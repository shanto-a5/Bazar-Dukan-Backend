/**
 * Order + checkout domain service (slice "checkout + orders", milestone M12).
 *
 * Mirrors `src/services/order-service.ts` (the simulator SPEC) and the imported
 * backend's `backend/src/services/order.service.ts` on top of this port's
 * models and pricing core.
 *
 * The server is the authority for money and contents. It accepts only an
 * address, a payment method, a delivery method, an optional voucher code and
 * an idempotency key from the client — never prices, quantities or seller ids —
 * then re-reads the cart, re-validates every line against live catalog state,
 * re-prices with the shared grouping/voucher/delivery rules, claims its
 * idempotency key, and writes order → seller splits → payment → stock → ledger
 * → voucher redemption → notifications in that order, clearing the purchased
 * cart lines last. Any write failure after the first side effect compensates
 * the whole unit (LIFO), because this deployment has no transactions.
 *
 * Idempotency: a repeat of the same checkout inside `CHECKOUT_RETRY_WINDOW_MS`
 * replays the stored order with HTTP 200 (creation is 201); the same key with
 * a different payload is a 409; an abandoned `in_flight` claim is released so
 * a genuine retry is not locked out.
 */
import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { Order } from "../models/order.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { PaymentTransaction } from "../models/payment-transaction.model.js";
import { Product } from "../models/product.model.js";
import { InventoryAdjustment } from "../models/inventory-adjustment.model.js";
import { CheckoutAttempt } from "../models/checkout-attempt.model.js";
import { Voucher } from "../models/voucher.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { cartRepository } from "../repositories/cart.repository.js";
import { resolveCartGroups, cartTotals } from "./cart-pricing.service.js";
import { resolveForCheckout, markUsed } from "./voucher.service.js";
import { getCartView } from "./cart.service.js";
import { create as createNotification } from "./notification.service.js";
import { deriveOrderStatus, allPartsDelivered, SELLER_FULFILLMENT_FLOW } from "../core/order-status.js";
import { roundMoney } from "../core/money.js";
import { productStock } from "../core/catalog-rules.js";
import {
    normaliseCheckoutBody,
    normalisePreviewBody,
    resolveCancelReason,
    requireObjectId
} from "../validators/order.validator.js";

const ADVANCE_FLOW = [...SELLER_FULFILLMENT_FLOW];

const CANCEL_ALLOWED_FROM = new Set(["placed", "new", "confirmed", "processing"]);

/** A repeat submission inside this window replays the stored order. */
const CHECKOUT_RETRY_WINDOW_MS = 45_000;

const ONLINE_PAYMENTS = new Set(["bkash", "nagad", "card"]);

const error = (status, message, code, fields = []) => new ApiError(status, message, fields, "", code);
const badRequest = (message) => error(422, message, "validation_failed");
const conflict = (message) => error(409, message, "conflict");
const notFound = (message) => error(404, message, "not_found");

// ৳ with the locale the simulator's formatMoney uses, so notification bodies
// match the customer-facing text verbatim.
const formatMoney = (amount) => `\u09F3${Math.round(amount).toLocaleString("en-BD")}`;

const toPlain = (value) => {
    if (value == null) return null;
    if (typeof value.toObject === "function") return value.toObject();
    return value;
};

const asIso = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const randomToken = (bytes) => randomBytes(bytes).toString("hex");

// ------------------------------------------------------------------ DTOs

const toAddressDto = (address) => {
    const raw = toPlain(address) ?? {};
    return {
        label: raw.label ?? "",
        recipientName: raw.recipientName ?? "",
        phone: raw.phone ?? "",
        division: raw.division ?? "",
        district: raw.district ?? "",
        area: raw.area ?? "",
        addressLine: raw.addressLine ?? "",
        postalCode: raw.postalCode ?? "",
        instructions: raw.instructions ?? "",
        isDefault: Boolean(raw.isDefault)
    };
};

const toOrderItemDto = (item) => {
    const raw = toPlain(item) ?? {};
    const attributes = raw.variantAttributes ?? null;
    return {
        id: String(raw.id ?? ""),
        productId: String(raw.productId ?? ""),
        productName: raw.productName ?? "",
        brand: raw.brand ?? "",
        image: raw.image ?? "",
        variantId: raw.variantId ? String(raw.variantId) : null,
        variantAttributes: attributes && typeof attributes.toJSON === "function"
            ? attributes.toJSON()
            : attributes && typeof attributes.toObject === "function"
              ? attributes.toObject()
              : attributes,
        unitPrice: roundMoney(raw.unitPrice ?? 0),
        discount: roundMoney(raw.discount ?? 0),
        quantity: raw.quantity ?? 0,
        subtotal: roundMoney(raw.subtotal ?? 0),
        status: raw.status ?? "pending",
        reviewId: raw.reviewId ?? null,
        hasReview: Boolean(raw.hasReview),
        returnRequestId: raw.returnRequestId ?? null
    };
};

const toPaymentDto = (payment) => {
    const raw = toPlain(payment);
    if (!raw) return null;
    return {
        id: String(raw._id ?? raw.id ?? ""),
        orderId: String(raw.orderId ?? ""),
        method: raw.method ?? "",
        amount: roundMoney(raw.amount ?? 0),
        status: raw.status ?? "",
        reference: raw.reference ?? "",
        paidAt: asIso(raw.paidAt),
        refundedAt: asIso(raw.refundedAt),
        refundedAmount: roundMoney(raw.refundedAmount ?? 0),
        createdAt: asIso(raw.createdAt)
    };
};

const nextStatusOf = (status) => {
    const index = ADVANCE_FLOW.indexOf(status);
    return index >= 0 && index < ADVANCE_FLOW.length - 1 ? ADVANCE_FLOW[index + 1] : null;
};

const toSellerOrderDto = (sellerOrder) => {
    const raw = toPlain(sellerOrder) ?? {};
    return {
        id: String(raw._id ?? raw.id ?? ""),
        orderId: String(raw.orderId ?? ""),
        sellerId: String(raw.sellerId ?? ""),
        storeId: String(raw.storeId ?? ""),
        storeName: raw.storeName ?? "",
        storeLogo: raw.storeLogo ?? "",
        status: raw.status ?? "new",
        items: Array.isArray(raw.items) ? raw.items.map(toOrderItemDto) : [],
        subtotal: roundMoney(raw.subtotal ?? 0),
        shippingFee: roundMoney(raw.shippingFee ?? 0),
        vouchersDiscount: roundMoney(raw.vouchersDiscount ?? 0),
        total: roundMoney(raw.total ?? 0),
        shippingAddress: toAddressDto(raw.shippingAddress),
        carrier: raw.carrier ?? "",
        trackingNumber: raw.trackingNumber ?? "",
        timeline: Array.isArray(raw.timeline)
            ? raw.timeline.map((entry) => ({ status: entry.status, at: asIso(entry.at) }))
            : [],
        fulfilledAt: asIso(raw.fulfilledAt),
        createdAt: asIso(raw.createdAt),
        updatedAt: asIso(raw.updatedAt)
    };
};

/** The parent-order summary a seller order view rides on. */
const toOrderSummaryDto = (order) => {
    const raw = toPlain(order);
    if (!raw) return null;
    return {
        id: String(raw._id ?? raw.id ?? ""),
        orderCode: raw.orderCode ?? "",
        orderNumber: raw.orderCode ?? "",
        status: raw.status ?? "",
        paymentMethod: raw.paymentMethod ?? "",
        paymentStatus: raw.paymentStatus ?? "",
        total: roundMoney(raw.total ?? 0),
        placedAt: asIso(raw.placedAt),
        shippingAddress: toAddressDto(raw.shippingAddress)
    };
};

// ------------------------------------------------------------------ helpers

const snapshotItem = (line) => ({
    id: `oit-${randomToken(6)}`,
    productId: String(line.productId),
    productName: line.productName,
    brand: line.brand,
    image: line.image,
    variantId: line.variantId ? String(line.variantId) : null,
    variantAttributes: line.variantAttributes ? toPlain(line.variantAttributes) : null,
    unitPrice: roundMoney(line.unitPrice ?? 0),
    discount: 0,
    quantity: line.quantity,
    subtotal: roundMoney(line.subtotal ?? 0),
    status: "pending",
    reviewId: null,
    hasReview: false,
    returnRequestId: null,
    returnedQuantity: 0,
    remainingQuantity: null
});

const newOrderCode = (at) => {
    const digits = String(at.toISOString()).replace(/\D/g, "").slice(4, 14);
    const suffix = Math.floor(Math.random() * 90 + 10);
    return `ORD-${digits}${suffix}`;
};

const paymentReference = (method, orderCode) => `${method.toUpperCase()}-${orderCode}`;

/**
 * A stable hash of everything that defines "the same order": the payload
 * fields the server acts on plus the selected cart lines (for the automatic
 * fingerprint; an explicit key is scoped separately by `key:`).
 */
const payloadFingerprint = (userId, input, items) => {
    const address = Object.keys(input.address)
        .filter((key) => key !== "isDefault")
        .sort()
        .map((key) => [key, input.address[key] ?? null]);
    const lines = (items ?? [])
        .filter((item) => item.selected)
        .map((item) => `${String(item.productId)}:${item.variantId ?? ""}:${item.quantity}`)
        .sort();
    const canonical = JSON.stringify({
        userId: String(userId),
        paymentMethod: input.paymentMethod,
        deliveryMethod: input.deliveryMethod,
        voucherCode: input.voucherCode || null,
        address,
        lines
    });
    return createHash("sha256").update(canonical).digest("hex");
};

const storedKey = (input, fingerprint) => (input.idempotencyKey ? `k:${input.idempotencyKey}` : `f:${fingerprint}`);

const insufficientStockMessage = (line, stock) => {
    if (line.variantId) {
        const sku = line.variant?.sku ?? "";
        return `Only ${stock} left of "${line.productName}" (${sku}). Reduce the quantity to continue.`;
    }
    return `Only ${stock} left of "${line.productName}". Reduce the quantity to continue.`;
};

/** Atomic stock decrement; returns the updated product or null when it lost the race. */
const decrementLine = async (line) => {
    const quantity = line.quantity;
    if (line.variantId) {
        return Product.findOneAndUpdate(
            {
                _id: line.productId,
                variants: { $elemMatch: { _id: line.variantId, stock: { $gte: quantity } } }
            },
            { $inc: { stock: -quantity, "variants.$.stock": -quantity, soldCount: quantity } },
            { new: true }
        );
    }
    return Product.findOneAndUpdate(
        { _id: line.productId, stock: { $gte: quantity } },
        { $inc: { stock: -quantity, soldCount: quantity } },
        { new: true }
    );
};

/** Restock helper mirrored from the simulator's `restockItem` (soldCount is not decremented). */
const restockProduct = async (productId, variantId, quantity) => {
    if (variantId) {
        return Product.findOneAndUpdate(
            { _id: productId, variants: { $elemMatch: { _id: variantId } } },
            { $inc: { stock: quantity, "variants.$.stock": quantity } },
            { new: true }
        );
    }
    return Product.findOneAndUpdate({ _id: productId }, { $inc: { stock: quantity } }, { new: true });
};

/** A product restocked above zero that was flagged out_of_stock returns to active. */
const reactivateIfStocked = async (productId) => {
    const product = await Product.findById(productId);
    if (product && product.status === "out_of_stock" && productStock(product) > 0) {
        product.status = "active";
        await product.save();
    }
};

const compensateVoucher = async (voucherId, userId) => {
    const voucher = await Voucher.findById(voucherId);
    if (!voucher) return;
    const inc = { usageCount: -1 };
    if (userId) inc[`perUserUsed.${userId}`] = -1;
    await Voucher.updateOne({ _id: voucherId }, { $inc: inc });
};

/**
 * Undo a partially-applied checkout, newest first. Never throws: it runs on the
 * failure path and cannot fail the original error.
 */
const compensate = async ({ orderId, sellerOrderIds, paymentId, voucherId, voucherRedeemed, userId, decremented }) => {
    const safe = async (step) => {
        try {
            await step();
        } catch (error) {
            console.error("[orders] compensation step failed:", error instanceof Error ? error.message : error);
        }
    };

    if (paymentId) await safe(() => PaymentTransaction.deleteOne({ _id: paymentId }));
    for (const id of [...sellerOrderIds].reverse()) await safe(() => SellerOrder.deleteOne({ _id: id }));
    await safe(() => Order.deleteOne({ _id: orderId }));
    await safe(() => InventoryAdjustment.deleteMany({ referenceId: String(orderId) }));
    if (voucher && voucherRedeemed) await safe(() => compensateVoucher(voucher, userId));
    for (const entry of decremented) {
        await safe(() => restockProduct(entry.productId, entry.variantId, entry.quantity));
    }
};

/**
 * The full receipt a placed (or replayed) order returns: the customer order,
 * its seller splits flipped into DTOs, the single payment row and the priced
 * cart as it was AT PLACEMENT (the purchased lines are gone by now; the
 * replayed/raced paths fall back to a live re-price of what still remains).
 */
const buildReceipt = async (userId, order, { created, cart = null }) => {
    const sellerOrders = await SellerOrder.find({ orderId: order._id }).sort({ createdAt: 1 });
    const [payment] = await PaymentTransaction.find({ orderId: order._id });
    return {
        order: toOrderDto(order, { sellerOrderCount: sellerOrders.length }),
        sellerOrders: sellerOrders.map(toSellerOrderDto),
        payment: toPaymentDto(payment),
        cart: cart ?? (await getCartView(userId, {})),
        created: Boolean(created)
    };
};

/**
 * One submission of the same fingerprint:
 *   - a completed result inside the window → replay it (HTTP 200),
 *   - an `in_flight` claim that already has a committed order behind it →
 *     finish the claim and replay,
 *   - an `in_flight` claim that is still young and orderless → 409,
 *   - anything stale/foreign → released (returns `null` so the caller may use
 *     the key for a genuinely new attempt).
 *
 * @returns {Promise<object|null>} the receipt to answer with, or null when the
 *          caller should proceed with a fresh checkout.
 */
async function settleExisting(userId, record, fingerprint) {
    if (record.requestFingerprint !== fingerprint) {
        throw conflict("That idempotency key was already used with different order details.");
    }
    const recent = Date.now() - new Date(record.createdAt).getTime() < CHECKOUT_RETRY_WINDOW_MS;

    if (record.state === "in_flight" && record.orderId) {
        const committed = await Order.findOne({ _id: record.orderId, customerId: userId });
        if (committed) {
            await CheckoutAttempt.updateOne({ _id: record._id }, { state: "completed", responseStatus: 200 });
            return buildReceipt(userId, committed, { created: false });
        }
    }
    if (record.state === "in_flight" && recent) {
        throw conflict("That submission is already being processed. Try again in a moment.");
    }
    if (record.state === "completed" && record.orderId && recent) {
        const committed = await Order.findOne({ _id: record.orderId, customerId: userId });
        if (committed) return buildReceipt(userId, committed, { created: false });
    }

    // Stale, spent beyond the window, or orderless: release the key so a real
    // retry gets a clean slate instead of a permanent block.
    await CheckoutAttempt.deleteOne({ _id: record._id }).catch(() => undefined);
    return null;
}

const claim = async (key, fingerprint, userId, depth = 0) => {
    // FIXES 10 — the retry loop is bounded so a pathological fight for the same
    // key cannot spin forever; after three sweeps someone really does hold it.
    if (depth > 2) throw conflict("Checkout is already in progress. Please retry.");
    try {
        return await CheckoutAttempt.create({
            userId,
            fingerprint: key,
            requestFingerprint: fingerprint,
            state: "in_flight"
        });
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const winner = await CheckoutAttempt.findOne({ userId, fingerprint: key });
        if (!winner) return claim(key, fingerprint, userId, depth + 1);
        const handled = await settleExisting(userId, winner, fingerprint);
        if (handled) return { raced: handled };
        return claim(key, fingerprint, userId, depth + 1);
    }
};

// ------------------------------------------------------------------ reads

export async function previewCheckout(userId, rawBody) {
    const input = normalisePreviewBody(rawBody);

    const cart = await cartRepository.findByUserId(userId);
    const items = cart?.items ?? [];
    if (!items.some((item) => item.selected)) throw badRequest("Your cart is empty.");

    const groups = await resolveCartGroups(items);
    const base = cartTotals(groups, {});
    let voucher = null;
    if (input.voucherCode) {
        const resolved = await resolveForCheckout({
            userId,
            code: input.voucherCode,
            groups,
            subtotal: base.subtotal,
            shippingTotal: base.shippingTotal
        });
        voucher = resolved.voucher;
    }
    const totals = cartTotals(groups, { voucher, deliveryMethod: input.deliveryMethod });

    return {
        groups: groups.map(previewGroup),
        totals: previewTotals(totals),
        quote: totals.quote,
        voucher
    };
}

export async function listOrders(userId) {
    const orders = await Order.find({ customerId: userId }).sort({ placedAt: -1, _id: -1 });
    const counts = new Map();
    if (orders.length > 0) {
        const rows = await SellerOrder.find({ orderId: { $in: orders.map((order) => order._id) } }).select({ orderId: 1 });
        for (const row of rows) {
            const key = String(row.orderId);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return orders.map((order) => toOrderDto(order, { sellerOrderCount: counts.get(String(order._id)) ?? 0 }));
}

export async function getOrderForCustomer(userId, orderId) {
    requireObjectId(orderId, "Order not found.");
    const order = await Order.findById(orderId);
    if (!order || String(order.customerId) !== String(userId)) throw notFound("Order not found.");

    const sellerOrders = await SellerOrder.find({ orderId: order._id }).sort({ createdAt: 1 });
    const payments = await PaymentTransaction.find({ orderId: order._id });
    return {
        order: toOrderDto(order, { sellerOrderCount: sellerOrders.length, sellerOrders }),
        sellerOrders: sellerOrders.map(toSellerOrderDto),
        payment: payments.map(toPaymentDto)
    };
}

export async function listSellerOrders(sellerId) {
    const sellerOrders = await SellerOrder.find({ sellerId }).sort({ createdAt: -1, _id: -1 });
    const orderIds = [...new Set(sellerOrders.map((sellerOrder) => sellerOrder.orderId))];
    const orders = await Order.find({ _id: { $in: orderIds } });
    const ordersById = new Map(orders.map((order) => [String(order._id), order]));
    return sellerOrders.map((sellerOrder) => toSellerOrderView(sellerOrder, ordersById.get(String(sellerOrder.orderId))));
}

export async function getSellerOrder(sellerId, sellerOrderId) {
    requireObjectId(sellerOrderId, "Order not found.");
    const sellerOrder = await SellerOrder.findById(sellerOrderId);
    if (!sellerOrder || String(sellerOrder.sellerId) !== String(sellerId)) throw notFound("Order not found.");

    const order = await Order.findById(sellerOrder.orderId);
    return toSellerOrderView(sellerOrder, order);
}

// ------------------------------------------------------------------ write

/**
 * Places an order and answers every guarantee of the slice:
 * same-submission dedupe, no oversell, no voucher reuse, no orphan rows.
 */
export async function createOrder(userId, rawBody) {
    const input = normaliseCheckoutBody(rawBody);

    const cart = await cartRepository.findByUserId(userId);
    const items = cart?.items ?? [];
    const selected = items.filter((item) => item.selected);
    const fullFingerprint = payloadFingerprint(userId, input, items);
    // An explicit idempotency key is scoped by the key alone, so the fingerprint
    // compared on a retry covers only the payload fields the server acts on -
    // never the cart lines. The cart legitimately changes once the first
    // submission clears the purchased lines, and a same-key retry after an
    // ambiguous failure must still replay the committed order. The automatic
    // fingerprint (no key) keeps folding in the cart lines to dedupe identical
    // carts.
    const fingerprint = input.idempotencyKey ? payloadFingerprint(userId, input, []) : fullFingerprint;
    const key = storedKey(input, fullFingerprint);

    const existing = await CheckoutAttempt.findOne({ userId, fingerprint: key }).catch(() => null);
    if (existing) {
        const handled = await settleExisting(userId, existing, fingerprint);
        if (handled) return handled;
    }

    if (selected.length === 0) throw badRequest("Your cart is empty.");

    // 1. Re-validate every selected line against live catalog state.
    const groups = await resolveCartGroups(items);
    const linesByItemId = new Map();
    for (const group of groups) {
        for (const line of group.items) linesByItemId.set(String(line.itemId), line);
    }
    const selectedLines = [];
    for (const item of selected) {
        const line = linesByItemId.get(String(item._id));
        if (!line) throw badRequest("A product in your cart is no longer available.");
        if (!line.available) {
            throw badRequest(line.unavailableReason ?? `"${line.productName}" cannot be ordered right now. Remove it from your cart to continue.`);
        }
        selectedLines.push(line);
    }
    const activeGroups = groups.filter((group) => group.items.some((line) => line.selected));
    if (activeGroups.length === 0) throw badRequest("Your cart is empty.");

    // 2. Re-price with the shared rules. Client numbers are never read.
    const base = cartTotals(groups, {});
    let voucher = null;
    if (input.voucherCode) {
        const resolved = await resolveForCheckout({
            userId,
            code: input.voucherCode,
            groups,
            subtotal: base.subtotal,
            shippingTotal: base.shippingTotal
        });
        voucher = resolved.voucher;
    }
    const totals = cartTotals(groups, { voucher, deliveryMethod: input.deliveryMethod });

    if (totals.itemCount === 0) throw badRequest("Select at least one item to continue.");

    // Capture the cart exactly as checkout priced it, BEFORE placeOrder
    // empties the purchased lines, so the receipt can show them.
    const receiptCart = await getCartView(userId, {
        deliveryMethod: input.deliveryMethod,
        voucher: input.voucherCode
    });

    // 3. Claim the fingerprint before any side effect exists to dedupe.
    const claimed = await claim(key, fingerprint, userId);
    if (claimed?.raced) return claimed.raced;
    const attempt = claimed;

    const placed = await placeOrder(userId, input, totals, voucher, activeGroups, selectedLines);
    await CheckoutAttempt.updateOne(
        { _id: attempt._id },
        { state: "completed", orderId: placed.order._id, responseStatus: 201 }
    ).catch((error) => console.error("[orders] could not finalise the claim:", error?.message ?? error));

    return buildReceipt(userId, placed.order, { created: true, cart: receiptCart });
}

const placeOrder = async (userId, input, totals, voucher, activeGroups, selectedLines) => {
    const now = new Date();
    const paymentStatus = ONLINE_PAYMENTS.has(input.paymentMethod) ? "paid" : "pending";

    const orderDoc = {
        customerId: userId,
        orderCode: newOrderCode(now),
        status: "placed",
        sellerOrderIds: [],
        subtotal: totals.subtotal,
        shippingTotal: totals.shippingTotal,
        vouchersDiscount: totals.voucherDiscount,
        total: totals.grandTotal,
        paymentMethod: input.paymentMethod,
        paymentStatus,
        deliveryMethod: input.deliveryMethod,
        shippingAddress: { ...input.address, isDefault: Boolean(input.address.isDefault) },
        voucherCodes: voucher && voucher.code ? [String(voucher.code)] : [],
        placedAt: now
    };

    let order = new Order(orderDoc);
    for (let attempt = 0; ; attempt += 1) {
        try {
            await order.save();
            break;
        } catch (error) {
            const collidesOnCode = error?.code === 11000 && String(error.keyPattern?.orderCode ?? "") !== "";
            if (!collidesOnCode || attempt > 4) throw error;
            order = new Order({ ...orderDoc, orderCode: newOrderCode(new Date()) });
        }
    }

    const sellerOrderIds = [];
    const decremented = [];
    let paymentId = null;
    let voucherRedeemed = false;

    try {
        const sellersCount = activeGroups.length;
        const allocatesShipping = voucher?.type === "free_shipping";
        const allocateTotal = allocatesShipping ? totals.shippingTotal : totals.subtotal;
        let discountUnallocated = totals.voucherDiscount;

        const createdSellerOrders = [];
        for (const [index, group] of activeGroups.entries()) {
            const isLast = index === sellersCount - 1;
            const voucherShare = isLast
                ? roundMoney(discountUnallocated)
                : roundMoney(
                      totals.voucherDiscount *
                          ((allocatesShipping ? group.shippingFee : group.subtotal) / (allocateTotal || 1))
                  );
            discountUnallocated = roundMoney(discountUnallocated - voucherShare);

            const sellerLines = group.items.filter((line) => line.selected);
            const sellerOrder = await SellerOrder.create({
                orderId: order._id,
                sellerId: new mongoose.Types.ObjectId(group.sellerId),
                storeId: group.store?._id ?? null,
                storeName: group.store?.name ?? "",
                storeLogo: group.store?.logo ?? "",
                status: "new",
                items: sellerLines.map(snapshotItem),
                subtotal: group.subtotal,
                shippingFee: group.shippingFee,
                vouchersDiscount: voucherShare,
                total: roundMoney(group.subtotal + group.shippingFee - voucherShare),
                shippingAddress: order.shippingAddress,
                timeline: [{ status: "new", at: now }],
                fulfilledAt: null
            });
            createdSellerOrders.push(sellerOrder);
            sellerOrderIds.push(sellerOrder._id);
        }

        order.sellerOrderIds = sellerOrderIds.map(String);
        order.status = deriveOrderStatus(createdSellerOrders);
        await order.save();

        const payment = await PaymentTransaction.create({
            orderId: order._id,
            userId,
            method: input.paymentMethod,
            amount: totals.grandTotal,
            status: paymentStatus,
            reference: paymentReference(input.paymentMethod, order.orderCode),
            paidAt: paymentStatus === "paid" ? now : null
        });
        paymentId = payment._id;

        // 4. Decrement stock atomically. Any failure restores the earlier lines.
        for (const line of selectedLines) {
            const updated = await decrementLine(line);
            if (!updated) {
                const current = await Product.findById(line.productId);
                const stock = line.variantId
                    ? current
                        ? (current.variants.find((entry) => String(entry._id) === String(line.variantId))?.stock ?? 0)
                        : 0
                    : current?.stock ?? 0;
                throw badRequest(insufficientStockMessage(line, stock));
            }
            decremented.push({ productId: line.productId, variantId: line.variantId ?? null, quantity: line.quantity });
        }

        // 5. Ledger entries for every movement.
        for (const line of selectedLines) {
            const group = activeGroups.find((entry) => entry.items.some((candidate) => candidate.itemId === line.itemId));
            await InventoryAdjustment.create({
                productId: new mongoose.Types.ObjectId(line.productId),
                variantId: line.variantId ? String(line.variantId) : null,
                quantity: -line.quantity,
                reason: "sale",
                referenceId: String(order._id),
                sellerId: group ? new mongoose.Types.ObjectId(group.sellerId) : null
            });
        }

        // 6. Record the redemption.
        if (voucher?.id) {
            await markUsed(voucher.id, userId);
            voucherRedeemed = true;
        }

        // 7. Notifications (no compensation on failure: the side effects above
        //    would be rolled back, leaving at most brand-new marketing rows).
        for (const sellerOrder of createdSellerOrders) {
            const seller = await SellerProfile.findById(sellerOrder.sellerId);
            if (seller) {
                await createNotification({
                    userId: seller.userId,
                    type: "seller_new_order",
                    title: "New order received",
                    body: `Order ${order.orderCode} needs your confirmation.`,
                    data: { orderId: String(order._id), sellerOrderId: String(sellerOrder._id) }
                });
            }
        }
        await createNotification({
            userId,
            type: "order_placed",
            title: "Order placed",
            body: `Order ${order.orderCode} is on its way.`,
            data: { orderId: String(order._id) }
        });
        if (paymentStatus === "paid") {
            await createNotification({
                userId,
                type: "system",
                title: "Payment Received",
                body: `Payment of ${formatMoney(totals.grandTotal)} for order ${order.orderCode} was received.`,
                data: { orderId: String(order._id) }
            });
        }

        // 8. Clear the purchased lines LAST, inside the compensation watch.
        const storedCart = await cartRepository.findByUserId(userId);
        if (storedCart) {
            storedCart.items = storedCart.items.filter((item) => !item.selected);
            await cartRepository.save(storedCart);
        }

        const reloaded = await Order.findById(order._id);
        return { order: reloaded ?? order };
    } catch (error) {
        await compensate({
            orderId: order._id,
            sellerOrderIds,
            paymentId,
            voucherId: voucher?.id ?? null,
            voucherRedeemed,
            userId,
            decremented
        });
        throw error;
    }
};

export async function cancelOrder(userId, orderId, rawReason) {
    const reason = resolveCancelReason(rawReason);
    requireObjectId(orderId, "Order not found.");

    const order = await Order.findById(orderId);
    if (!order || String(order.customerId) !== String(userId)) throw notFound("Order not found.");

    const sellerOrders = await SellerOrder.find({ orderId: order._id }).sort({ createdAt: 1 });
    const cancellable =
        sellerOrders.length > 0 &&
        CANCEL_ALLOWED_FROM.has(order.status) &&
        sellerOrders.every((sellerOrder) => CANCEL_ALLOWED_FROM.has(sellerOrder.status));
    if (!cancellable) throw badRequest("This order can no longer be cancelled.");

    const now = new Date();
    for (const sellerOrder of sellerOrders) {
        for (const item of sellerOrder.items) {
            const product = await Product.findById(item.productId);
            await InventoryAdjustment.create({
                productId: new mongoose.Types.ObjectId(item.productId),
                variantId: item.variantId ? String(item.variantId) : null,
                quantity: item.quantity,
                reason: "cancellation",
                referenceId: String(order._id),
                sellerId: product ? product.sellerId : null
            });
            await restockProduct(item.productId, item.variantId ?? null, item.quantity);
            if (product) await reactivateIfStocked(product._id);
        }
        sellerOrder.status = "cancelled";
        sellerOrder.timeline = [...(sellerOrder.timeline ?? []), { status: "cancelled", at: now }];
        for (const item of sellerOrder.items) item.status = "cancelled";
        await sellerOrder.save();

        const seller = await SellerProfile.findById(sellerOrder.sellerId);
        if (seller) {
            await createNotification({
                userId: seller.userId,
                type: "seller_order_cancelled",
                title: "Order cancelled",
                body: `Order ${order.orderCode} was cancelled by the customer.`,
                data: { orderId: String(order._id), sellerOrderId: String(sellerOrder._id) }
            });
        }
    }

    if (order.paymentStatus === "paid") {
        const payment = await PaymentTransaction.findOne({ orderId: order._id });
        if (payment && payment.status !== "refunded") {
            payment.status = "refunded";
            payment.refundedAt = now;
            payment.refundedAmount = roundMoney(payment.amount ?? 0);
            await payment.save();
        }
        order.paymentStatus = "refunded";
    }
    order.status = "cancelled";
    order.cancelledAt = now;
    await order.save();

    await createNotification({
        userId,
        type: "order_cancelled",
        title: "Order cancelled",
        body: `Order ${order.orderCode} was cancelled.`,
        data: { orderId: String(order._id), reason: reason || null }
    });

    return toOrderDto(order, { sellerOrderCount: sellerOrders.length });
}

export async function advanceSellerOrder(sellerId, sellerOrderId) {
    requireObjectId(sellerOrderId, "Seller order not found.");

    const sellerOrder = await SellerOrder.findById(sellerOrderId);
    if (!sellerOrder || String(sellerOrder.sellerId) !== String(sellerId)) throw notFound("Seller order not found.");

    const index = ADVANCE_FLOW.indexOf(sellerOrder.status);
    if (index === -1) throw badRequest(`Cannot advance from "${sellerOrder.status}".`);
    if (index >= ADVANCE_FLOW.length - 1) throw badRequest("Nothing to advance to.");

    const order = await Order.findById(sellerOrder.orderId);
    if (!order) throw notFound("Order not found.");

    const now = new Date();
    const next = ADVANCE_FLOW[index + 1];
    sellerOrder.status = next;
    sellerOrder.timeline = [...(sellerOrder.timeline ?? []), { status: next, at: now }];
    if (next === "shipped") {
        sellerOrder.carrier = order.deliveryMethod === "express" ? "Vanta Express" : "Vanta Standard";
        sellerOrder.trackingNumber = `VT${randomToken(6).toUpperCase()}`;
    }
    if (next === "delivered") {
        sellerOrder.fulfilledAt = now;
        for (const item of sellerOrder.items) item.status = "delivered";
    }
    await sellerOrder.save();

    const siblings = await SellerOrder.find({ orderId: order._id });
    order.status = deriveOrderStatus(siblings);
    if (allPartsDelivered(siblings)) {
        order.deliveredAt = now;
        if (order.paymentMethod === "cod" && order.paymentStatus !== "paid") {
            const payment = await PaymentTransaction.findOne({ orderId: order._id });
            if (payment && payment.status === "pending") {
                payment.status = "paid";
                payment.paidAt = now;
                await payment.save();
            }
            order.paymentStatus = "paid";
        }
    } else if (order.status === "placed" && order.deliveredAt) {
        order.deliveredAt = null;
    }
    await order.save();

    if (next === "confirmed") {
        await createNotification({
            userId: order.customerId,
            type: "order_confirmed",
            title: "Order confirmed",
            body: `Seller confirmed part of order ${order.orderCode}.`,
            data: { orderId: String(order._id), sellerOrderId: String(sellerOrder._id) }
        });
    }
    if (next === "shipped") {
        await createNotification({
            userId: order.customerId,
            type: "order_shipped",
            title: "Order shipped",
            body: `An item from order ${order.orderCode} is on its way.`,
            data: { orderId: String(order._id), sellerOrderId: String(sellerOrder._id) }
        });
    }
    if (next === "delivered" && allPartsDelivered(siblings)) {
        await createNotification({
            userId: order.customerId,
            type: "order_delivered",
            title: "Order delivered",
            body: `Order ${order.orderCode} has been delivered. Rate your products!`,
            data: { orderId: String(order._id), sellerOrderId: String(sellerOrder._id) }
        });
    }

    return toSellerOrderView(sellerOrder, order);
}

// ------------------------------------------------------------------ views

/**
 * The preview projection of a resolved cart group: the same shape the cart
 * service's (module-private) `toGroupDto` returns, mirrored here so the
 * checkout pre-flight does not leak raw product/variant documents.
 */
const previewGroup = (group) => ({
    sellerId: String(group.sellerId),
    store: {
        id: String(group.store?._id ?? group.store?.id ?? ""),
        name: group.store?.name ?? "",
        logo: group.store?.logo ?? "",
        shippingFee: roundMoney(group.store?.shippingFee ?? 0),
        freeShippingThreshold: roundMoney(group.store?.freeShippingThreshold ?? 0),
        status: group.store?.status ?? ""
    },
    items: group.items.map((line) => ({
        id: String(line.itemId),
        productId: String(line.productId),
        sellerId: String(line.sellerId),
        variantId: line.variantId ? String(line.variantId) : null,
        productName: line.productName,
        brand: line.brand,
        image: line.image,
        quantity: line.quantity,
        selected: Boolean(line.selected),
        unitPrice: roundMoney(line.unitPrice),
        subtotal: roundMoney(line.subtotal),
        available: Boolean(line.available),
        unavailableReason: line.unavailableReason,
        priceChanged: Boolean(line.priceChanged),
        variantAttributes: toPlain(line.variantAttributes)
    })),
    subtotal: roundMoney(group.subtotal),
    shippingFee: roundMoney(group.shippingFee),
    freeShipping: Boolean(group.freeShipping),
    hasSelectedLines: Boolean(group.hasSelectedLines)
});

/** The preview's totals block, reshaped without the internal quote nesting. */
const previewTotals = (totals) => ({
    subtotal: roundMoney(totals.subtotal),
    shippingTotal: roundMoney(totals.shippingTotal),
    voucherDiscount: roundMoney(totals.voucherDiscount),
    cartTotal: roundMoney(totals.cartTotal),
    deliveryFee: roundMoney(totals.deliveryFee),
    grandTotal: roundMoney(totals.grandTotal),
    itemCount: totals.itemCount,
    quote: {
        methodId: totals.quote?.methodId ?? "",
        label: totals.quote?.label ?? "",
        caption: totals.quote?.caption ?? "",
        fee: roundMoney(totals.quote?.fee ?? 0),
        daysMin: totals.quote?.daysMin ?? 0,
        daysMax: totals.quote?.daysMax ?? 0,
        window: totals.quote?.window ?? "",
        sellerCount: totals.quote?.sellerCount ?? 0,
        premiumPerSeller: roundMoney(totals.quote?.premiumPerSeller ?? 0),
        baseFee: roundMoney(totals.quote?.baseFee ?? 0)
    }
});

/**
 * Public projection of an Order. Rich enough for both the list and the detail
 * views; the detail endpoint adds `sellerOrders`/`payment` on top.
 */
export function toOrderDto(order, { sellerOrderCount = 0, sellerOrders = null } = {}) {
    const raw = toPlain(order) ?? {};
    const id = String(raw._id ?? raw.id ?? "");
    const status = raw.status ?? "placed";
    const count = sellerOrderCount ?? 0;
    const cancellable = count > 0 && CANCEL_ALLOWED_FROM.has(status);
    const money = {
        subtotal: roundMoney(raw.subtotal ?? 0),
        shippingTotal: roundMoney(raw.shippingTotal ?? 0),
        vouchersDiscount: roundMoney(raw.vouchersDiscount ?? 0),
        total: roundMoney(raw.total ?? 0)
    };

    const dto = {
        id,
        orderCode: raw.orderCode ?? "",
        orderNumber: raw.orderCode ?? "",
        customerId: String(raw.customerId ?? ""),
        status,
        sellerOrderIds: Array.isArray(raw.sellerOrderIds) ? raw.sellerOrderIds.map(String) : [],
        subtotal: money.subtotal,
        shippingTotal: money.shippingTotal,
        vouchersDiscount: money.vouchersDiscount,
        total: money.total,
        totals: {
            subtotal: money.subtotal,
            shipping: money.shippingTotal,
            voucherDiscount: money.vouchersDiscount,
            total: money.total
        },
        paymentMethod: raw.paymentMethod ?? "",
        paymentStatus: raw.paymentStatus ?? "",
        deliveryMethod: raw.deliveryMethod ?? "standard",
        shippingAddress: toAddressDto(raw.shippingAddress),
        address: toAddressDto(raw.shippingAddress),
        voucherCodes: Array.isArray(raw.voucherCodes) ? raw.voucherCodes.map(String) : [],
        placedAt: asIso(raw.placedAt),
        cancelledAt: asIso(raw.cancelledAt),
        deliveredAt: asIso(raw.deliveredAt),
        createdAt: asIso(raw.createdAt),
        updatedAt: asIso(raw.updatedAt),
        items: sellerOrders ? sellerOrders.flatMap((so) => (so.items ?? []).map(toOrderItemDto)) : [],
        sellerCount: count,
        canCancel: cancellable
    };

    if (!cancellable) {
        dto.cancelBlockReason =
            count === 0
                ? "This order has no fulfillment records."
                : status === "cancelled"
                  ? "This order was already cancelled."
                  : "This order can no longer be cancelled because fulfillment has already started.";
    }
    return dto;
}

/**
 * The seller-side view: the split DTO itself (flat, exactly the `SellerOrder`
 * the client types against) plus its parent order summary and state hints.
 */
export function toSellerOrderView(sellerOrder, order) {
    const nextStatus = nextStatusOf(sellerOrder.status ?? "new");
    return {
        ...toSellerOrderDto(sellerOrder),
        order: toOrderSummaryDto(order),
        lineCount: (sellerOrder.items ?? []).length,
        itemCount: (sellerOrder.items ?? []).reduce((sum, item) => sum + (item.quantity ?? 0), 0),
        canAdvance: Boolean(nextStatus),
        nextStatus
    };
}