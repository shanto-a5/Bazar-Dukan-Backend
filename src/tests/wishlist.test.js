/**
 * Wishlist foundation suite (M13).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_wishlist_test` database, so every assertion is about what a client
 * would actually observe: status, envelope, error code and the `{ items }`
 * list shape.
 *
 * Run: node --test src/tests/wishlist.test.js
 *
 * The suite drops `vanta_wishlist_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import wishlistRouter from "../routes/wishlist.route.js";
import { Category } from "../models/category.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";
import { Wishlist } from "../models/wishlist.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let ctx;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `wish-${label}-${++sequence}-${Date.now()}@example.com`;

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

const addItem = async (token, productId) => {
    const response = await api("POST", "/wishlist/items", { token, body: { productId: String(productId) } });
    assert.equal(response.status, 201, response.raw);
    return response;
};

const getIds = (items) => items.map((entry) => entry.productId);

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
        nationalId: `NID-1-${Date.now()}`,
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
        sellerId: profile._id,
        storeId: store._id,
        name: "Widget One",
        sku: "SKU-W1",
        regularPrice: 500,
        status: "active",
        stock: 10,
        images: ["p1.png"]
    });

    const P2 = await makeProduct({
        sellerId: profile._id,
        storeId: store._id,
        name: "Widget Two",
        sku: "SKU-W2",
        regularPrice: 250,
        status: "active",
        stock: 5
    });

    const PDRAFT = await makeProduct({
        sellerId: profile._id,
        storeId: store._id,
        name: "Draft Widget",
        sku: "SKU-WD",
        regularPrice: 200,
        status: "draft",
        stock: 5
    });

    return { userA, userB, profile, store, category, P1, P2, PDRAFT };
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the wishlist suite");

    // app.js does not mount the wishlist router yet (the coordinator adds
    // `app.use("/api/v1", wishlistRouter);`). For this suite the router is
    // mounted the same way cart.test.js mounts its router, inserted directly
    // before the not-found handler so every other route keeps behaving.
    app.use("/api/v1", wishlistRouter);
    const stack = app.router.stack;
    const wishlistLayer = stack.pop();
    stack.splice(stack.length - 2, 0, wishlistLayer);

    await mongoose.connect(`${base}/vanta_wishlist_test`);

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

describe("wishlist foundation", () => {
    it("1. GET /wishlist for a fresh user returns an empty list", async () => {
        const { token } = ctx.userA;
        const res = await api("GET", "/wishlist", { token });

        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(res.body.data.items, []);
    });

    it("2. adding returns the full list newest-first with a public product DTO", async () => {
        const { token } = ctx.userA;

        const first = await addItem(token, ctx.P1._id);
        assert.equal(first.body.data.items.length, 1);
        assert.equal(first.body.data.items[0].productId, String(ctx.P1._id));

        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await addItem(token, ctx.P2._id);
        assert.equal(second.status, 201);
        assert.equal(second.body.data.items.length, 2);

        const res = await api("GET", "/wishlist", { token });
        assert.equal(res.status, 200, res.raw);
        const items = res.body.data.items;
        assert.deepEqual(getIds(items), [String(ctx.P2._id), String(ctx.P1._id)], "newest first");
        assert.ok(
            new Date(items[0].addedAt).getTime() > new Date(items[1].addedAt).getTime(),
            "addedAt is ISO and ordered"
        );

        for (const entry of items) {
            assert.equal(entry.available, true);
            assert.equal(typeof entry.product.id, "string");
            assert.equal(entry.product.id, entry.productId);
            assert.equal(typeof entry.product.createdAt, "string");
            assert.equal(typeof entry.product.updatedAt, "string");
            assert.equal(entry.product._id, undefined, "no raw _id leaks");
        }
    });

    it("3. a draft product stays listed with available:false", async () => {
        const { token } = ctx.userA;
        await addItem(token, ctx.PDRAFT._id);

        const res = await api("GET", "/wishlist", { token });
        assert.equal(res.status, 200, res.raw);
        assert.equal(res.body.data.items.length, 1);
        const entry = res.body.data.items[0];
        assert.equal(entry.productId, String(ctx.PDRAFT._id));
        assert.equal(entry.available, false, "draft is not available");
        assert.equal(entry.product.status, "draft");
    });

    it("4. adding the same product twice is a silent no-op (one item)", async () => {
        const { token } = ctx.userA;
        await addItem(token, ctx.P1._id);
        const again = await addItem(token, ctx.P1._id);

        assert.equal(again.status, 201);
        assert.equal(again.body.data.items.length, 1, "duplicate add does not duplicate");
        assert.equal(again.body.data.items[0].productId, String(ctx.P1._id));
    });

    it("5. an unknown-but-valid productId is a 422 Product not found", async () => {
        const { token } = ctx.userA;
        const res = await api("POST", "/wishlist/items", {
            token,
            body: { productId: new mongoose.Types.ObjectId().toString() }
        });

        assert.equal(res.status, 422);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "Product not found.");
    });

    it("6. a malformed productId is a 422 field error on body and path", async () => {
        const { token } = ctx.userA;

        const body = await api("POST", "/wishlist/items", { token, body: { productId: "not-an-id" } });
        assert.equal(body.status, 422);
        assert.equal(body.body.error.code, "validation_failed");
        assert.ok(body.body.error.fields.find((entry) => entry.field === "productId"));

        const path = await api("DELETE", "/wishlist/items/not-an-id", { token });
        assert.equal(path.status, 422);
        assert.equal(path.body.error.code, "validation_failed");
        assert.ok(path.body.error.fields.find((entry) => entry.field === "productId"));
    });

    it("7. remove drops the item and is a 200 no-op when the product is absent", async () => {
        const { token } = ctx.userA;
        await addItem(token, ctx.P1._id);
        await addItem(token, ctx.P2._id);

        const removed = await api("DELETE", `/wishlist/items/${ctx.P1._id}`, { token });
        assert.equal(removed.status, 200);
        assert.deepEqual(getIds(removed.body.data.items), [String(ctx.P2._id)]);

        const absent = await api("DELETE", `/wishlist/items/${ctx.P1._id}`, { token });
        assert.equal(absent.status, 200, "absent product is still a 200 no-op");
        assert.deepEqual(getIds(absent.body.data.items), [String(ctx.P2._id)]);

        const unknown = await api("DELETE", `/wishlist/items/${new mongoose.Types.ObjectId()}`, { token });
        assert.equal(unknown.status, 200, "a never-watched product is also a no-op");
        assert.deepEqual(getIds(unknown.body.data.items), [String(ctx.P2._id)]);
    });

    it("8. clear empties the list and stays a 200 no-op when empty", async () => {
        const { token } = ctx.userA;
        await addItem(token, ctx.P1._id);

        const cleared = await api("DELETE", "/wishlist", { token });
        assert.equal(cleared.status, 200);
        assert.deepEqual(cleared.body.data.items, []);

        const again = await api("DELETE", "/wishlist", { token });
        assert.equal(again.status, 200);
        assert.deepEqual(again.body.data.items, []);
    });

    it("9. prune drops the row for a deleted product and persists the pruned list", async () => {
        const { token } = ctx.userA;
        await addItem(token, ctx.P1._id);
        await addItem(token, ctx.P2._id);

        await Product.deleteOne({ _id: ctx.P2._id });

        const res = await api("GET", "/wishlist", { token });
        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(getIds(res.body.data.items), [String(ctx.P1._id)], "missing product is pruned away");

        const stored = await Wishlist.findOne({});
        assert.equal(stored.items.length, 1, "prune persisted to the document");

        const again = await api("GET", "/wishlist", { token });
        assert.deepEqual(getIds(again.body.data.items), [String(ctx.P1._id)], "already pruned stays pruned");
    });

    it("10. two users are fully isolated", async () => {
        const { token: tokenA } = ctx.userA;
        const { token: tokenB } = ctx.userB;

        await addItem(tokenA, ctx.P1._id);

        const bFresh = await api("GET", "/wishlist", { token: tokenB });
        assert.deepEqual(bFresh.body.data.items, [], "B's list is empty");

        await addItem(tokenB, ctx.P2._id);

        const aList = await api("GET", "/wishlist", { token: tokenA });
        assert.deepEqual(getIds(aList.body.data.items), [String(ctx.P1._id)], "A sees only A's list");

        const bMutatesForeign = await api("DELETE", `/wishlist/items/${ctx.P1._id}`, { token: tokenB });
        assert.equal(bMutatesForeign.status, 200, "B removing a product A added is a no-op, not an error");
        assert.deepEqual(getIds(bMutatesForeign.body.data.items), [String(ctx.P2._id)]);

        const aAfter = await api("GET", "/wishlist", { token: tokenA });
        assert.deepEqual(getIds(aAfter.body.data.items), [String(ctx.P1._id)], "A's list is untouched");
    });

    it("11. a client-supplied userId (or any extra key) is a 422 field error", async () => {
        const { token } = ctx.userA;
        const res = await api("POST", "/wishlist/items", {
            token,
            body: { productId: String(ctx.P1._id), userId: ctx.userA.user.id }
        });

        assert.equal(res.status, 422);
        assert.equal(res.body.error.code, "validation_failed");
        assert.ok(res.body.error.fields.find((entry) => entry.field === "userId"));

        const extra = await api("POST", "/wishlist/items", {
            token,
            body: { productId: String(ctx.P1._id), quantity: 2 }
        });
        assert.equal(extra.status, 422);
        assert.ok(extra.body.error.fields.find((entry) => entry.field === "quantity"));
    });

    it("12. unauthenticated requests are 401", async () => {
        const get = await api("GET", "/wishlist");
        assert.equal(get.status, 401);
        assert.equal(get.body.error.code, "unauthorized");

        const post = await api("POST", "/wishlist/items", { body: { productId: String(ctx.P1._id) } });
        assert.equal(post.status, 401);
        assert.equal(post.body.error.code, "unauthorized");

        const del = await api("DELETE", `/wishlist/items/${ctx.P1._id}`);
        assert.equal(del.status, 401);

        const clear = await api("DELETE", "/wishlist");
        assert.equal(clear.status, 401);
    });
});