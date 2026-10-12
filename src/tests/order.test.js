/**
 * Checkout + orders suite (slice "checkout + orders", milestone M12).
 *
 * Runs against a dedicated `vanta_order_test` database and an ephemeral port,
 * asserting what a client observes: status, envelope, message, ownership, the
 * payment/seller-split/ledger/notification rows an order leaves behind, and
 * the idempotency, oversell and voucher-reuse guards.
 *
 * Run JUST this file:
 *
 *     node --test src/tests/order.test.js
 *
 * The slice router is not wired into `src/app.js` yet (a coordinator does that
 * once every slice lands), so the suite stands up the same stack `app.js`
 * builds — request id, body parsers, cookie parser, the identity/cart/voucher
 * routers — plus this slice's router, then the same JSON 404/error handlers.
 *
 * The suite drops `vanta_order_test` when it finishes; it never touches the
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
import voucherRouter from "../routes/voucher.route.js";
import orderRouter from "../routes/order.route.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";
import { Voucher } from "../models/voucher.model.js";
import { Order } from "../models/order.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { PaymentTransaction } from "../models/payment-transaction.model.js";
import { InventoryAdjustment } from "../models/inventory-adjustment.model.js";
import { Notification } from "../models/notification.model.js";
import { SELLER_FULFILLMENT_FLOW } from "../core/order-status.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `order-${label}-${++sequence}-${Date.now()}@example.com`;

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
    instance.use("/api/v1", voucherRouter);
    instance.use("/api/v1", orderRouter);
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

const makeProduct = async (seller, overrides = {}) => {
    const product = await Product.create({
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
    return product;
};

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

const liveVoucher = (overrides = {}) =>
    Voucher.create({
        code: "SAVE10",
        title: "Save 10",
        type: "percentage",
        discountValue: 10,
        minimumOrder: 0,
        maximumDiscount: null,
        scope: "platform",
        categoryId: null,
        productIds: [],
        startAt: new Date(Date.now() - 86_400_000),
        expiry: new Date(Date.now() + 86_400_000),
        usageLimit: 1,
        usageCount: 0,
        perUserLimit: 1,
        perUserUsed: {},
        active: true,
        description: "",
        ...overrides
    });

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the order suite");

    await mongoose.connect(`${base}/vanta_order_test`);

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

// ----------------------------------------------------------------- checkout

describe("checkout", () => {
    it("rejects a checkout with an empty cart", async () => {
        const customer = await registerUser("empty-cart");

        const response = await buy(customer.token);

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.message, "Your cart is empty.");
    });

    it("previews authoritative groups, totals and a delivery quote", async () => {
        const seller = await makeSeller("preview");
        const customer = await registerUser("preview-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 3 });

        const response = await api("POST", "/checkout/preview", {
            token: customer.token,
            body: { address: { ...ADDRESS }, deliveryMethod: "standard" }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.ok, true);
        const { data } = response.body;
        assert.equal(data.groups[0].subtotal, 300);
        assert.equal(data.totals.subtotal, 300);
        assert.equal(data.totals.shippingTotal, 60);
        assert.equal(data.totals.grandTotal, 360);
        assert.equal(data.quote.methodId, "standard");
        assert.equal(data.voucher, null);
        assertNoMongoIds(response.raw, "preview response");
    });

    it("places an order, clears purchased lines and returns a full receipt", async () => {
        const seller = await makeSeller("place");
        const customer = await registerUser("place-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 2 });

        const response = await buy(customer.token);

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.meta.message, "Order placed.");
        assertNoMongoIds(response.raw, "create response");

        const { order, sellerOrders, payment, cart } = response.body.data;
        assert.equal(typeof order.id, "string");
        assert.equal(order.orderCode, order.orderNumber);
        assert.match(order.orderCode, /^ORD-\d{10}\d{2}$/);
        assert.equal(order.status, "placed");
        assert.equal(order.subtotal, 200);
        assert.equal(order.shippingTotal, 60);
        assert.equal(order.total, 260);
        assert.deepEqual(order.totals, { subtotal: 200, shipping: 60, voucherDiscount: 0, total: 260 });
        assert.equal(order.paymentMethod, "cod");
        assert.equal(order.paymentStatus, "pending");
        assert.equal(order.deliveryMethod, "standard");
        assert.equal(order.address.recipientName, "Ada Lovelace");
        assert.equal(order.sellerCount, 1);
        assert.equal(order.canCancel, true);
        assert.deepEqual(order.items, []);
        assert.equal(sellerOrders.length, 1);
        assert.equal(sellerOrders[0].sellerId, String(seller.profile._id));
        assert.equal(sellerOrders[0].status, "new");
        assert.equal(sellerOrders[0].items[0].quantity, 2);
        assert.equal(payment.method, "cod");
        assert.equal(payment.status, "pending");
        assert.equal(payment.amount, 260);
        // The receipt echoes the cart as it was priced AT PLACEMENT (the
        // audit's decision); the database itself is emptied, which the live
        // cart view below proves.
        assert.equal(cart.cart.items.length, 1, "the receipt shows the cart at placement time");
        assert.equal(cart.cart.items[0].quantity, 2);
        assert.equal(cart.items.length, 1, "the flat priced lines carry the purchased item");
        assert.equal(cart.itemCount, 2);
        assert.equal(typeof cart.cartId, "string");
        const after = await api("GET", "/cart", { token: customer.token });
        assert.deepEqual(after.body.data.cart.items, [], "bought lines are removed from the cart");

        const stored = await Order.findById(order.id);
        assert.equal(stored.orderCode, order.orderCode);
        const sellerOrder = await SellerOrder.findOne({ orderId: stored._id });
        assert.equal(String(sellerOrder.sellerId), String(seller.profile._id));
        const adjustment = await InventoryAdjustment.findOne({ referenceId: String(stored._id) });
        assert.equal(adjustment.reason, "sale");
        assert.equal(adjustment.quantity, -2);
        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.stock, 10, "stock decremented for the sale");
        const sellerNote = await Notification.findOne({ type: "seller_new_order" });
        assert.equal(String(sellerNote.userId), String(seller.profile.userId));
        assert.equal(sellerNote.body, `Order ${order.orderCode} needs your confirmation.`);
        const customerNote = await Notification.findOne({ type: "order_placed" });
        assert.equal(String(customerNote.userId), customer.user.id);
    });

    it("accepts the task-style address shape and normalises it", async () => {
        const seller = await makeSeller("task-address");
        const customer = await registerUser("task-address-customer");
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id));

        const response = await api("POST", "/orders", {
            token: customer.token,
            body: {
                address: {
                    fullName: "Bob Builder",
                    phone: "01712345678",
                    line1: "Flat 4B, House 9",
                    line2: "Road 5, Banani",
                    city: "Dhaka",
                    district: "Dhaka",
                    postalCode: "1213"
                },
                paymentMethod: "nagad"
            }
        });

        assert.equal(response.status, 201, response.raw);
        const { order } = response.body.data;
        assert.equal(order.address.recipientName, "Bob Builder");
        assert.equal(order.address.division, "Dhaka");
        assert.equal(order.address.addressLine, "Flat 4B, House 9, Road 5, Banani");
        assert.ok(order.address.area, "area is derived so the snapshot stays valid");
        assert.equal(order.paymentMethod, "nagad");
        assert.equal(order.paymentStatus, "paid");
    });

    it("ignores client totals, item lists and seller ids — the server re-prices", async () => {
        const seller = await makeSeller("hostile");
        const customer = await registerUser("hostile-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 2 });

        const foreignSellerId = String((await makeSeller("foreign")).profile._id);

        const response = await buy(customer.token, {
            total: 1,
            subtotal: 1,
            items: [{ productId: "bogus", quantity: 999 }],
            sellerId: foreignSellerId
        });

        assert.equal(response.status, 201, response.raw);
        const { order, sellerOrders } = response.body.data;
        assert.equal(order.subtotal, 200, "client subtotal ignored");
        assert.equal(order.total, 260, "client total ignored");
        assert.equal(String(order.customerId), customer.user.id, "owner is the caller");
        assert.equal(sellerOrders[0].sellerId, String(seller.profile._id), "client sellerId ignored");
    });

    it("rejects a line whose stock ran out after it was added", async () => {
        const seller = await makeSeller("oversell");
        const customer = await registerUser("oversell-customer");
        const product = await makeProduct(seller, { name: "Stocked Mug", regularPrice: 50, stock: 3 });
        await addToCart(customer.token, product._id, { quantity: 3 });

        await Product.updateOne({ _id: product._id }, { $set: { stock: 1 } });

        const response = await buy(customer.token);

        assert.equal(response.status, 422, response.raw);
        assert.equal(
            response.body.error.message,
            "\"Stocked Mug\" does not have enough stock — only 1 left."
        );
        assert.equal(await Order.countDocuments({}), 0, "nothing was written");
        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.stock, 1, "stock untouched");
    });

    it("rejects an online-paid checkout fresh and clean (no orphan payment rows)", async () => {
        const seller = await makeSeller("no-orphan");
        const customer = await registerUser("no-orphan-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 2 });

        const response = await buy(customer.token, { paymentMethod: "bkash" });

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.data.payment.status, "paid");
        assert.equal(response.body.data.order.paymentStatus, "paid");

        const systemNote = await Notification.findOne({ type: "system" });
        assert.equal(systemNote.title, "Payment Received");
        assert.equal(response.body.data.order.total, 260);
        assert.equal(await PaymentTransaction.countDocuments({}), 1);
    });
});

// ------------------------------------------------------------------ vouchers

describe("voucher redemption", () => {
    it("applies a valid code once and refuses to reuse it for a second order", async () => {
        const seller = await makeSeller("voucher");
        const customer = await registerUser("voucher-customer");
        await makeProduct(seller);
        const voucher = await liveVoucher();
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const first = await buy(customer.token, { voucherCode: "save10" });

        assert.equal(first.status, 201, first.raw);
        assert.equal(first.body.data.order.vouchersDiscount, 20);
        assert.equal(first.body.data.order.total, 240);
        assert.deepEqual(first.body.data.order.voucherCodes, ["SAVE10"]);

        const storedVoucher = await Voucher.findById(voucher._id);
        assert.equal(storedVoucher.usageCount, 1);
        assert.equal(storedVoucher.perUserUsed[customer.user.id], 1);

        // Refill the cart and try the same code on a different submission.
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const second = await buy(customer.token, { voucherCode: "save10", deliveryMethod: "express" });

        assert.equal(second.status, 422, second.raw);
        assert.equal(second.body.error.code, "validation_failed");
        assert.equal(second.body.error.message, "Usage limit reached");
        assert.equal(await Order.countDocuments({}), 1, "a rejected code writes nothing");
        assert.equal(await PaymentTransaction.countDocuments({}), 1);
    });
});

// ------------------------------------------------------------------ idempotency

describe("idempotency", () => {
    it("replays the same submission under the same idempotency key", async () => {
        const seller = await makeSeller("replay");
        const customer = await registerUser("replay-customer");
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const first = await buy(customer.token, { idempotencyKey: "retry-1" });
        assert.equal(first.status, 201, first.raw);
        const firstOrderId = first.body.data.order.id;

        // The order cleared the cart; the client retries a double-tap, so it
        // refills identically and submits the same key.
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const second = await buy(customer.token, { idempotencyKey: "retry-1" });

        assert.equal(second.status, 200, second.raw);
        assert.equal(second.body.meta.message, "Order already placed.");
        assert.equal(second.body.data.order.id, firstOrderId, "same order, no second write");
        assert.equal(await Order.countDocuments({}), 1);
        assert.equal(await PaymentTransaction.countDocuments({}), 1);
    });

    it("replays an explicit key after the first order cleared the cart (no refill)", async () => {
        const seller = await makeSeller("replay-cleared");
        const customer = await registerUser("replay-cleared-customer");
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const first = await buy(customer.token, { idempotencyKey: "retry-cleared" });
        assert.equal(first.status, 201, first.raw);
        const firstOrderId = first.body.data.order.id;

        // An ambiguous timeout: the client never saw the response and retries the
        // SAME key, but the server already emptied the purchased line. An explicit
        // key is scoped by the key alone, so this must replay the order, not 409
        // on the now-different cart and not create a second order.
        const second = await buy(customer.token, { idempotencyKey: "retry-cleared" });

        assert.equal(second.status, 200, second.raw);
        assert.equal(second.body.data.order.id, firstOrderId, "same order, no second write");
        assert.equal(await Order.countDocuments({}), 1);
        assert.equal(await PaymentTransaction.countDocuments({}), 1);
    });

    it("conflicts when the same key carries different order details", async () => {
        const seller = await makeSeller("conflict");
        const customer = await registerUser("conflict-customer");
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const first = await buy(customer.token, { idempotencyKey: "retry-2" });
        assert.equal(first.status, 201, first.raw);

        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const second = await buy(customer.token, { idempotencyKey: "retry-2", paymentMethod: "bkash" });

        assert.equal(second.status, 409, second.raw);
        assert.equal(second.body.error.code, "conflict");
        assert.equal(
            second.body.error.message,
            "That idempotency key was already used with different order details."
        );
        assert.equal(await Order.countDocuments({}), 1);
    });
});

// -------------------------------------------------------------- customer reads

describe("customer order reads", () => {
    let seller;
    let customer;

    beforeEach(async () => {
        seller = await makeSeller("reads-seller");
        customer = await registerUser("reads-customer");
    });

    it("lists only the caller's own orders, newest first", async () => {
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);
        const placedCode = placed.body.data.order.orderCode;

        const other = await registerUser("reads-other");
        const empty = await api("GET", "/orders", { token: other.token });
        assert.equal(empty.status, 200, empty.raw);
        assert.deepEqual(empty.body.data.orders, []);

        const list = await api("GET", "/orders", { token: customer.token });
        assert.equal(list.status, 200, list.raw);
        assert.equal(list.body.data.orders.length, 1);
        assert.equal(list.body.data.orders[0].orderCode, placedCode);
        assert.equal(list.body.data.orders[0].canCancel, true);
        assert.equal(list.body.data.orders[0].sellerCount, 1);
    });

    it("returns 404 for another customer's order (IDOR guard)", async () => {
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);

        const other = await registerUser("idor-customer");
        const response = await api("GET", `/orders/${placed.body.data.order.id}`, { token: other.token });

        assert.equal(response.status, 404, response.raw);
        assert.equal(response.body.error.message, "Order not found.");
        assert.equal(response.body.error.code, "not_found");
    });

    it("detail returns the order with its seller splits and payment", async () => {
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);

        const response = await api("GET", `/orders/${placed.body.data.order.id}`, { token: customer.token });

        assert.equal(response.status, 200, response.raw);
        const { order, sellerOrders, payment } = response.body.data;
        assert.equal(order.id, placed.body.data.order.id);
        assert.equal(order.items.length, 1, "detail carries the item snapshots");
        assert.equal(sellerOrders.length, 1);
        assert.equal(payment.length, 1);
        assert.equal(payment[0].orderId, order.id);
    });
});

// --------------------------------------------------------------------- cancel

describe("order cancellation", () => {
    it("restocks, refunds online payments and records the ledger", async () => {
        const seller = await makeSeller("cancel");
        const customer = await registerUser("cancel-customer");
        const product = await makeProduct(seller, { regularPrice: 100 });
        await addToCart(customer.token, product._id, { quantity: 2 });

        const placed = await buy(customer.token, { paymentMethod: "bkash" });
        assert.equal(placed.status, 201, placed.raw);
        const orderId = placed.body.data.order.id;

        const cancel = await api("POST", `/orders/${orderId}/cancel`, {
            token: customer.token,
            body: { reason: "Changed my mind" }
        });

        assert.equal(cancel.status, 200, cancel.raw);
        assert.equal(cancel.body.meta.message, "Order cancelled.");
        assert.equal(cancel.body.data.status, "cancelled");
        assert.equal(cancel.body.data.paymentStatus, "refunded");
        assert.ok(cancel.body.data.cancelledAt);

        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.stock, 12, "stock restored on cancellation");
        const refund = await PaymentTransaction.findOne({ orderId: orderId });
        assert.equal(refund.status, "refunded");
        assert.equal(refund.refundedAmount, 260);
        const sellerOrder = await SellerOrder.findOne({ orderId: orderId });
        assert.equal(sellerOrder.status, "cancelled");
        assert.equal(sellerOrder.items[0].status, "cancelled");
        const adjustment = await InventoryAdjustment.findOne({ referenceId: String(orderId), reason: "cancellation" });
        assert.equal(adjustment.quantity, 2);
        assert.equal(await Notification.countDocuments({ type: "order_cancelled" }), 1);
        assert.equal(await Notification.countDocuments({ type: "seller_order_cancelled" }), 1);
    });

    it("refuses cancellation once fulfilment has started past the cancellable window", async () => {
        const seller = await makeSeller("no-cancel");
        const customer = await registerUser("no-cancel-customer");
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);
        const orderId = placed.body.data.order.id;

        const sellerOrder = await SellerOrder.findOne({ orderId });
        // new -> confirmed -> processing -> packed: past the cancellable window.
        const sellerOrderId = sellerOrder._id;
        for (let i = 0; i < 3; i += 1) {
            const moved = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
            assert.equal(moved.status, 200, moved.raw);
        }

        const cancel = await api("POST", `/orders/${orderId}/cancel`, { token: customer.token, body: { reason: "Please" } });

        assert.equal(cancel.status, 422, cancel.raw);
        assert.equal(cancel.body.error.message, "This order can no longer be cancelled.");
        const final = await Order.findById(orderId);
        assert.equal(final.status, "packed");
        assert.equal(await SellerOrder.findById(sellerOrderId).then((row) => row.status), "packed");
    });

    it("returns 404 for cancelling an unknown or foreign order", async () => {
        const seller = await makeSeller("unknown-cancel");
        const customer = await registerUser("unknown-cancel-customer");
        await makeProduct(seller);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 2 });

        const other = await registerUser("other-cancel");
        const placed = await buy(customer.token, { idempotencyKey: "cancel-k" });
        assert.equal(placed.status, 201, placed.raw);

        const foreign = await api("POST", `/orders/${placed.body.data.order.id}/cancel`, {
            token: other.token,
            body: { reason: "Mine" }
        });
        assert.equal(foreign.status, 404, foreign.raw);
        assert.equal(foreign.body.error.message, "Order not found.");

        const unknown = await api("POST", `/orders/${new mongoose.Types.ObjectId()}/cancel`, {
            token: customer.token,
            body: { reason: "Gone" }
        });
        assert.equal(unknown.status, 404, unknown.raw);
    });
});

// ------------------------------------------------------------------- seller

describe("seller order surface", () => {
    it("lists and reads the seller's own orders with state hints", async () => {
        const seller = await makeSeller("seller-reads");
        const customer = await registerUser("seller-reads-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 2 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);

        const list = await api("GET", "/seller/orders", { token: seller.token });
        assert.equal(list.status, 200, list.raw);
        assert.equal(list.body.data.orders.length, 1);
        const view = list.body.data.orders[0];
        assert.equal(view.sellerId, String(seller.profile._id));
        assert.equal(view.orderId, placed.body.data.order.id);
        assert.equal(view.status, "new");
        assert.equal(view.lineCount, 1);
        assert.equal(view.itemCount, 2);
        assert.equal(view.canAdvance, true);
        assert.equal(view.nextStatus, "confirmed");
        assert.equal(view.order.status, "placed");
        assert.equal(view.order.orderCode, placed.body.data.order.orderCode);

        const sellerOrderId = view.id;
        const detail = await api("GET", `/seller/orders/${sellerOrderId}`, { token: seller.token });
        assert.equal(detail.status, 200, detail.raw);
        assert.equal(detail.body.data.id, sellerOrderId);
        assert.equal(detail.body.data.items.length, 1);
        assert.equal(detail.body.data.subtotal, 200);
        assert.equal(detail.body.data.shippingFee, 60);
        assert.equal(detail.body.data.total, 260);
    });

    it("is 404 for another seller's split, both read and advance", async () => {
        const sellerA = await makeSeller("idor-a");
        const sellerB = await makeSeller("idor-b");
        const customer = await registerUser("idor-seller-customer");
        await makeProduct(sellerA);
        await addToCart(customer.token, String((await Product.findOne({}))._id), { quantity: 1 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);

        const sellerOrder = await SellerOrder.findOne({ orderId: placed.body.data.order.id });
        const read = await api("GET", `/seller/orders/${sellerOrder._id}`, { token: sellerB.token });
        assert.equal(read.status, 404, read.raw);
        assert.equal(read.body.error.message, "Order not found.");

        const advance = await api("POST", `/seller/orders/${sellerOrder._id}/advance`, { token: sellerB.token });
        assert.equal(advance.status, 404, advance.raw);
        assert.equal(advance.body.error.message, "Seller order not found.");
        const unchanged = await SellerOrder.findById(sellerOrder._id);
        assert.equal(unchanged.status, "new");
    });

    it("advances through the flow and moves the parent order with it", async () => {
        const seller = await makeSeller("advance");
        const customer = await registerUser("advance-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 2 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);
        const orderId = placed.body.data.order.id;
        const sellerOrderId = placed.body.data.sellerOrders[0].id;

        const confirm = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
        assert.equal(confirm.status, 200, confirm.raw);
        assert.equal(confirm.body.data.status, "confirmed");
        assert.equal(confirm.body.data.nextStatus, "processing");
        assert.equal((await Order.findById(orderId)).status, "confirmed");
        assert.equal(await Notification.countDocuments({ type: "order_confirmed" }), 1);

        for (const step of ["processing", "packed", "ready_to_ship"]) {
            const advanced = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
            assert.equal(advanced.status, 200, advanced.raw);
            assert.equal(advanced.body.data.status, step);
        }

        const shipped = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
        assert.equal(shipped.status, 200, shipped.raw);
        assert.equal(shipped.body.data.status, "shipped");
        assert.ok(shipped.body.data.carrier);
        assert.ok(shipped.body.data.trackingNumber);
        assert.equal((await Order.findById(orderId)).status, "shipped");
        assert.equal(await Notification.countDocuments({ type: "order_shipped" }), 1);

        const outForDelivery = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
        assert.equal(outForDelivery.status, 200, outForDelivery.raw);
        assert.equal(outForDelivery.body.data.status, "out_for_delivery");

        const delivered = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
        assert.equal(delivered.status, 200, delivered.raw);
        assert.equal(delivered.body.data.status, "delivered");
        assert.equal(
            delivered.body.data.fulfilledAt,
            delivered.body.data.timeline[delivered.body.data.timeline.length - 1].at
        );
        const finalOrder = await Order.findById(orderId);
        assert.equal(finalOrder.status, "delivered");
        assert.ok(finalOrder.deliveredAt, "deliveredAt stamped once everything arrived");
        assert.equal(finalOrder.paymentStatus, "paid", "COD settles on delivery");
        const payment = await PaymentTransaction.findOne({ orderId });
        assert.equal(payment.status, "paid");
        assert.ok(payment.paidAt);
        assert.equal(await Notification.countDocuments({ type: "order_delivered" }), 1);
        assert.equal(await Notification.countDocuments({ type: "order_shipped" }), 1);

        const stuck = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
        assert.equal(stuck.status, 422, stuck.raw);
        assert.equal(stuck.body.error.message, "Nothing to advance to.");
        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.stock, 10, "delivery does not restock");
    });

    it("walks exactly the shared fulfilment flow the app screens mirror", async () => {
        // The seller UI advances with the same declared order. A status on one
        // side only (e.g. `processing`) dead-ends the seller, so pin the contract
        // and prove the endpoint follows it step for step.
        assert.deepEqual(SELLER_FULFILLMENT_FLOW, [
            "new",
            "confirmed",
            "processing",
            "packed",
            "ready_to_ship",
            "shipped",
            "out_for_delivery",
            "delivered"
        ]);

        const seller = await makeSeller("flow-contract");
        const customer = await registerUser("flow-contract-customer");
        const product = await makeProduct(seller);
        await addToCart(customer.token, product._id, { quantity: 1 });
        const placed = await buy(customer.token);
        assert.equal(placed.status, 201, placed.raw);
        const sellerOrderId = placed.body.data.sellerOrders[0].id;

        const observed = ["new"];
        for (let step = 1; step < SELLER_FULFILLMENT_FLOW.length; step += 1) {
            const moved = await api("POST", `/seller/orders/${sellerOrderId}/advance`, { token: seller.token });
            assert.equal(moved.status, 200, moved.raw);
            assert.equal(moved.body.data.status, SELLER_FULFILLMENT_FLOW[step]);
            assert.equal(moved.body.data.nextStatus, SELLER_FULFILLMENT_FLOW[step + 1] ?? null);
            observed.push(moved.body.data.status);
        }
        assert.deepEqual(observed, [...SELLER_FULFILLMENT_FLOW]);
    });

    it("splits a multi-seller cart into one seller order per seller", async () => {
        const sellerA = await makeSeller("multi-a");
        const sellerB = await makeSeller("multi-b");
        const customer = await registerUser("multi-customer");
        const productA = await makeProduct(sellerA);
        const productB = await makeProduct(sellerB, { name: "Ceramic Vase", sku: "CER-1" });
        await addToCart(customer.token, productA._id, { quantity: 1 });
        await addToCart(customer.token, productB._id, { quantity: 1 });

        const response = await buy(customer.token);

        assert.equal(response.status, 201, response.raw);
        const { order, sellerOrders } = response.body.data;
        assert.equal(order.subtotal, 200);
        assert.equal(order.shippingTotal, 120, "one shipping fee per seller");
        assert.equal(order.total, 320);
        assert.equal(order.sellerCount, 2);
        assert.equal(sellerOrders.length, 2);
        for (const sellerOrder of sellerOrders) {
            assert.equal(sellerOrder.status, "new");
            assert.equal(sellerOrder.items.length, 1);
        }

        const sellerANote = await Notification.findOne({
            type: "seller_new_order",
            userId: sellerA.profile.userId
        });
        const sellerBNote = await Notification.findOne({
            type: "seller_new_order",
            userId: sellerB.profile.userId
        });
        assert.ok(sellerANote);
        assert.ok(sellerBNote);

        const sellerAOrders = await api("GET", "/seller/orders", { token: sellerA.token });
        assert.equal(sellerAOrders.body.data.orders.length, 1);
        assert.equal(sellerAOrders.body.data.orders[0].sellerId, String(sellerA.profile._id));
    });
});