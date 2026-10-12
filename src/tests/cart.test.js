/**
 * Cart foundation suite.
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_cart_test` database, so every assertion below is about what a client
 * would actually observe: status, envelope, error code and the cart view shape.
 *
 * Run: node --test src/tests/cart.test.js
 *
 * The suite drops `vanta_cart_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import cartRouter from "../routes/cart.route.js";
import { Category } from "../models/category.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";
import { Cart } from "../models/cart.model.js";
import { Voucher } from "../models/voucher.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let ctx;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `cart-${label}-${++sequence}-${Date.now()}@example.com`;

const api = async (method, path, { body, token } = {}) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers,
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

const registerUser = async (label = "user") => {
    const response = await api("POST", "/auth/register", {
        body: { name: "Ada Lovelace", email: uniqueEmail(label), phone: "01712345678", password: PASSWORD }
    });
    assert.equal(response.status, 201, response.raw);
    return { token: response.body.data.token, user: response.body.data.user };
};

const addItem = async (token, body) => {
    const response = await api("POST", "/cart/items", { token, body });
    assert.equal(response.status, 201, response.raw);
    return response;
};

// Seller/store/product fixtures — created DIRECTLY via models, as spec'd.
const buildFixtures = async () => {
    const userA = await registerUser("A");
    const userB = await registerUser("B");

    const category = await Category.create({ name: "Fixtures" });

    const makeSeller = async (label, { storeStatus, shippingFee, freeShippingThreshold }) => {
        const profile = await SellerProfile.create({
            userId: new mongoose.Types.ObjectId(),
            fullName: `Seller ${label}`,
            phone: `017${String(sequence).padStart(8, "0")}`,
            email: uniqueEmail(`seller-${label}`),
            nationalId: `NID-${label}-${Date.now()}`,
            sellerType: "individual",
            storeName: `Store ${label}`,
            bank: { bankName: "Test Bank", accountName: "Seller", accountNumber: "000000" },
            agreement: {
                marketplaceTerms: true,
                sellerPolicies: true,
                productAuthenticity: true,
                fulfillmentResponsibility: true
            },
            status: "active"
        });
        const store = await Store.create({
            sellerId: profile._id,
            name: `Store ${label}`,
            logo: `logo-${label}`,
            status: storeStatus,
            shippingFee,
            freeShippingThreshold,
            deliveryEstimateDays: { min: 2, max: 4 }
        });
        return { profile, store };
    };

    const sellerA = await makeSeller("A", { storeStatus: "active", shippingFee: 60, freeShippingThreshold: 999 });
    const sellerB = await makeSeller("B", { storeStatus: "active", shippingFee: 0, freeShippingThreshold: 0 });
    const sellerC = await makeSeller("C", { storeStatus: "paused", shippingFee: 60, freeShippingThreshold: 999 });

    const makeProduct = async (overrides) =>
        Product.create({
            categoryId: category._id,
            regularPrice: 100,
            sku: `SKU-${++sequence}`,
            status: "draft",
            stock: 0,
            ...overrides
        });

    const P1 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Widget One",
        brand: "Alpha",
        sku: "SKU-P1",
        regularPrice: 500,
        status: "active",
        stock: 10,
        images: ["p1.png"]
    });

    const P2 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Shirt Two",
        brand: "Alpha",
        sku: "SKU-P2",
        regularPrice: 500,
        status: "active",
        hasVariants: true,
        variants: [
            { sku: "P2-V1", attributes: { Color: "Red" }, price: 300, stock: 5 },
            { sku: "P2-V2", attributes: { Color: "Blue" }, price: 400, stock: 0 }
        ]
    });
    const P2Full = await Product.findById(P2._id);
    const variantRed = P2Full.variants[0];
    const variantBlue = P2Full.variants[1];

    const P3 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Draft Three",
        sku: "SKU-P3",
        regularPrice: 200,
        status: "draft",
        stock: 5
    });

    const P4 = await makeProduct({
        sellerId: sellerC.profile._id,
        storeId: sellerC.store._id,
        name: "Paused Four",
        sku: "SKU-P4",
        regularPrice: 150,
        status: "active",
        stock: 5
    });

    const P5 = await makeProduct({
        sellerId: sellerB.profile._id,
        storeId: sellerB.store._id,
        name: "Out Five",
        sku: "SKU-P5",
        regularPrice: 250,
        status: "active",
        stock: 0
    });

    const P6 = await makeProduct({
        sellerId: sellerB.profile._id,
        storeId: sellerB.store._id,
        name: "Six B",
        brand: "Beta",
        sku: "SKU-P6",
        regularPrice: 700,
        status: "active",
        stock: 3,
        images: ["p6.png"]
    });

    return {
        userA,
        userB,
        sellerA,
        sellerB,
        sellerC,
        category,
        P1,
        P2,
        P2Full,
        variantRed,
        variantBlue,
        P3,
        P4,
        P5,
        P6
    };
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the cart suite");

    // app.js does not mount the cart router yet (the coordinator adds
    // `app.use("/api/v1", cartRouter);`). For this suite the router is mounted
    // the same way, inserted directly before the not-found handler so every
    // other route keeps behaving exactly as before.
    app.use("/api/v1", cartRouter);
    const stack = app.router.stack;
    const cartLayer = stack.pop();
    stack.splice(stack.length - 2, 0, cartLayer);

    await mongoose.connect(`${base}/vanta_cart_test`);

    server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
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
    ctx = await buildFixtures();
});

// --------------------------------------------------------------------- tests

describe("cart foundation", () => {
    it("1. GET /cart for a fresh user returns an empty view with zero totals", async () => {
        const { token } = ctx.userA;
        const res = await api("GET", "/cart", { token });

        assert.equal(res.status, 200, res.raw);
        const data = res.body.data;

        // Every top-level key the PricedCart contract types against.
        assert.equal(typeof data.cartId, "string");
        assert.equal(data.cartId, `cart_${ctx.userA.user.id}`);
        assert.equal(data.userId, ctx.userA.user.id);
        assert.deepEqual(data.items, []);
        assert.deepEqual(data.groups, []);
        assert.equal(data.subtotal, 0);
        assert.equal(data.shippingTotal, 0);
        assert.equal(data.voucherDiscount, 0);
        assert.equal(data.grandTotal, 0);
        assert.equal(data.itemCount, 0);
        assert.deepEqual(data.delivery, {
            methodId: "standard",
            label: "Standard delivery",
            caption: "Store dispatch with tracking",
            baseFee: 0,
            premiumPerSeller: 0,
            fee: 0,
            sellerCount: 1,
            daysMin: 2,
            daysMax: 5,
            window: "2–5 working days"
        });
        assert.deepEqual(data.checkout, { subtotal: 0, voucherDiscount: 0, deliveryFee: 0, grandTotal: 0 });
        assert.deepEqual(data.vouchers, []);
        assert.equal(data.selectedVoucherCode, null);

        assert.deepEqual(data.issues, []);
        assert.equal(data.cart.items.length, 0);
        assert.equal(data.totals.subtotal, 0);
        assert.equal(data.totals.shippingTotal, 0);
        assert.equal(data.totals.voucherDiscount, 0);
        assert.equal(data.totals.cartTotal, 0);
        assert.equal(data.totals.deliveryFee, 0);
        assert.equal(data.totals.grandTotal, 0);
        assert.equal(data.totals.itemCount, 0);
        assert.equal(data.totals.quote.methodId, "standard");
        assert.equal(data.totals.quote.fee, 0);
    });

    it("2. adds a line selected with a 500 snapshot and merges instead of duplicating", async () => {
        const { token } = ctx.userA;
        const res = await addItem(token, { productId: String(ctx.P1._id), quantity: 2 });

        const data = res.body.data;
        assert.equal(data.cart.items.length, 1);
        const line = data.cart.items[0];
        assert.equal(line.selected, true);
        assert.equal(line.quantity, 2);
        assert.equal(line.priceSnapshot, 500);
        assert.equal(line.productId, String(ctx.P1._id));
        const group = data.groups[0];
        assert.equal(group.storeId, String(ctx.sellerA.store._id));
        assert.equal(typeof group.storeName, "string");
        assert.equal(group.storeName.length > 0, true);
        const priced = group.items[0];
        assert.equal(priced.unitPrice, 500);
        assert.equal(priced.subtotal, 1000);
        assert.equal(priced.name, ctx.P1.name);
        assert.equal(priced.storeId, String(ctx.sellerA.store._id));
        assert.equal(priced.unavailableReason, null);
        assert.deepEqual(data.items.map((entry) => entry.id), [priced.id], "flat items mirror the groups");
        assert.equal(data.totals.subtotal, 1000);
        assert.equal(data.subtotal, 1000);
        assert.equal(data.itemCount, 2);

        const merged = await addItem(token, { productId: String(ctx.P1._id), quantity: 1 });
        const mergedData = merged.body.data;
        assert.equal(mergedData.cart.items.length, 1, "same line merges, not duplicates");
        assert.equal(mergedData.cart.items[0].quantity, 3);
        assert.equal(mergedData.cart.items[0].priceSnapshot, 500, "snapshot stays from first add");
        assert.equal(mergedData.itemCount, 3);
    });

    it("3. rejects a draft product and a product in a paused store with 422", async () => {
        const { token } = ctx.userA;

        const draft = await api("POST", "/cart/items", {
            token,
            body: { productId: String(ctx.P3._id), quantity: 1 }
        });
        assert.equal(draft.status, 422);
        assert.equal(draft.body.error.code, "validation_failed");
        assert.equal(draft.body.error.message, "This item is not available for ordering right now.");

        const paused = await api("POST", "/cart/items", {
            token,
            body: { productId: String(ctx.P4._id), quantity: 1 }
        });
        assert.equal(paused.status, 422);
        assert.equal(paused.body.error.code, "validation_failed");
        assert.equal(paused.body.error.message, "This item is not available for ordering right now.");

        assert.equal((await api("GET", "/cart", { token })).body.data.cart.items.length, 0);
    });

    it("4. a sold-out variant is added (quantity floored to 1) and reported unavailable", async () => {
        const { token } = ctx.userA;
        const res = await addItem(token, {
            productId: String(ctx.P2._id),
            variantId: String(ctx.variantBlue._id),
            quantity: 3
        });

        const data = res.body.data;
        const line = data.cart.items.find((item) => item.variantId === String(ctx.variantBlue._id));
        assert.ok(line, "the sold-out variant line exists");
        assert.equal(line.quantity, 1, "sold-out floor: quantity held at 1");
        assert.equal(line.priceSnapshot, 400);

        const groupLine = data.groups[0].items.find((item) => item.id === line.id);
        assert.equal(groupLine.available, false);
        assert.ok(groupLine.unavailableReason, "an unavailable reason is surfaced");

        const issue = data.issues.find((entry) => entry.itemId === line.id);
        assert.equal(issue.kind, "out_of_stock");
        assert.equal(issue.fix, "remove");
    });

    it("5. clamps an over-stock quantity to stock (or 1 when there is no stock)", async () => {
        const { token } = ctx.userA;
        const res = await addItem(token, { productId: String(ctx.P1._id), quantity: 999 });
        assert.equal(res.body.data.cart.items[0].quantity, 10);

        const out = await addItem(token, { productId: String(ctx.P5._id), quantity: 5 });
        const outLine = out.body.data.cart.items.find((item) => item.productId === String(ctx.P5._id));
        assert.equal(outLine.quantity, 1, "stock 0 line holds quantity 1");
    });

    it("6. an unknown productId is answered with the same 422", async () => {
        const { token } = ctx.userA;
        const res = await api("POST", "/cart/items", {
            token,
            body: { productId: new mongoose.Types.ObjectId().toString() }
        });

        assert.equal(res.status, 422);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "This item is not available for ordering right now.");
    });

    it("7. PATCH clamps quantity to live stock and flips selected without touching quantity", async () => {
        const { token } = ctx.userA;
        const res = await addItem(token, { productId: String(ctx.P1._id), quantity: 2 });
        const itemId = res.body.data.cart.items[0].id;

        const clamped = await api("PATCH", `/cart/items/${itemId}`, { token, body: { quantity: 999 } });
        assert.equal(clamped.status, 200);
        assert.equal(clamped.body.data.cart.items[0].quantity, 10, "clamped to stock");
        assert.equal(clamped.body.data.cart.items[0].selected, true, "quantity patch leaves selection alone");

        const zero = await api("PATCH", `/cart/items/${itemId}`, { token, body: { quantity: 0 } });
        assert.equal(zero.status, 422);
        assert.equal(zero.body.error.code, "validation_failed");
        assert.ok(zero.body.error.fields.find((entry) => entry.field === "quantity"));

        const empty = await api("PATCH", `/cart/items/${itemId}`, { token, body: {} });
        assert.equal(empty.status, 422, "at least one field is required");

        const deselect = await api("PATCH", `/cart/items/${itemId}`, { token, body: { selected: false } });
        assert.equal(deselect.body.data.cart.items[0].selected, false);
        assert.equal(deselect.body.data.cart.items[0].quantity, 10, "selection must not reprice quantity");
    });

    it("8. a foreign user cannot patch or delete another user's item, and sees only its own cart", async () => {
        const { token: tokenA } = ctx.userA;
        const { token: tokenB } = ctx.userB;

        const a = await addItem(tokenA, { productId: String(ctx.P1._id), quantity: 1 });
        const itemId = a.body.data.cart.items[0].id;

        const patch = await api("PATCH", `/cart/items/${itemId}`, { token: tokenB, body: { quantity: 5 } });
        assert.equal(patch.status, 404);
        assert.equal(patch.body.error.code, "not_found");
        assert.equal(patch.body.error.message, "Cart item not found.");

        const del = await api("DELETE", `/cart/items/${itemId}`, { token: tokenB });
        assert.equal(del.status, 404);
        assert.equal(del.body.error.code, "not_found");

        const bView = await api("GET", "/cart", { token: tokenB });
        assert.equal(bView.body.data.cart.items.length, 0, "B's cart is empty");

        const ownDel = await api("DELETE", `/cart/items/${itemId}`, { token: tokenA });
        assert.equal(ownDel.status, 200);
        assert.equal(ownDel.body.data.removed, true);
        assert.equal(ownDel.body.data.cart.items.length, 0);
    });

    it("9. deselecting a line drops it from totals and itemCount but keeps it listed", async () => {
        const { token } = ctx.userA;
        const res = await addItem(token, { productId: String(ctx.P1._id), quantity: 2 });
        const itemId = res.body.data.cart.items[0].id;
        assert.equal(res.body.data.itemCount, 2);
        assert.equal(res.body.data.totals.subtotal, 1000);

        const deselect = await api("PATCH", `/cart/items/${itemId}`, { token, body: { selected: false } });
        const data = deselect.body.data;
        assert.equal(data.itemCount, 0, "itemCount counts selected lines only");
        assert.equal(data.totals.subtotal, 0);
        assert.equal(data.totals.shippingTotal, 0);
        const listed = data.groups[0].items.find((item) => item.id === itemId);
        assert.ok(listed, "the unselected line stays listed in groups");
        assert.equal(listed.selected, false);
        assert.equal(data.groups[0].hasSelectedLines, false);
    });

    it("10. PATCH /cart/select with a sellerId toggles only that seller's lines", async () => {
        const { token } = ctx.userA;
        await addItem(token, { productId: String(ctx.P1._id) }); // seller A
        await addItem(token, { productId: String(ctx.P6._id) }); // seller B

        const scoped = await api("PATCH", "/cart/select", {
            token,
            body: { selected: false, sellerId: String(ctx.sellerA.profile._id) }
        });
        assert.equal(scoped.status, 200);
        const aLines = scoped.body.data.groups.find((g) => g.sellerId === String(ctx.sellerA.profile._id)).items;
        const bLines = scoped.body.data.groups.find((g) => g.sellerId === String(ctx.sellerB.profile._id)).items;
        assert.ok(aLines.every((line) => line.selected === false), "only seller A is deselected");
        assert.ok(bLines.every((line) => line.selected === true), "seller B is untouched");

        const noop = await api("PATCH", "/cart/select", {
            token,
            body: { selected: false, sellerId: new mongoose.Types.ObjectId().toString() }
        });
        assert.equal(noop.status, 200, "a sellerId with no lines is a no-op, not an error");
        assert.equal(noop.body.data.cart.items.some((line) => !line.selected), true);

        const all = await api("PATCH", "/cart/select", { token, body: { selected: true } });
        assert.equal(all.body.data.cart.items.every((line) => line.selected), true);
        assert.equal(all.body.data.itemCount, 2);

        const selector = await api("PATCH", "/cart/select", { token, body: { selected: "yes" } });
        assert.equal(selector.status, 422);
    });

    it("11. multi-seller totals match manual roundMoney computation", async () => {
        const { token } = ctx.userA;
        await addItem(token, { productId: String(ctx.P1._id), quantity: 1 }); // A: 500, fee 60 below 999
        await addItem(token, { productId: String(ctx.P6._id), quantity: 1 }); // B: 700, fee 0

        const res = await api("GET", "/cart", { token });
        const data = res.body.data;
        assert.equal(data.totals.subtotal, 1200);
        assert.equal(data.totals.shippingTotal, 60);
        assert.equal(data.totals.voucherDiscount, 0);
        assert.equal(data.totals.cartTotal, 1260);
        assert.equal(data.totals.deliveryFee, 60, "standard quote is base fees only");
        assert.equal(data.totals.grandTotal, 1260);
        assert.equal(data.totals.itemCount, 2);
        assert.equal(data.itemCount, 2);

        const quote = data.totals.quote;
        assert.equal(quote.methodId, "standard");
        assert.equal(quote.sellerCount, 2);
        assert.equal(quote.premiumPerSeller, 0);
        assert.equal(quote.baseFee, 60);
        assert.equal(quote.fee, 60);
        assert.equal(quote.daysMin, 3, "2 seller standard ships 3-6 working days");
        assert.equal(quote.daysMax, 6);

        const groupA = data.groups.find((g) => g.sellerId === String(ctx.sellerA.profile._id));
        assert.equal(groupA.subtotal, 500);
        assert.equal(groupA.shippingFee, 60);
        assert.equal(groupA.freeShipping, false);
        const groupB = data.groups.find((g) => g.sellerId === String(ctx.sellerB.profile._id));
        assert.equal(groupB.subtotal, 700);
        assert.equal(groupB.shippingFee, 0);
        assert.equal(groupB.freeShipping, true);
    });

    it("12. an express deliveryMethod query adds the 40-per-seller premium", async () => {
        const { token } = ctx.userA;
        await addItem(token, { productId: String(ctx.P1._id), quantity: 1 });

        const res = await api("GET", "/cart?deliveryMethod=express", { token });
        const data = res.body.data;
        assert.equal(data.totals.deliveryFee, 100, "base 60 + 40 per seller");
        const quote = data.totals.quote;
        assert.equal(quote.methodId, "express");
        assert.equal(quote.label, "Express delivery");
        assert.equal(quote.premiumPerSeller, 40);
        assert.equal(quote.sellerCount, 1);
        assert.equal(quote.baseFee, 60);
        assert.equal(quote.window, "1–2 working days");
        assert.equal(quote.daysMin, 1);
        assert.equal(quote.daysMax, 2);

        const unknown = await api("GET", "/cart?deliveryMethod=drone", { token });
        assert.equal(unknown.body.data.totals.quote.methodId, "standard", "invalid methods fall back to standard");
    });

    it("13. a price drop is reported as price_changed and repriced live", async () => {
        const { token, user } = ctx.userA;
        await Cart.create({
            userId: user.id,
            items: [
                { productId: ctx.P1._id, sellerId: ctx.sellerA.profile._id, quantity: 2, selected: true, priceSnapshot: 500 }
            ]
        });
        await Product.updateOne({ _id: ctx.P1._id }, { $set: { regularPrice: 450 } });

        const res = await api("GET", "/cart", { token });
        const data = res.body.data;

        const issue = data.issues.find((entry) => entry.kind === "price_changed");
        assert.ok(issue, "a price_changed issue is emitted");
        assert.equal(issue.productId, String(ctx.P1._id));
        assert.equal(issue.previousPrice, 500);
        assert.equal(issue.currentPrice, 450);
        assert.equal(issue.fix, "review");

        const line = data.groups[0].items[0];
        assert.equal(line.unitPrice, 450, "prices come from the live catalog, not the snapshot");
        assert.equal(line.priceChanged, true);
        assert.equal(line.subtotal, 900);
        assert.equal(data.totals.subtotal, 900);
    });

    it("14. a stock drop below the line quantity is reported as reduced with a suggestion", async () => {
        const { token, user } = ctx.userA;
        await Cart.create({
            userId: user.id,
            items: [
                { productId: ctx.P1._id, sellerId: ctx.sellerA.profile._id, quantity: 8, selected: true, priceSnapshot: 500 }
            ]
        });
        await Product.updateOne({ _id: ctx.P1._id }, { $set: { stock: 3 } });

        const res = await api("GET", "/cart", { token });
        const data = res.body.data;

        const issue = data.issues.find((entry) => entry.kind === "reduced");
        assert.ok(issue, "a reduced issue is emitted");
        assert.equal(issue.suggestedQuantity, 3);
        assert.equal(issue.fix, "reduce");
        assert.ok(!data.issues.find((entry) => entry.kind === "out_of_stock"), "stock > 0 is reduced, not out_of_stock");
        assert.equal(data.groups[0].items[0].available, false);
        assert.equal(data.groups[0].items[0].quantity, 8, "the stored line itself is not silently rewritten");
    });

    it("15. clearing the cart empties it (and stays a no-op when absent)", async () => {
        const { token } = ctx.userA;
        await addItem(token, { productId: String(ctx.P1._id), quantity: 2 });

        const res = await api("DELETE", "/cart/items", { token });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.cart.items.length, 0);
        assert.equal(res.body.data.itemCount, 0);
        assert.deepEqual(res.body.data.groups, []);

        const again = await api("DELETE", "/cart/items", { token });
        assert.equal(again.status, 200);
        assert.equal(again.body.data.itemCount, 0);
    });

    it("a voucher that is active and inside its window is honoured in the view", async () => {
        const { token } = ctx.userA;
        await addItem(token, { productId: String(ctx.P1._id), quantity: 2 }); // subtotal 1000 -> free shipping over 999

        await Voucher.create({
            code: "SAVE10",
            title: "10 off",
            type: "fixed",
            discountValue: 10,
            minimumOrder: 0,
            scope: "platform",
            startAt: new Date(Date.now() - 60_000),
            expiry: new Date(Date.now() + 60_000),
            active: true
        });

        const res = await api("GET", "/cart?voucher=save10", { token });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.totals.shippingTotal, 0, "subtotal 1000 clears the 999 free-shipping threshold");
        assert.equal(res.body.data.totals.voucherDiscount, 10);
        assert.equal(res.body.data.totals.cartTotal, 990);

        const bogus = await api("GET", "/cart?voucher=nope", { token });
        assert.equal(bogus.body.data.totals.voucherDiscount, 0, "an unknown code is silently ignored");

        const expired = await Voucher.findOne({ code: "SAVE10" });
        expired.expiry = new Date(Date.now() - 1000);
        await expired.save();
        const stale = await api("GET", "/cart?voucher=save10", { token });
        assert.equal(stale.body.data.totals.voucherDiscount, 0, "an exhausted-window code is ignored");
    });
});