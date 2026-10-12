/**
 * Returns + refunds suite (slice "returns + refunds", milestone M12).
 *
 * Runs against a dedicated `vanta_return_test` database and an ephemeral port,
 * asserting what a client observes: the simulator's exact messages, the
 * `pending → approved|rejected → returned → refunded` state machine, the
 * restock-on-arrival rule (never on approval), the refund clamp against the
 * payment's headroom, the parent-order/split/item moves, and both sides'
 * notifications.
 *
 * Run JUST this file:
 *
 *     node --test src/tests/return.test.js
 *
 * The slice router is not wired into `src/app.js` yet (a coordinator does that
 * once every slice lands), so the suite stands up the same stack `app.js`
 * builds — request id, body parsers, cookie parser, the identity/cart routers,
 * the order router (checkout + the fulfilment advances the fixture needs) —
 * plus this slice's router, then the same JSON 404/error handlers.
 *
 * The suite drops `vanta_return_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import express from "express";
import cookieParser from "cookie-parser";

import { requestId } from "../middlewares/requestId.middleware.js";
import { notFoundHandler, errorHandler } from "../middlewares/error.middleware.js";
import userRouter from "../routes/user.route.js";
import cartRouter from "../routes/cart.route.js";
import orderRouter from "../routes/order.route.js";
import returnRouter from "../routes/return.route.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";
import { Order } from "../models/order.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { PaymentTransaction } from "../models/payment-transaction.model.js";
import { InventoryAdjustment } from "../models/inventory-adjustment.model.js";
import { Notification } from "../models/notification.model.js";
import { ReturnRequest } from "../models/return-request.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `return-${label}-${++sequence}-${Date.now()}@example.com`;

/** The same stack `app.js` builds, plus the slice routers under test. */
const buildApp = () => {
    const instance = express();
    instance.disable("x-powered-by");
    instance.use(requestId);
    instance.use(express.urlencoded({ limit: "16kb", extended: true }));
    instance.use(express.json({ limit: "16kb" }));
    instance.use(cookieParser());
    instance.use("/api/v1/auth", userRouter);
    instance.use("/api/v1", cartRouter);
    instance.use("/api/v1", orderRouter);
    instance.use("/api/v1", returnRouter);
    instance.use(notFoundHandler);
    instance.use(errorHandler);
    return instance;
};

const api = async (method, path, { body, token, headers = {} } = {}) => {
    const merged = { accept: "application/json", ...headers };
    if (body !== undefined) merged["content-type"] = "application/json";
    if (token) merged.authorization = `Bearer ${token}`;

    const response = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: merged,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const raw = await response.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch {
        json = null;
    }

    return { status: response.status, body: json, raw };
};

const registerUser = async (label) => {
    const email = uniqueEmail(label);
    const response = await api("POST", "/auth/register", {
        body: { name: "Ada Lovelace", email, phone: "01712345678", password: PASSWORD }
    });
    assert.equal(response.status, 201, response.raw);
    return { email, token: response.body.data.token, user: response.body.data.user };
};

const AGREEMENT = {
    marketplaceTerms: true,
    sellerPolicies: true,
    productAuthenticity: true,
    fulfillmentResponsibility: true
};

/** A registered user who is an approved seller, with a store to sell from. */
const makeSeller = async (label) => {
    const account = await registerUser(label);
    const profile = await SellerProfile.create({
        userId: account.user.id,
        fullName: "Active Seller",
        phone: "01712345678",
        email: account.email,
        nationalId: "1990123456789",
        sellerType: "individual",
        storeName: "Active Store",
        storeDescription: "An approved demo storefront.",
        pickupDivision: "Dhaka",
        pickupDistrict: "Dhaka",
        pickupArea: "Dhanmondi",
        pickupAddressLine: "House 3, Dhanmondi",
        returnDivision: "Dhaka",
        returnDistrict: "Dhaka",
        returnArea: "Dhanmondi",
        returnAddressLine: "House 3, Dhanmondi",
        bank: { bankName: "BRAC Bank", accountName: "Active Seller", accountNumber: "12345678901", branch: "Dhanmondi" },
        agreement: { ...AGREEMENT },
        status: "active"
    });
    const store = await Store.create({
        sellerId: profile._id,
        name: "Active Store",
        description: "An approved demo storefront.",
        location: "Dhaka, Dhaka"
    });
    return { ...account, profile, store };
};

const makeProduct = async (seller, overrides = {}) =>
    Product.create({
        sellerId: seller.profile._id,
        storeId: seller.store._id,
        name: "Aurora Wireless Headphones",
        brand: "Sonora",
        categoryId: new mongoose.Types.ObjectId(),
        regularPrice: 100,
        salePrice: null,
        sku: `AUR-${++sequence}`,
        stock: 12,
        lowStockThreshold: 5,
        hasVariants: false,
        variants: [],
        status: "active",
        images: ["https://cdn.vanta.example/aurora.jpg"],
        ...overrides
    });

const addToCart = async (token, productId, { quantity = 2 } = {}) => {
    const response = await api("POST", "/cart/items", {
        token,
        body: { productId: String(productId), quantity }
    });
    assert.equal(response.status, 201, response.raw);
    return response.body.data;
};

const ADDRESS = {
    label: "Home",
    recipientName: "Ada Lovelace",
    phone: "01712345678",
    division: "Dhaka",
    district: "Dhaka",
    area: "Dhanmondi",
    addressLine: "House 1, Road 2, Dhanmondi",
    postalCode: "1209",
    instructions: "Call on arrival."
};

const buy = async (token, overrides = {}) => {
    const response = await api("POST", "/orders", {
        token,
        body: { address: { ...ADDRESS }, paymentMethod: "cod", ...overrides }
    });
    return response;
};

const assertNoMongoIds = (raw, label) => {
    assert.ok(!raw.includes("\"_id\""), `${label} must not expose _id`);
    assert.ok(!raw.includes("\"__v\""), `${label} must not expose __v`);
};

/**
 * A placed order driven to `delivered` through the real fulfilment endpoint
 * (7 advances: new → … → out_for_delivery → delivered), so the snapshot line
 * carries `delivered` exactly the way production would.
 *
 * `freeShipping` drops the store's threshold under the subtotal, which makes
 * the payment equal the line total — the only way a return can refund the
 * order in full (shipping itself is never refunded).
 */
const buyAndDeliver = async (
    label,
    { quantity = 3, price = 100, paymentMethod = "bkash", freeShipping = false, advanceTo = 7 } = {}
) => {
    const seller = await makeSeller(label);
    if (freeShipping) {
        await Store.updateOne({ _id: seller.store._id }, { freeShippingThreshold: 1 });
    }
    const customer = await registerUser(`${label}-buyer`);
    const product = await makeProduct(seller, { regularPrice: price });
    await addToCart(customer.token, product._id, { quantity });

    const placed = await buy(customer.token, { paymentMethod, idempotencyKey: `${label}-${++sequence}` });
    assert.equal(placed.status, 201, placed.raw);

    const orderId = placed.body.data.order.id;
    const sellerOrderId = placed.body.data.sellerOrders[0].id;
    const lineId = placed.body.data.sellerOrders[0].items[0].id;

    for (let step = 0; step < advanceTo; step += 1) {
        const moved = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
        assert.equal(moved.status, 200, moved.raw);
    }

    return {
        seller,
        customer,
        product,
        orderId,
        sellerOrderId,
        lineId,
        orderCode: placed.body.data.order.orderCode,
        quantity,
        price
    };
};

const postReturn = (token, orderId, entry) =>
    api("POST", `/orders/${orderId}/returns`, { token, body: { items: [entry] } });

const approveReturn = (token, id) => api("POST", `/seller/returns/${id}/approve`, { token });
const rejectReturn = (token, id) => api("POST", `/seller/returns/${id}/reject`, { token });
const markArrived = (token, id) => api("POST", `/seller/returns/${id}/returned`, { token });

const statusesOf = (dto) => dto.timeline.map((entry) => entry.status);

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the return suite");

    await mongoose.connect(`${base}/vanta_return_test`);

    server = await new Promise((resolve) => {
        const instance = buildApp().listen(0, "127.0.0.1", () => resolve(instance));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.models).map((model) => model.deleteMany({})));
});

// ---------------------------------------------------------- request creation

describe("creating a return request", () => {
    it("requires the owner's session and a real order", async () => {
        const fixture = await buyAndDeliver("auth");

        const anonymous = await api("POST", `/orders/${fixture.orderId}/returns`, {
            body: { items: [{ lineId: fixture.lineId, reason: "damaged" }] }
        });
        assert.equal(anonymous.status, 401, anonymous.raw);
        assert.equal(anonymous.body.error.code, "unauthorized");

        const stranger = await registerUser("auth-stranger");
        const foreign = await postReturn(stranger.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(foreign.status, 404, foreign.raw);
        assert.equal(foreign.body.error.message, "Order not found.");

        const malformed = await postReturn(fixture.customer.token, "not-an-id", {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(malformed.status, 404, malformed.raw);
        assert.equal(malformed.body.error.message, "Order not found.");
    });

    it("reports every structural problem in one 422", async () => {
        const fixture = await buyAndDeliver("structural");

        const empty = await api("POST", `/orders/${fixture.orderId}/returns`, {
            token: fixture.customer.token,
            body: {}
        });
        assert.equal(empty.status, 422, empty.raw);
        assert.equal(empty.body.error.code, "validation_failed");
        assert.equal(empty.body.error.message, "Add at least one item to return.");
        assert.deepEqual(empty.body.error.fields, [{ field: "items", message: "Add at least one item to return." }]);

        const messy = await api("POST", `/orders/${fixture.orderId}/returns`, {
            token: fixture.customer.token,
            body: { items: [{ reason: "nope" }, { lineId: fixture.lineId, reason: "" }] }
        });
        assert.equal(messy.status, 422, messy.raw);
        assert.equal(messy.body.error.code, "validation_failed");
        assert.equal(messy.body.error.message, "Please fix the highlighted fields.");
        assert.deepEqual(
            messy.body.error.fields,
            [
                { field: "items[0].lineId", message: "Name the item you want to return." },
                { field: "items[0].reason", message: "That return reason is not supported." },
                { field: "items[1].reason", message: "Choose a reason for this return." }
            ]
        );
    });

    it("refuses a line that has not been delivered yet", async () => {
        const fixture = await buyAndDeliver("undelivered", { advanceTo: 0 });

        const response = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.message, "Only delivered items can be returned.");
        assert.deepEqual(response.body.error.fields, [
            { field: "items[0].lineId", message: "Only delivered items can be returned." }
        ]);
        assert.equal(await ReturnRequest.countDocuments({}), 0, "nothing may be written for an ineligible line");
    });

    it("refuses a line id that is not on the order", async () => {
        const fixture = await buyAndDeliver("ghost-line");

        const response = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: "oit-not-on-this-order",
            reason: "missing_item"
        });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.message, "Item not found.");
        assert.deepEqual(response.body.error.fields, [
            { field: "items[0].lineId", message: "Item not found." }
        ]);
    });

    it("creates the request and moves line, split, order and both inboxes", async () => {
        const fixture = await buyAndDeliver("create");

        const response = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged",
            quantity: 2,
            note: "Cracked the left ear cup.",
            images: ["https://cdn.vanta.example/damage.jpg"],
            preferredResolution: "refund"
        });

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.meta.message, "Return requested.");
        assertNoMongoIds(response.raw, "return creation");

        const dto = response.body.data.returns[0];
        assert.equal(dto.status, "pending");
        assert.equal(dto.quantity, 2);
        assert.equal(dto.reason, "damaged");
        assert.equal(dto.description, "Cracked the left ear cup.");
        assert.deepEqual(dto.images, ["https://cdn.vanta.example/damage.jpg"]);
        assert.equal(dto.preferredResolution, "refund");
        assert.equal(dto.orderItemId, fixture.lineId);
        assert.equal(dto.orderId, fixture.orderId);
        assert.equal(dto.sellerOrderId, fixture.sellerOrderId);
        assert.equal(dto.userId, String(fixture.customer.user.id));
        assert.equal(dto.sellerId, String(fixture.seller.profile._id));
        assert.equal(dto.productName, "Aurora Wireless Headphones");
        assert.deepEqual(statusesOf(dto), ["pending"]);
        assert.ok(dto.timeline[0].at, "the timeline entry is timestamped");

        const stored = await ReturnRequest.findOne({ orderItemId: fixture.lineId });
        assert.ok(stored, "the request is persisted");
        assert.equal(String(stored._id), dto.id);
        assert.equal(stored.status, "pending");

        const sellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        assert.equal(sellerOrder.status, "return_requested");
        assert.equal(sellerOrder.items[0].status, "return_requested");
        assert.equal(sellerOrder.items[0].returnRequestId, dto.id);
        assert.equal(
            sellerOrder.timeline[sellerOrder.timeline.length - 1].status,
            "return_requested",
            "the split records the transition"
        );

        assert.equal((await Order.findById(fixture.orderId)).status, "return_requested");

        const customerNotice = await Notification.findOne({ type: "return_update" });
        assert.equal(customerNotice.title, "Return Requested");
        assert.equal(
            customerNotice.body,
            "Return requested for Aurora Wireless Headphones (2 of 3)."
        );
        assert.equal(customerNotice.data.returnId, dto.id);
        assert.equal(customerNotice.data.orderId, fixture.orderId);

        const sellerNotice = await Notification.findOne({ type: "seller_return_request" });
        assert.equal(sellerNotice.title, "Return Request");
        assert.equal(
            sellerNotice.body,
            `Aurora Wireless Headphones from order ${fixture.orderCode} needs a decision.`
        );
        assert.equal(String(sellerNotice.userId), String(fixture.seller.user.id));
        assert.equal(sellerNotice.data.returnId, dto.id);
    });

    it("refuses a second open request for the same line", async () => {
        const fixture = await buyAndDeliver("one-open");

        const first = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(first.status, 201, first.raw);

        const second = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "wrong_item"
        });

        assert.equal(second.status, 422, second.raw);
        assert.equal(second.body.error.message, "A return request already exists for this item.");
        assert.deepEqual(second.body.error.fields, [
            { field: "items[0].lineId", message: "A return request already exists for this item." }
        ]);
        assert.equal(await ReturnRequest.countDocuments({}), 1, "the duplicate creates nothing");
    });

    it("keeps the quantity inside what the customer still holds", async () => {
        const fixture = await buyAndDeliver("quantity");

        for (const quantity of [0, 5, 2.5]) {
            const response = await postReturn(fixture.customer.token, fixture.orderId, {
                lineId: fixture.lineId,
                reason: "damaged",
                quantity
            });
            assert.equal(response.status, 422, response.raw);
            assert.equal(response.body.error.message, "Enter a return quantity between 1 and 3.");
            assert.deepEqual(response.body.error.fields, [
                { field: "items[0].quantity", message: "Enter a return quantity between 1 and 3." }
            ]);
        }

        const omitted = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(omitted.status, 201, omitted.raw);
        assert.equal(
            omitted.body.data.returns[0].quantity,
            3,
            "an omitted quantity means every remaining unit"
        );
    });

    it("refuses a line whose units are all already returned", async () => {
        const fixture = await buyAndDeliver("all-returned");

        // A snapshot claiming full receipt while still reading `delivered` is
        // the only way the returnable count reaches zero under an eligible
        // status — the guard must catch it before any quantity is accepted.
        const sellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        sellerOrder.items[0].returnedQuantity = 3;
        await sellerOrder.save();

        const response = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.message, "Every unit of this item has already been returned.");
        assert.deepEqual(response.body.error.fields, [
            { field: "items[0].lineId", message: "Every unit of this item has already been returned." }
        ]);
    });
});

// ------------------------------------------------------------ seller decisions

describe("seller decisions", () => {
    const pendingReturn = async (label, overrides = {}) => {
        const fixture = await buyAndDeliver(label, overrides);
        const created = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "defective",
            quantity: 1
        });
        assert.equal(created.status, 201, created.raw);
        return { ...fixture, returnId: created.body.data.returns[0].id };
    };

    it("approves: freezes the line, notifies the customer, restocks nothing yet", async () => {
        const fixture = await pendingReturn("approve");

        const response = await approveReturn(fixture.seller.token, fixture.returnId);

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Return approved.");
        assert.equal(response.body.data.status, "approved");
        assert.deepEqual(statusesOf(response.body.data), ["pending", "approved"]);

        const sellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        assert.equal(sellerOrder.status, "return_approved");
        assert.equal(sellerOrder.items[0].status, "return_approved");
        assert.equal(sellerOrder.items[0].returnRequestId, fixture.returnId);
        assert.equal((await Order.findById(fixture.orderId)).status, "return_approved");

        const notice = await Notification.findOne({ type: "return_update", title: "Return Approved" });
        assert.ok(notice, "the customer is told");
        assert.equal(
            notice.body,
            "Your return for Aurora Wireless Headphones was approved. Send the item back when you can."
        );

        assert.equal(
            (await Product.findById(fixture.product._id)).stock,
            9,
            "approval must not restock: the goods have not arrived"
        );
        assert.equal(await InventoryAdjustment.countDocuments({ reason: "return" }), 0);
    });

    it("rejects: hands the line back and clears the open request id", async () => {
        const fixture = await pendingReturn("reject");

        const response = await rejectReturn(fixture.seller.token, fixture.returnId);

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Return rejected.");
        assert.equal(response.body.data.status, "rejected");
        assert.deepEqual(statusesOf(response.body.data), ["pending", "rejected"]);

        const sellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        assert.equal(sellerOrder.status, "delivered", "the split re-derives from its items");
        assert.equal(sellerOrder.items[0].status, "delivered");
        assert.equal(sellerOrder.items[0].returnRequestId, null);
        assert.equal((await Order.findById(fixture.orderId)).status, "delivered");

        const notice = await Notification.findOne({ type: "return_update", title: "Return Rejected" });
        assert.equal(notice.body, "Your return for Aurora Wireless Headphones was rejected.");
        assert.equal(
            (await Product.findById(fixture.product._id)).stock,
            9,
            "a rejection never touches stock"
        );
    });

    it("refuses to decide the same request twice", async () => {
        const fixture = await pendingReturn("double-decide");

        const approved = await approveReturn(fixture.seller.token, fixture.returnId);
        assert.equal(approved.status, 200, approved.raw);

        const again = await approveReturn(fixture.seller.token, fixture.returnId);
        assert.equal(again.status, 409, again.raw);
        assert.equal(again.body.error.code, "conflict");
        assert.equal(again.body.error.message, "This return request has already been decided.");

        const flipped = await rejectReturn(fixture.seller.token, fixture.returnId);
        assert.equal(flipped.status, 409, flipped.raw);
        assert.equal(flipped.body.error.message, "This return request has already been decided.");

        const stored = await ReturnRequest.findById(fixture.returnId);
        assert.equal(stored.status, "approved");
        assert.deepEqual(stored.timeline.map((entry) => entry.status), ["pending", "approved"]);
    });

    it("refuses to process a return before it is approved", async () => {
        const fixture = await pendingReturn("too-early");

        const response = await markArrived(fixture.seller.token, fixture.returnId);

        assert.equal(response.status, 409, response.raw);
        assert.equal(response.body.error.code, "conflict");
        assert.equal(response.body.error.message, "Return must be approved first.");
        assert.equal((await ReturnRequest.findById(fixture.returnId)).status, "pending");
        assert.equal((await Product.findById(fixture.product._id)).stock, 9);
    });

    it("keeps other sellers and customers out", async () => {
        const fixture = await pendingReturn("ownership");
        const otherSeller = await makeSeller("ownership-other");

        const read = await api("GET", `/seller/returns/${fixture.returnId}`, { token: otherSeller.token });
        assert.equal(read.status, 404, read.raw);
        assert.equal(read.body.error.message, "Return request not found.");

        const decide = await approveReturn(otherSeller.token, fixture.returnId);
        assert.equal(decide.status, 404, decide.raw);
        assert.equal(decide.body.error.message, "Return request not found.");

        const unknown = await api("GET", `/seller/returns/${new mongoose.Types.ObjectId()}`, {
            token: fixture.seller.token
        });
        assert.equal(unknown.status, 404, unknown.raw);

        const list = await api("GET", "/seller/returns", { token: fixture.customer.token });
        assert.equal(list.status, 403, list.raw);
        assert.equal(list.body.error.message, "You do not have a seller account.");

        const stored = await ReturnRequest.findById(fixture.returnId);
        assert.equal(stored.status, "pending", "none of the refused calls changed anything");
    });
});

// ---------------------------------------------------------- refunds and stock

describe("processing an arrival", () => {
    it("restocks, refunds, and settles the order in full", async () => {
        const fixture = await buyAndDeliver("full-refund", { freeShipping: true });
        const paymentBefore = await PaymentTransaction.findOne({ orderId: fixture.orderId });
        assert.equal(paymentBefore.amount, 300, "free shipping makes the payment equal the line");

        const created = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "defective",
            quantity: 3
        });
        assert.equal(created.status, 201, created.raw);
        const returnId = created.body.data.returns[0].id;

        assert.equal((await approveReturn(fixture.seller.token, returnId)).status, 200);
        const response = await markArrived(fixture.seller.token, returnId);

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Return processed.");
        assert.equal(response.body.data.status, "refunded");
        assert.deepEqual(statusesOf(response.body.data), ["pending", "approved", "returned", "refunded"]);

        assert.equal((await Product.findById(fixture.product._id)).stock, 12, "all 3 units are back");

        const adjustment = await InventoryAdjustment.findOne({ reason: "return" });
        assert.ok(adjustment, "the arrival is ledgered");
        assert.equal(adjustment.quantity, 3);
        assert.equal(adjustment.referenceId, fixture.orderId);
        assert.equal(String(adjustment.sellerId), String(fixture.seller.profile._id));

        const payment = await PaymentTransaction.findOne({ orderId: fixture.orderId });
        assert.equal(payment.status, "refunded");
        assert.equal(payment.refundedAmount, 300);
        assert.ok(payment.refundedAt);

        const order = await Order.findById(fixture.orderId);
        assert.equal(order.paymentStatus, "refunded", "the full payment went back");
        assert.equal(order.status, "returned");

        const sellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        assert.equal(sellerOrder.status, "returned");
        assert.equal(sellerOrder.items[0].status, "returned");
        assert.equal(sellerOrder.items[0].returnedQuantity, 3);
        assert.equal(sellerOrder.items[0].remainingQuantity, 0);

        const notice = await Notification.findOne({ type: "return_update", title: "Returned" });
        assert.equal(notice.body, "Your return for Aurora Wireless Headphones has been processed.");
        assert.equal(
            await Notification.countDocuments({ type: "seller_return_request" }),
            1,
            "the seller hears once, at creation — the simulator emits no seller notice on decide/arrival"
        );

        const again = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(again.status, 422, again.raw);
        assert.equal(again.body.error.message, "Only delivered items can be returned.");
    });

    it("handles a partial return, then the remainder, without over-refunding", async () => {
        const fixture = await buyAndDeliver("partial");
        const paymentBefore = await PaymentTransaction.findOne({ orderId: fixture.orderId });
        assert.equal(paymentBefore.amount, 360, "300 of goods + 60 of shipping");

        const first = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged",
            quantity: 1
        });
        assert.equal(first.status, 201, first.raw);
        const firstId = first.body.data.returns[0].id;
        assert.equal((await approveReturn(fixture.seller.token, firstId)).status, 200);
        assert.equal((await markArrived(fixture.seller.token, firstId)).status, 200);

        const sellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        assert.equal(sellerOrder.items[0].status, "partially_returned");
        assert.equal(sellerOrder.items[0].returnedQuantity, 1);
        assert.equal(sellerOrder.items[0].remainingQuantity, 2);
        assert.equal(sellerOrder.status, "partially_returned");
        assert.equal((await Order.findById(fixture.orderId)).status, "partially_returned");
        assert.equal((await Product.findById(fixture.product._id)).stock, 10, "1 of 3 came back");

        const payment = await PaymentTransaction.findOne({ orderId: fixture.orderId });
        assert.equal(payment.refundedAmount, 100, "one unit at ৳100");
        assert.equal(payment.status, "refunded");
        assert.equal(
            (await Order.findById(fixture.orderId)).paymentStatus,
            "paid",
            "shipping is never refunded, so a partial return cannot settle the order in full"
        );

        const tooMany = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged",
            quantity: 3
        });
        assert.equal(tooMany.status, 422, tooMany.raw);
        assert.equal(
            tooMany.body.error.message,
            "Enter a return quantity between 1 and 2. 1 of 3 already returned."
        );
        assert.deepEqual(tooMany.body.error.fields, [
            {
                field: "items[0].quantity",
                message: "Enter a return quantity between 1 and 2. 1 of 3 already returned."
            }
        ]);

        const second = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged",
            quantity: 2
        });
        assert.equal(second.status, 201, second.raw);
        const secondId = second.body.data.returns[0].id;
        assert.equal((await approveReturn(fixture.seller.token, secondId)).status, 200);
        assert.equal((await markArrived(fixture.seller.token, secondId)).status, 200);

        const finalRequest = await ReturnRequest.findById(secondId);
        assert.equal(finalRequest.status, "refunded");

        const finalSellerOrder = await SellerOrder.findById(fixture.sellerOrderId);
        assert.equal(finalSellerOrder.items[0].status, "returned");
        assert.equal(finalSellerOrder.items[0].returnedQuantity, 3);
        assert.equal(finalSellerOrder.items[0].remainingQuantity, 0);
        assert.equal((await Product.findById(fixture.product._id)).stock, 12, "every unit is back");

        const finalPayment = await PaymentTransaction.findOne({ orderId: fixture.orderId });
        assert.equal(finalPayment.refundedAmount, 300, "refunds accumulate across requests");
        assert.equal(finalPayment.amount - finalPayment.refundedAmount, 60, "the shipping stays collected");
        assert.equal(
            await InventoryAdjustment.countDocuments({ reason: "return" }),
            2,
            "one ledger row per arrival"
        );
    });

    it("leaves the money alone when a replacement is requested", async () => {
        const fixture = await buyAndDeliver("replacement");

        const created = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "wrong_item",
            quantity: 1,
            preferredResolution: "replacement"
        });
        assert.equal(created.status, 201, created.raw);
        const returnId = created.body.data.returns[0].id;
        assert.equal(created.body.data.returns[0].preferredResolution, "replacement");

        assert.equal((await approveReturn(fixture.seller.token, returnId)).status, 200);
        const response = await markArrived(fixture.seller.token, returnId);

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.status, "returned", "a replacement never reaches refunded");
        assert.deepEqual(statusesOf(response.body.data), ["pending", "approved", "returned"]);

        const payment = await PaymentTransaction.findOne({ orderId: fixture.orderId });
        assert.equal(payment.status, "paid");
        assert.equal(payment.refundedAmount, 0);
        assert.equal(payment.refundedAt, null);
        assert.equal((await Order.findById(fixture.orderId)).paymentStatus, "paid");

        assert.equal((await Product.findById(fixture.product._id)).stock, 10, "the unit still came back");
        assert.equal((await SellerOrder.findById(fixture.sellerOrderId)).status, "partially_returned");
    });
});

// --------------------------------------------------------------------- reads

describe("reading returns", () => {
    it("serves scoped customer and seller lists with the status filter", async () => {
        const fixture = await buyAndDeliver("reads");
        const stranger = await registerUser("reads-stranger");

        const created = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(created.status, 201, created.raw);
        const returnId = created.body.data.returns[0].id;

        const mine = await api("GET", "/returns", { token: fixture.customer.token });
        assert.equal(mine.status, 200, mine.raw);
        assert.equal(mine.body.meta.message, "Returns fetched.");
        assert.equal(mine.body.data.returns.length, 1);
        assert.equal(mine.body.data.returns[0].id, returnId);
        assertNoMongoIds(mine.raw, "the customer list");

        const theirs = await api("GET", "/returns", { token: stranger.token });
        assert.equal(theirs.status, 200, theirs.raw);
        assert.deepEqual(theirs.body.data.returns, [], "another customer sees nothing");

        const forOrder = await api("GET", `/orders/${fixture.orderId}/returns`, {
            token: fixture.customer.token
        });
        assert.equal(forOrder.status, 200, forOrder.raw);
        assert.equal(forOrder.body.data.returns.length, 1);

        const foreignOrder = await api("GET", `/orders/${fixture.orderId}/returns`, {
            token: stranger.token
        });
        assert.equal(foreignOrder.status, 404, foreignOrder.raw);
        assert.equal(foreignOrder.body.error.message, "Order not found.");

        const sellerList = await api("GET", "/seller/returns", { token: fixture.seller.token });
        assert.equal(sellerList.status, 200, sellerList.raw);
        assert.equal(sellerList.body.data.returns.length, 1);
        assert.equal(sellerList.body.data.returns[0].sellerId, String(fixture.seller.profile._id));
        assertNoMongoIds(sellerList.raw, "the seller list");

        const pending = await api("GET", "/seller/returns?status=pending", { token: fixture.seller.token });
        assert.equal(pending.status, 200, pending.raw);
        assert.equal(pending.body.data.returns.length, 1);

        const rejected = await api("GET", "/seller/returns?status=rejected", { token: fixture.seller.token });
        assert.equal(rejected.status, 200, rejected.raw);
        assert.deepEqual(rejected.body.data.returns, []);

        const bogus = await api("GET", "/seller/returns?status=exploded", { token: fixture.seller.token });
        assert.equal(bogus.status, 422, bogus.raw);
        assert.equal(bogus.body.error.message, "That return status is not supported.");
        assert.deepEqual(bogus.body.error.fields, [
            { field: "status", message: "That return status is not supported." }
        ]);

        const detail = await api("GET", `/seller/returns/${returnId}`, { token: fixture.seller.token });
        assert.equal(detail.status, 200, detail.raw);
        assert.equal(detail.body.meta.message, "Return fetched.");
        assert.equal(detail.body.data.id, returnId);
        assert.equal(detail.body.data.orderItemId, fixture.lineId);
    });
});

// -------------------------------------------------- customer/seller round trip
//
// The customer screens and the seller workspace talk to these endpoints from
// opposite ends of the app (M17). What matters is that one HTTP round trip ties
// them together: the id the customer is handed is the id the seller decides, and
// the customer's own reads keep reporting that request's state afterwards. A
// mirror-only "return" broke exactly that — the seller was handed a local id the
// server had never issued, so the decision 404'd and the status vanished on the
// next sync.

describe("customer to seller return round trip", () => {
    it("hands the seller the same id the customer filed, and keeps the state server-side", async () => {
        const fixture = await buyAndDeliver("round-trip");

        const created = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged",
            quantity: 1
        });
        assert.equal(created.status, 201, created.raw);
        const returnId = created.body.data.returns[0].id;
        assert.ok(returnId, "the customer is handed a server id");

        const list = await api("GET", "/orders", { token: fixture.customer.token });
        assert.equal(list.status, 200, list.raw);
        assert.equal(
            list.body.data.orders.find((order) => order.id === fixture.orderId).status,
            "return_requested",
            "the order history reports the return"
        );

        const detail = await api("GET", `/orders/${fixture.orderId}`, { token: fixture.customer.token });
        assert.equal(detail.status, 200, detail.raw);
        assert.equal(detail.body.data.order.status, "return_requested");
        const line = detail.body.data.sellerOrders
            .flatMap((sellerOrder) => sellerOrder.items)
            .find((item) => item.id === fixture.lineId);
        assert.equal(line.status, "return_requested");
        assert.equal(line.returnRequestId, returnId, "the line points at the server id");

        const sellerList = await api("GET", "/seller/returns", { token: fixture.seller.token });
        assert.equal(sellerList.status, 200, sellerList.raw);
        assert.ok(
            sellerList.body.data.returns.some((request) => request.id === returnId),
            "the customer's id is the seller's id"
        );

        const approved = await approveReturn(fixture.seller.token, returnId);
        assert.equal(approved.status, 200, approved.raw);
        assert.equal(approved.body.data.id, returnId);

        const mine = await api("GET", "/returns", { token: fixture.customer.token });
        assert.equal(mine.status, 200, mine.raw);
        assert.equal(mine.body.data.returns[0].id, returnId);
        assert.equal(mine.body.data.returns[0].status, "approved", "the decision survives the customer's next read");
    });

    it("answers a repeat submit with the original request, never a second record", async () => {
        const fixture = await buyAndDeliver("round-trip-duplicate");

        const first = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "damaged"
        });
        assert.equal(first.status, 201, first.raw);
        const returnId = first.body.data.returns[0].id;

        const duplicate = await postReturn(fixture.customer.token, fixture.orderId, {
            lineId: fixture.lineId,
            reason: "wrong_item"
        });
        assert.equal(duplicate.status, 422, duplicate.raw);
        assert.equal(duplicate.body.error.message, "A return request already exists for this item.");

        // No second row: the customer read returns the original, whose status the
        // UI can show instead of a bare "already exists".
        const mine = await api("GET", "/returns", { token: fixture.customer.token });
        assert.equal(mine.status, 200, mine.raw);
        assert.equal(mine.body.data.returns.length, 1);
        assert.equal(mine.body.data.returns[0].id, returnId);
        assert.equal(mine.body.data.returns[0].status, "pending");

        const forOrder = await api("GET", `/orders/${fixture.orderId}/returns`, { token: fixture.customer.token });
        assert.equal(forOrder.status, 200, forOrder.raw);
        assert.equal(forOrder.body.data.returns.length, 1);
        assert.equal(forOrder.body.data.returns[0].id, returnId);
    });
});
