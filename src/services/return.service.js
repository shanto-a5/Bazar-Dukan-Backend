/**
 * Returns + refunds domain service (slice "returns + refunds", milestone M12).
 *
 * Mirrors the simulator's return section of `src/services/order-service.ts`
 * (the SPEC): `requestReturn`, `decideReturn`, `markReturned`, `restockItem`,
 * `deriveSellerStatusFromItems` and `afterSellerOrderChange`, on top of this
 * port's models and core.
 *
 * The state machine is `pending → approved|rejected → returned → refunded`
 * (`refunded` only for `preferredResolution: "refund"`), every transition
 * message is the simulator's wording verbatim, and — importantly — stock comes
 * back only when the goods physically arrive (`markReturned`), never on
 * approval, so an approved-but-undelivered return cannot be double counted.
 *
 * The batch creation endpoint plans every requested line first (eligibility,
 * range, one-open-per-line) and only then writes, so a body naming three lines
 * where the second is ineligible creates nothing and answers one 422 that
 * carries every field problem, per the Vanta envelope rules.
 */
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { Order } from "../models/order.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { ReturnRequest } from "../models/return-request.model.js";
import { PaymentTransaction } from "../models/payment-transaction.model.js";
import { Product } from "../models/product.model.js";
import { InventoryAdjustment } from "../models/inventory-adjustment.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { returnRequestRepository } from "../repositories/return-request.repository.js";
import { create as createNotification } from "./notification.service.js";
import { deriveOrderStatus, allPartsDelivered } from "../core/order-status.js";
import { roundMoney } from "../core/money.js";
import { productStock } from "../core/catalog-rules.js";
import {
    normaliseReturnBody,
    resolveStatusFilter,
    requireObjectId
} from "../validators/return.validator.js";

const error = (statusCode, message, code, fields = []) => new ApiError(statusCode, message, fields, "", code);
const notFound = (message) => error(404, message, "not_found");
const conflict = (message) => error(409, message, "conflict");

/** One 422 per failed plan: the envelope message is the first field's. */
const eligibilityError = (fields) => error(422, fields[0].message, "validation_failed", fields);

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

// ------------------------------------------------------------------ rules

/** Units of a line the customer still holds (never negative, per SPEC). */
const remainingReturnableQuantity = (item) =>
    Math.max(0, (item.quantity ?? 0) - Math.max(0, item.returnedQuantity ?? 0));

/**
 * The quantity a request covers: the explicit count when it has one,
 * otherwise whatever is still returnable (the model's `null` default).
 */
const returnQuantity = (request, item) =>
    Number.isInteger(request.quantity) && request.quantity > 0
        ? request.quantity
        : remainingReturnableQuantity(item);

/** `refundEstimateForItem` from the SPEC: whole units, never past the line. */
const refundAmountForItem = (item, quantity) => {
    const safeQuantity = Math.max(0, Math.min(Math.floor(quantity ?? 0), item.quantity ?? 0));
    return roundMoney((item.unitPrice ?? 0) * safeQuantity);
};

/**
 * Highest return state wins, so one fully returned line reads the whole split
 * as `returned` while a partly returned line reads `partially_returned`.
 * Verbatim from the SPEC's `deriveSellerStatusFromItems`.
 */
const deriveSellerStatusFromItems = (sellerOrder) => {
    const statuses = (sellerOrder.items ?? []).map((item) => item.status);
    if (statuses.includes("refunded")) return "refunded";
    if (statuses.includes("returned")) return "returned";
    if (statuses.includes("partially_returned")) return "partially_returned";
    if (statuses.includes("return_approved")) return "return_approved";
    if (statuses.includes("return_requested")) return "return_requested";
    if (statuses.includes("cancelled")) return "cancelled";
    if (statuses.includes("pending")) return "new";
    return "delivered";
};

/** Atomic stock increment, mirroring the order slice's `restockProduct`. */
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

/**
 * Physical arrival of the returned units: stock in, one ledger row, product
 * revived. Skipped entirely when the product row is gone — there is nothing to
 * credit and no warehouse to record it against (the SPEC's `restockItem`).
 */
const restockReturnedUnits = async (sellerOrder, item, quantity) => {
    if (!item.productId || !mongoose.isValidObjectId(item.productId)) return;
    const product = await Product.findById(item.productId);
    if (!product) return;

    const count = Math.max(1, Math.min(quantity, item.quantity ?? 1));
    await restockProduct(item.productId, item.variantId ?? null, count);
    await InventoryAdjustment.create({
        productId: new mongoose.Types.ObjectId(item.productId),
        variantId: item.variantId ?? null,
        quantity: count,
        reason: "return",
        referenceId: String(sellerOrder.orderId),
        sellerId: product.sellerId ?? null
    });
    await reactivateIfStocked(item.productId);
};

/**
 * Re-derives the parent order from its splits after any return transition —
 * the port of the SPEC's `afterSellerOrderChange` order half: status from the
 * siblings, `deliveredAt` stamped on first full arrival, COD settled then.
 * The simulator's per-change customer notices (`shipped`/`confirmed`) cannot
 * fire here (a return always writes a return status), so only the first-arrival
 * delivery notice is kept. Low-stock nudges belong to the catalog slice and
 * are not re-emitted from this one.
 */
const syncOrder = async (order) => {
    const siblings = await SellerOrder.find({ orderId: order._id });
    const now = new Date();

    order.status = deriveOrderStatus(siblings);
    const goodsArrived = allPartsDelivered(siblings);
    const firstArrival = goodsArrived && !order.deliveredAt;

    if (goodsArrived) {
        order.deliveredAt = order.deliveredAt ?? now;
        if (order.paymentMethod === "cod" && order.paymentStatus === "pending") {
            const payment = await PaymentTransaction.findOne({ orderId: order._id });
            if (payment && payment.status === "pending") {
                payment.status = "paid";
                payment.paidAt = now;
                await payment.save();
            }
            order.paymentStatus = "paid";
        }
    }
    await order.save();

    if (firstArrival) {
        await createNotification({
            userId: order.customerId,
            type: "order_delivered",
            title: "Order delivered",
            body: `Order ${order.orderCode} has been delivered. Rate your products!`,
            data: { orderId: String(order._id) }
        });
    }
};

// ------------------------------------------------------------------ DTOs

/** Public projection: `id` as a string, never `_id`/`__v`. */
const toReturnDto = (request) => {
    const raw = toPlain(request) ?? {};
    return {
        id: String(raw._id ?? raw.id ?? ""),
        orderId: String(raw.orderId ?? ""),
        sellerOrderId: String(raw.sellerOrderId ?? ""),
        orderItemId: String(raw.orderItemId ?? ""),
        userId: String(raw.userId ?? ""),
        sellerId: String(raw.sellerId ?? ""),
        productName: raw.productName ?? "",
        quantity: raw.quantity ?? null,
        reason: raw.reason ?? "",
        description: raw.description ?? "",
        images: Array.isArray(raw.images) ? raw.images.map(String) : [],
        preferredResolution: raw.preferredResolution ?? "refund",
        status: raw.status ?? "pending",
        timeline: Array.isArray(raw.timeline)
            ? raw.timeline.map((entry) => ({ status: entry.status, at: asIso(entry.at) }))
            : [],
        createdAt: asIso(raw.createdAt),
        updatedAt: asIso(raw.updatedAt)
    };
};

// ------------------------------------------------------------------ reads

export async function listReturnsForCustomer(userId) {
    const requests = await returnRequestRepository.listForUser(userId);
    return requests.map(toReturnDto);
}

export async function listReturnsForOrder(userId, orderId) {
    requireObjectId(orderId, "Order not found.");
    const order = await Order.findById(orderId);
    if (!order || String(order.customerId) !== String(userId)) throw notFound("Order not found.");
    const requests = await returnRequestRepository.listForOrder(order._id);
    return requests.map(toReturnDto);
}

export async function listReturnsForSeller(sellerId, rawStatus) {
    const status = resolveStatusFilter(rawStatus);
    const requests = await returnRequestRepository.listForSeller(sellerId, { status });
    return requests.map(toReturnDto);
}

export async function getReturnForSeller(sellerId, id) {
    requireObjectId(id, "Return request not found.");
    const request = await returnRequestRepository.findByIdForSeller(id, sellerId);
    if (!request) throw notFound("Return request not found.");
    return toReturnDto(request);
}

// ------------------------------------------------------------------ write

/**
 * One or more return requests against the caller's own delivered order.
 *
 * Every entry is checked against the simulator's order of rules — line exists,
 * line delivered (or partly returned), units still held, no other open request
 * on that line, quantity inside `[1..returnable]` — and the first failure of
 * EACH entry is reported in a single 422 with the SPEC's wording verbatim.
 * Nothing is written unless the whole body plans cleanly.
 */
export async function createReturnsForOrder(userId, orderId, rawBody) {
    const { items } = normaliseReturnBody(rawBody);
    requireObjectId(orderId, "Order not found.");
    const order = await Order.findById(orderId);
    if (!order || String(order.customerId) !== String(userId)) throw notFound("Order not found.");
    const sellerOrders = await SellerOrder.find({ orderId: order._id });

    const plan = [];
    const fields = [];
    const seenLines = new Set();

    for (const [index, entry] of items.entries()) {
        const lineField = `items[${index}].lineId`;
        const quantityField = `items[${index}].quantity`;
        const fail = (field, message) => fields.push({ field, message });

        const sellerOrder = sellerOrders.find((candidate) =>
            (candidate.items ?? []).some((line) => line.id === entry.lineId)
        );
        const item = sellerOrder?.items.find((candidate) => candidate.id === entry.lineId);

        if (!item) {
            fail(lineField, "Item not found.");
            continue;
        }

        // One open request per line, checked BEFORE the delivery state: a
        // second attempt against a line that already has a pending/approved
        // request must say "already exists", not "only delivered items can be
        // returned" — the line reads `return_requested` exactly while that
        // request is open, which would make the SPEC's own message (it sits
        // after the status test) unreachable.
        if (seenLines.has(entry.lineId)) {
            fail(lineField, "A return request already exists for this item.");
            continue;
        }
        const open = await returnRequestRepository.findOpenForLine(userId, entry.lineId);
        if (open) {
            fail(lineField, "A return request already exists for this item.");
            continue;
        }

        if (item.status !== "delivered" && item.status !== "partially_returned") {
            fail(lineField, "Only delivered items can be returned.");
            continue;
        }

        const returnable = remainingReturnableQuantity(item);
        if (returnable < 1) {
            fail(lineField, "Every unit of this item has already been returned.");
            continue;
        }

        const quantity = entry.quantity === null ? returnable : entry.quantity;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > returnable) {
            fail(
                quantityField,
                returnable === item.quantity
                    ? `Enter a return quantity between 1 and ${item.quantity}.`
                    : `Enter a return quantity between 1 and ${returnable}. ${item.quantity - returnable} of ${item.quantity} already returned.`
            );
            continue;
        }

        seenLines.add(entry.lineId);
        plan.push({ sellerOrder, item, entry, quantity });
    }

    if (fields.length > 0) throw eligibilityError(fields);

    // The plan is clean: write the requests, flip their lines/splits, move the
    // parent order, then notify both sides.
    const now = new Date();
    const created = [];
    for (const step of plan) {
        const request = await returnRequestRepository.create({
            orderId: step.sellerOrder.orderId,
            sellerOrderId: step.sellerOrder._id,
            orderItemId: step.entry.lineId,
            userId,
            sellerId: step.sellerOrder.sellerId,
            productName: step.item.productName,
            quantity: step.quantity,
            reason: step.entry.reason,
            description: step.entry.description,
            images: step.entry.images,
            preferredResolution: step.entry.preferredResolution,
            status: "pending",
            timeline: [{ status: "pending", at: now }]
        });
        created.push({ request, step });
    }

    const touchedSellerOrders = new Map();
    for (const { step } of created) {
        touchedSellerOrders.set(String(step.sellerOrder._id), step.sellerOrder);
    }
    for (const sellerOrder of touchedSellerOrders.values()) {
        for (const { request, step } of created) {
            if (String(step.sellerOrder._id) !== String(sellerOrder._id)) continue;
            const item = sellerOrder.items.find((candidate) => candidate.id === step.entry.lineId);
            if (item) {
                item.status = "return_requested";
                item.returnRequestId = String(request._id);
            }
        }
        sellerOrder.status = "return_requested";
        sellerOrder.timeline = [...(sellerOrder.timeline ?? []), { status: "return_requested", at: now }];
        await sellerOrder.save();
    }

    await syncOrder(order);

    for (const { request, step } of created) {
        await createNotification({
            userId,
            type: "return_update",
            title: "Return Requested",
            body: `Return requested for ${step.item.productName} (${step.quantity} of ${step.item.quantity}).`,
            data: { returnId: String(request._id), orderId: String(request.orderId) }
        });
        const seller = await SellerProfile.findById(step.sellerOrder.sellerId);
        if (seller) {
            await createNotification({
                userId: seller.userId,
                type: "seller_return_request",
                title: "Return Request",
                body: `${step.item.productName} from order ${order.orderCode} needs a decision.`,
                data: {
                    returnId: String(request._id),
                    orderId: String(request.orderId),
                    sellerOrderId: String(step.sellerOrder._id)
                }
            });
        }
    }

    return created.map(({ request }) => toReturnDto(request));
}

/**
 * The seller's decision on a PENDING request: approve freezes the line into
 * `return_approved`, reject hands it back to `delivered` and clears the open
 * request id, and either way the split and the parent order re-derive from
 * their items. A request that was already decided is a 409 — re-deciding used
 * to write a second timeline entry and walk the split out of `return_approved`.
 */
export async function decideReturnForSeller(sellerId, id, approve) {
    requireObjectId(id, "Return request not found.");
    const request = await returnRequestRepository.findByIdForSeller(id, sellerId);
    if (!request) throw notFound("Return request not found.");
    if (request.status !== "pending") throw conflict("This return request has already been decided.");

    const now = new Date();
    const status = approve ? "approved" : "rejected";
    request.status = status;
    request.timeline = [...(request.timeline ?? []), { status, at: now }];

    const sellerOrder = await SellerOrder.findById(request.sellerOrderId);
    if (sellerOrder) {
        const item = sellerOrder.items.find((candidate) => candidate.id === request.orderItemId);
        if (item) {
            // Move the item FIRST, then derive (the SPEC's ordering): deriving
            // from the pre-update split left a rejection stuck on
            // `return_requested`, which blocked advancing and COD settlement.
            item.status = approve ? "return_approved" : "delivered";
            item.returnRequestId = approve ? String(request._id) : null;
        }
        const nextStatus = approve ? "return_approved" : deriveSellerStatusFromItems(sellerOrder);
        sellerOrder.status = nextStatus;
        sellerOrder.timeline = [...(sellerOrder.timeline ?? []), { status: nextStatus, at: now }];
        await sellerOrder.save();
    }
    await request.save();

    const order = await Order.findById(request.orderId);
    if (order) await syncOrder(order);

    await createNotification({
        userId: request.userId,
        type: "return_update",
        title: approve ? "Return Approved" : "Return Rejected",
        body: approve
            ? `Your return for ${request.productName} was approved. Send the item back when you can.`
            : `Your return for ${request.productName} was rejected.`,
        data: { returnId: String(request._id), orderId: String(request.orderId) }
    });

    return toReturnDto(request);
}

/**
 * Goods arrived: the line moves to `returned`/`partially_returned`, the units
 * are restocked and ledgered, and a `refund` resolution pays the customer back
 * what this request covers — clamped to the headroom left on the payment so
 * sequential partial returns can never refund past what was charged. Only then
 * does the request reach `refunded`; a `replacement` stops at `returned`.
 */
export async function markReturnedForSeller(sellerId, id) {
    requireObjectId(id, "Return request not found.");
    const request = await returnRequestRepository.findByIdForSeller(id, sellerId);
    if (!request) throw notFound("Return request not found.");
    if (request.status !== "approved") throw conflict("Return must be approved first.");

    const now = new Date();
    request.status = "returned";
    request.timeline = [...(request.timeline ?? []), { status: "returned", at: now }];

    const sellerOrder = await SellerOrder.findById(request.sellerOrderId);
    const item = sellerOrder?.items.find((candidate) => candidate.id === request.orderItemId);
    let quantity = 0;

    if (sellerOrder && item) {
        quantity = returnQuantity(request, item);
        const returnedTotal = Math.min(item.quantity, Math.max(0, item.returnedQuantity ?? 0) + quantity);
        const remaining = Math.max(0, item.quantity - returnedTotal);
        const nextStatus = remaining === 0 ? "returned" : "partially_returned";

        item.status = nextStatus;
        item.returnRequestId = String(request._id);
        item.returnedQuantity = returnedTotal;
        item.remainingQuantity = remaining;
        sellerOrder.status = nextStatus;
        sellerOrder.timeline = [...(sellerOrder.timeline ?? []), { status: nextStatus, at: now }];
        await sellerOrder.save();

        await restockReturnedUnits(sellerOrder, item, quantity);
    }

    let settledInFull = false;
    if (request.preferredResolution === "refund") {
        request.status = "refunded";
        request.timeline = [...(request.timeline ?? []), { status: "refunded", at: now }];

        const payment = await PaymentTransaction.findOne({ orderId: request.orderId });
        if (payment && item) {
            const amount = refundAmountForItem(item, quantity);

            // Refunds are CAS-capped: `refundedAmount` may only be advanced to
            // the current value + THIS refund's remaining share, and only while
            // it has not already crossed the order total. A concurrent refund
            // that moved it forwards makes the update match nothing, so we
            // re-read and retry against the freshest tally (bounded).
            for (let attempt = 0; attempt < 3; attempt += 1) {
                const current = await PaymentTransaction.findById(payment._id);
                if (!current) break;
                const alreadyRefunded = roundMoney(current.refundedAmount ?? 0);
                const applied = roundMoney(Math.min(amount, Math.max(0, roundMoney(current.amount - alreadyRefunded))));
                const refundedTotal = roundMoney(alreadyRefunded + applied);

                const updated = await PaymentTransaction.findOneAndUpdate(
                    { _id: current._id, refundedAmount: { $lte: roundMoney(current.amount - applied) } },
                    { $set: { status: "refunded", refundedAt: now, refundedAmount: refundedTotal } },
                    { new: true }
                );
                if (updated) {
                    settledInFull = updated.refundedAmount >= updated.amount;
                    break;
                }
            }
        }
    }
    await request.save();

    const order = await Order.findById(request.orderId);
    if (order) {
        if (settledInFull) order.paymentStatus = "refunded";
        await syncOrder(order);
    }

    await createNotification({
        userId: request.userId,
        type: "return_update",
        title: "Returned",
        body: `Your return for ${request.productName} has been processed.`,
        data: { returnId: String(request._id), orderId: String(request.orderId) }
    });

    return toReturnDto(request);
}
