/**
 * Recently-viewed foundation suite (M13).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_recent_test` database, so every assertion is about what a client
 * would actually observe: status, envelope, error code, and the
 * `{ productId, addedAt, available, product }` entry shape.
 *
 * Run: node --test src/tests/recently-viewed.test.js
 *
 * The suite drops `vanta_recent_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import recentlyViewedRouter from "../routes/recently-viewed.route.js";
import { Category } from "../models/category.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";
import { RecentlyViewed } from "../models/recently-viewed.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let ctx;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `recent-${label}-${++sequence}-${Date.now()}@example.com`;

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

/** Record a view and assert the endpoint accepted it (201 + entry echo). */
const record = async (token, product) => {
    const response = await api("POST", "/recently-viewed", {
        token,
        body: { productId: String(product._id ?? product) }
    });
    assert.equal(response.status, 201, response.raw);
    return response;
};

const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const listedIds = (res) => res.body.data.items.map((entry) => entry.productId);

// Seller/store/product fixtures — created DIRECTLY via models, as spec'd.
const buildFixtures = async () => {
    const userA = await registerUser("A");
    const userB = await registerUser("B");

    const category = await Category.create({ name: "Fixtures" });

    const profile = await SellerProfile.create({
        userId: new mongoose.Types.ObjectId(),
        fullName: "Seller One",
        phone: `017${String(sequence).padStart(8, "0")}`,
        email: uniqueEmail("seller-one"),
        nationalId: `NID-RV-${Date.now()}`,
        sellerType: "individual",
        storeName: "Store One",
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
        name: "Store One",
        logo: "logo-1",
        status: "active",
        shippingFee: 60,
        freeShippingThreshold: 999,
        deliveryEstimateDays: { min: 2, max: 4 }
    });

    const makeProduct = async (overrides = {}) =>
        Product.create({
            categoryId: category._id,
            sellerId: profile._id,
            storeId: store._id,
            regularPrice: 100,
            sku: `SKU-RV-${++sequence}`,
            status: "active",
            stock: 10,
            ...overrides
        });

    const P1 = await makeProduct({ name: "Widget One", sku: "SKU-RV1", regularPrice: 500, images: ["p1.png"] });
    const P2 = await makeProduct({ name: "Widget Two", sku: "SKU-RV2", regularPrice: 250 });
    const P3 = await makeProduct({ name: "Widget Three", sku: "SKU-RV3", regularPrice: 300 });

    return { userA, userB, profile, store, category, makeProduct, P1, P2, P3 };
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the recently-viewed suite");

    // app.js does not mount the recently-viewed router yet (the coordinator
    // adds `app.use("/api/v1", recentlyViewedRouter);`). For this suite the
    // router is mounted the same way cart/wishlist mount theirs: inserted
    // directly before the not-found handler so every other route keeps
    // behaving as before.
    app.use("/api/v1", recentlyViewedRouter);
    const stack = app.router.stack;
    const layer = stack.pop();
    stack.splice(stack.length - 2, 0, layer);

    await mongoose.connect(`${base}/vanta_recent_test`);

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

describe("recently-viewed foundation", () => {
    it("1. POST records the entry, bumps viewCount by exactly 1, and scopes the row to the caller", async () => {
        const { token, user } = ctx.userA;

        const before = await Product.findById(ctx.P1._id);
        const res = await record(token, ctx.P1);

        const entry = res.body.data.entry;
        assert.equal(entry.productId, String(ctx.P1._id));
        assert.equal(typeof entry.addedAt, "string");
        assert.ok(!Number.isNaN(Date.parse(entry.addedAt)), "addedAt is an ISO date");

        const after = await Product.findById(ctx.P1._id);
        assert.equal((after.viewCount ?? 0), (before.viewCount ?? 0) + 1, "viewCount moved by exactly 1");

        const row = await RecentlyViewed.findOne({ userId: user.id, productId: ctx.P1._id });
        assert.ok(row, "the caller's row exists");
        assert.equal(String(row.userId), user.id);
    });

    it("2. re-recording moves the row to the newest position and never duplicates it", async () => {
        const { token, user } = ctx.userA;

        await record(token, ctx.P1);
        await pause();
        await record(token, ctx.P2);
        await pause();
        const again = await record(token, ctx.P1);

        const rows = await RecentlyViewed.find({ userId: user.id });
        assert.equal(rows.length, 2, "the unique (userId, productId) index keeps one row per product");
        assert.equal(
            (await Product.findById(ctx.P1._id)).viewCount,
            2,
            "each POST still bumps viewCount"
        );

        const res = await api("GET", "/recently-viewed", { token });
        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(listedIds(res), [String(ctx.P1._id), String(ctx.P2._id)], "re-viewed product moved to newest");
        assert.ok(
            new Date(res.body.data.items[0].addedAt).getTime() > new Date(res.body.data.items[1].addedAt).getTime(),
            "addedAt is strictly newer after the re-view"
        );
        assert.equal(again.body.data.entry.productId, String(ctx.P1._id));
    });

    it("3. GET defaults to 12, honours an explicit limit, rejects a bad limit, and never bumps viewCount", async () => {
        const { token } = ctx.userA;

        const extras = [];
        for (let i = 0; i < 13; i++) {
            const product = await ctx.makeProduct({ name: `Extra ${i}` });
            extras.push(product);
            await record(token, product);
            await pause();
        }

        const fallback = await api("GET", "/recently-viewed", { token });
        assert.equal(fallback.status, 200, fallback.raw);
        assert.equal(fallback.body.data.items.length, 12, "default limit is 12");
        assert.equal(fallback.body.data.items[0].productId, String(extras[12]._id), "newest first");

        const viewCountBefore = (await Product.findById(extras[12]._id)).viewCount;
        await api("GET", "/recently-viewed", { token });
        const viewCountAfter = (await Product.findById(extras[12]._id)).viewCount;
        assert.equal(viewCountAfter, viewCountBefore, "reads never bump viewCount");

        const limited = await api("GET", "/recently-viewed?limit=5", { token });
        assert.equal(limited.status, 200, limited.raw);
        assert.equal(limited.body.data.items.length, 5, "explicit limit is honoured");

        for (const bad of ["0", "101", "abc", "-3"]) {
            const res = await api("GET", `/recently-viewed?limit=${bad}`, { token });
            assert.equal(res.status, 422, `limit=${bad} is rejected`);
            assert.equal(res.body.error.code, "validation_failed");
            assert.ok(res.body.error.fields.find((entry) => entry.field === "limit"), "the field is named limit");
        }
    });

    it("4. the list is newest-first with the full entry shape, and a product turned draft disappears", async () => {
        const { token } = ctx.userA;

        await record(token, ctx.P1);
        await pause();
        await record(token, ctx.P3);

        const before = await api("GET", "/recently-viewed", { token });
        assert.equal(before.status, 200, before.raw);
        assert.deepEqual(listedIds(before), [String(ctx.P3._id), String(ctx.P1._id)], "newest first");

        const item = before.body.data.items[0];
        assert.deepEqual(Object.keys(item).sort(), ["addedAt", "available", "product", "productId"]);
        assert.equal(item.available, true, "an active product with stock is available");
        assert.equal(typeof item.product.id, "string");
        assert.equal(item.product.id, item.productId);
        assert.equal(item.product._id, undefined, "no raw _id leaks");
        assert.equal(typeof item.product.viewCount, "number");

        await Product.updateOne({ _id: ctx.P3._id }, { $set: { status: "draft" } });

        const after = await api("GET", "/recently-viewed", { token });
        assert.equal(after.status, 200, after.raw);
        assert.deepEqual(listedIds(after), [String(ctx.P1._id)], "the draft product is filtered out");
    });

    it("5. rows whose product document is gone are dropped, but the rows themselves are not pruned", async () => {
        const { token, user } = ctx.userA;

        await record(token, ctx.P1);
        await pause();
        await record(token, ctx.P2);
        await Product.deleteOne({ _id: ctx.P2._id });

        const res = await api("GET", "/recently-viewed", { token });
        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(listedIds(res), [String(ctx.P1._id)], "the missing product is filtered out");

        const rows = await RecentlyViewed.find({ userId: user.id });
        assert.equal(rows.length, 2, "reads never rewrite the user's history");
    });

    it("6. DELETE removes the caller's row and stays a 200 { removed: false } afterwards", async () => {
        const { token, user } = ctx.userA;
        await record(token, ctx.P1);

        const removed = await api("DELETE", `/recently-viewed/products/${ctx.P1._id}`, { token });
        assert.equal(removed.status, 200, removed.raw);
        assert.equal(removed.body.data.removed, true);
        assert.equal(await RecentlyViewed.countDocuments({ userId: user.id }), 0, "the row is gone");

        const list = await api("GET", "/recently-viewed", { token });
        assert.deepEqual(listedIds(list), [], "the list is empty again");

        const again = await api("DELETE", `/recently-viewed/products/${ctx.P1._id}`, { token });
        assert.equal(again.status, 200, "a repeat delete is still a 200");
        assert.equal(again.body.data.removed, false);
    });

    it("7. another user's delete cannot touch A's history", async () => {
        const { token: tokenA } = ctx.userA;
        const { token: tokenB } = ctx.userB;

        await record(tokenA, ctx.P1);

        const foreign = await api("DELETE", `/recently-viewed/products/${ctx.P1._id}`, { token: tokenB });
        assert.equal(foreign.status, 200, "B's delete is scoped to B and simply matches nothing");
        assert.equal(foreign.body.data.removed, false);

        const listA = await api("GET", "/recently-viewed", { token: tokenA });
        assert.deepEqual(listedIds(listA), [String(ctx.P1._id)], "A's history is untouched");

        const listB = await api("GET", "/recently-viewed", { token: tokenB });
        assert.deepEqual(listedIds(listB), [], "B never recorded anything");
    });

    it("8. malformed and unknown productIds are 422s (body, path, and Product not found)", async () => {
        const { token, user } = ctx.userA;

        const malformedBody = await api("POST", "/recently-viewed", { token, body: { productId: "not-an-id" } });
        assert.equal(malformedBody.status, 422);
        assert.equal(malformedBody.body.error.code, "validation_failed");
        assert.ok(malformedBody.body.error.fields.find((entry) => entry.field === "productId"));

        const unknown = await api("POST", "/recently-viewed", {
            token,
            body: { productId: new mongoose.Types.ObjectId().toString() }
        });
        assert.equal(unknown.status, 422);
        assert.equal(unknown.body.error.code, "validation_failed");
        assert.equal(unknown.body.error.message, "Product not found.");
        assert.equal(await RecentlyViewed.countDocuments({}), 0, "a rejected view records nothing");
        assert.equal((await Product.findById(ctx.P1._id)).viewCount, 0, "and bumps nothing");

        const malformedPath = await api("DELETE", "/recently-viewed/products/not-an-id", { token });
        assert.equal(malformedPath.status, 422);
        assert.equal(malformedPath.body.error.code, "validation_failed");
        assert.ok(malformedPath.body.error.fields.find((entry) => entry.field === "productId"));
        assert.equal(await RecentlyViewed.countDocuments({ userId: user.id }), 0);
    });

    it("9. unauthenticated requests are 401 on every route", async () => {
        const post = await api("POST", "/recently-viewed", { body: { productId: String(ctx.P1._id) } });
        assert.equal(post.status, 401);
        assert.equal(post.body.error.code, "unauthorized");

        const get = await api("GET", "/recently-viewed");
        assert.equal(get.status, 401);
        assert.equal(get.body.error.code, "unauthorized");

        const del = await api("DELETE", `/recently-viewed/products/${ctx.P1._id}`);
        assert.equal(del.status, 401);
        assert.equal(del.body.error.code, "unauthorized");
    });

    it("10. a client-supplied userId (or any extra key) is a 422 field error", async () => {
        const { token, user } = ctx.userA;

        const injected = await api("POST", "/recently-viewed", {
            token,
            body: { productId: String(ctx.P1._id), userId: user.id }
        });
        assert.equal(injected.status, 422);
        assert.equal(injected.body.error.code, "validation_failed");
        assert.ok(injected.body.error.fields.find((entry) => entry.field === "userId"));

        const extra = await api("POST", "/recently-viewed", {
            token,
            body: { productId: String(ctx.P1._id), addedAt: "2020-01-01T00:00:00.000Z" }
        });
        assert.equal(extra.status, 422);
        assert.ok(extra.body.error.fields.find((entry) => entry.field === "addedAt"));

        assert.equal(await RecentlyViewed.countDocuments({}), 0, "a rejected view records nothing");
        assert.equal((await Product.findById(ctx.P1._id)).viewCount, 0, "and bumps nothing");
    });
});
