/**
 * Public browse + meta suite (M12).
 *
 * Seven unauthenticated endpoints over the real Express app, on an ephemeral
 * port against a dedicated `vanta_browse_test` database, so every assertion is
 * about what a client actually observes: status, envelope, error code and the
 * payload shape. Not one request in this file carries an `Authorization`
 * header — a browse is what an anonymous visitor does, and if any of these
 * needed a session the suite would fail loudly.
 *
 * Run: node --test src/tests/browse.test.js
 *
 * The suite drops `vanta_browse_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import catalogRouter from "../routes/catalog.route.js";
import metaRouter from "../routes/meta.route.js";
import { Category } from "../models/category.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let ctx;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `browse-${label}-${++sequence}-${Date.now()}@example.com`;

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

/** The success envelope, asserted by every 200 below. */
const assertOk = (res, message) => {
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.meta.message, message);
};

const names = (items) => items.map((item) => item.name);

/** The exact field set `toProductDto` promises — nothing added, nothing lost. */
const PRODUCT_DTO_KEYS = [
    "id",
    "sellerId",
    "storeId",
    "name",
    "brand",
    "categoryId",
    "subcategoryId",
    "description",
    "highlights",
    "images",
    "video",
    "regularPrice",
    "salePrice",
    "costPrice",
    "sku",
    "stock",
    "lowStockThreshold",
    "hasVariants",
    "variants",
    "status",
    "publishedAt",
    "ratingAvg",
    "ratingCount",
    "soldCount",
    "viewCount",
    "isNewArrival",
    "createdAt",
    "updatedAt"
];

// ------------------------------------------------------------------ fixtures

/**
 * Two visible stores, one paused store, one seller awaiting review and one
 * suspended seller; six visible products across two category trees (one on
 * sale, one low on stock, one active-but-zero-stock, one variant product) and
 * six rows that must never reach a buyer (draft, paused, paused store, pending
 * seller, suspended seller, derived `out_of_stock` status).
 */
const buildFixtures = async () => {
    const electronics = await Category.create({ name: "Electronics", order: 1 });
    const audio = await Category.create({ name: "Audio", parentId: electronics._id, order: 1 });
    const home = await Category.create({ name: "Home", order: 2 });
    const kitchen = await Category.create({ name: "Kitchen", parentId: home._id, order: 1 });

    const makeSeller = async (label, { profileStatus = "active", storeStatus = "active" } = {}) => {
        const profile = await SellerProfile.create({
            userId: new mongoose.Types.ObjectId(),
            fullName: `Seller ${label}`,
            phone: `017${String(sequence + 1).padStart(8, "0")}`,
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
            status: profileStatus
        });
        const store = await Store.create({
            sellerId: profile._id,
            name: `Store ${label}`,
            status: storeStatus,
            shippingFee: 60,
            freeShippingThreshold: 999,
            deliveryEstimateDays: { min: 2, max: 4 }
        });
        return { profile, store };
    };

    const sellerA = await makeSeller("A");
    const sellerB = await makeSeller("B");
    const sellerC = await makeSeller("C", { storeStatus: "paused" });
    const sellerD = await makeSeller("D", { profileStatus: "pending" });
    const sellerE = await makeSeller("E", { profileStatus: "suspended" });

    const makeProduct = (overrides) =>
        Product.create({
            categoryId: electronics._id,
            regularPrice: 100,
            sku: `SKU-B${++sequence}`,
            status: "active",
            stock: 0,
            ...overrides
        });

    // --- visible
    const P1 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Noise-Cancelling Headphones",
        brand: "Aurora",
        categoryId: electronics._id,
        subcategoryId: audio._id,
        description: "Over-ear headphones with active noise cancelling",
        sku: "SKU-P1",
        regularPrice: 8000,
        salePrice: 7200,
        costPrice: 4000,
        stock: 12,
        images: ["p1.png"],
        ratingAvg: 4.5,
        ratingCount: 12,
        soldCount: 30,
        viewCount: 400
    });

    const P2 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Wireless Earbuds",
        brand: "Aurora",
        categoryId: electronics._id,
        subcategoryId: audio._id,
        sku: "SKU-P2",
        regularPrice: 2500,
        stock: 3,
        lowStockThreshold: 5,
        ratingAvg: 4,
        ratingCount: 6,
        soldCount: 12,
        viewCount: 90
    });

    const P3 = await makeProduct({
        sellerId: sellerB.profile._id,
        storeId: sellerB.store._id,
        name: "Studio Monitor Headphones",
        brand: "Beacon",
        categoryId: electronics._id,
        sku: "SKU-P3",
        regularPrice: 5000,
        stock: 10,
        ratingAvg: 4.2,
        ratingCount: 8,
        soldCount: 20,
        viewCount: 150
    });

    const P4 = await makeProduct({
        sellerId: sellerB.profile._id,
        storeId: sellerB.store._id,
        name: "Desk Lamp",
        brand: "Beacon",
        categoryId: home._id,
        sku: "SKU-P4",
        regularPrice: 1500,
        stock: 20,
        ratingAvg: 3.5,
        ratingCount: 4,
        soldCount: 9,
        viewCount: 60
    });

    const P5 = await makeProduct({
        sellerId: sellerB.profile._id,
        storeId: sellerB.store._id,
        name: "Ceramic Mug",
        brand: "Hearth",
        categoryId: home._id,
        subcategoryId: kitchen._id,
        sku: "SKU-P5",
        regularPrice: 600,
        stock: 0
    });

    const P6 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Yoga Mat",
        brand: "Aurora",
        categoryId: home._id,
        sku: "SKU-P6",
        regularPrice: 1200,
        stock: 12,
        hasVariants: true,
        variants: [
            { sku: "P6-V1", attributes: { Size: "S" }, price: 1200, stock: 4 },
            { sku: "P6-V2", attributes: { Size: "M" }, price: 1300, stock: 4 },
            { sku: "P6-V3", attributes: { Size: "L" }, price: 1400, stock: 4 }
        ]
    });

    // --- hidden: draft, paused, paused store, pending seller, suspended seller
    const P7 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Draft Camera",
        brand: "Aurora",
        categoryId: electronics._id,
        sku: "SKU-P7",
        regularPrice: 900,
        status: "draft",
        stock: 5
    });

    const P8 = await makeProduct({
        sellerId: sellerB.profile._id,
        storeId: sellerB.store._id,
        name: "Paused Toaster",
        brand: "Beacon",
        categoryId: home._id,
        sku: "SKU-P8",
        regularPrice: 700,
        status: "paused",
        stock: 5
    });

    const P9 = await makeProduct({
        sellerId: sellerC.profile._id,
        storeId: sellerC.store._id,
        name: "Cinder Gadget",
        brand: "Cinder",
        categoryId: electronics._id,
        sku: "SKU-P9",
        regularPrice: 1100,
        status: "active",
        stock: 5
    });

    const P10 = await makeProduct({
        sellerId: sellerD.profile._id,
        storeId: sellerD.store._id,
        name: "Drift Widget",
        brand: "Drift",
        categoryId: home._id,
        sku: "SKU-P10",
        regularPrice: 1300,
        status: "active",
        stock: 5
    });

    const P11 = await makeProduct({
        sellerId: sellerE.profile._id,
        storeId: sellerE.store._id,
        name: "Echo Widget",
        brand: "Echo",
        categoryId: home._id,
        sku: "SKU-P11",
        regularPrice: 1700,
        status: "active",
        stock: 5
    });

    // Derived status: the status itself hides it, whatever the balance says.
    const P12 = await makeProduct({
        sellerId: sellerA.profile._id,
        storeId: sellerA.store._id,
        name: "Legacy Amplifier",
        brand: "Aurora",
        categoryId: electronics._id,
        sku: "SKU-P12",
        regularPrice: 3000,
        status: "out_of_stock",
        stock: 0
    });

    return {
        categories: { electronics, audio, home, kitchen },
        sellerA,
        sellerB,
        sellerC,
        sellerD,
        sellerE,
        P1,
        P2,
        P3,
        P4,
        P5,
        P6,
        P7,
        P8,
        P9,
        P10,
        P11,
        P12
    };
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the browse suite");

    // app.js does not mount these routers yet (the coordinator adds
    // `app.use("/api/v1", catalogRouter);` and `app.use("/api/v1", metaRouter);`).
    // For this suite both are mounted the same way, inserted directly before
    // the not-found handler so every other route keeps behaving as before.
    app.use("/api/v1", catalogRouter);
    app.use("/api/v1", metaRouter);
    const stack = app.router.stack;
    const metaLayer = stack.pop();
    const catalogLayer = stack.pop();
    stack.splice(stack.length - 2, 0, catalogLayer, metaLayer);

    await mongoose.connect(`${base}/vanta_browse_test`);

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

describe("public browse", () => {
    it("1. the list serves only customer-visible rows, in both reading dialects", async () => {
        const res = await api("GET", "/catalog/products");
        assertOk(res, "Products.");

        const data = res.body.data;
        assert.equal(data.total, 6, "six visible products; every hidden row is out");
        assert.equal(data.items.length, 6);
        assert.equal(data.page, 1);
        assert.equal(data.pageSize, 20, "default page size is 20");
        assert.equal(data.limit, 20);
        assert.equal(data.offset, 0);

        // `items`/`total`/`page`/`pageSize` (vanta-api) and `products`/`total`/
        // `limit`/`offset` (the documented shape) carry the same rows.
        assert.deepEqual(data.items, data.products);

        const listed = new Set(data.items.map((item) => item.id));
        for (const hidden of [ctx.P7, ctx.P8, ctx.P9, ctx.P10, ctx.P11, ctx.P12]) {
            assert.equal(listed.has(String(hidden._id)), false, `${hidden.name} must not be listed`);
        }
        for (const shown of [ctx.P1, ctx.P2, ctx.P3, ctx.P4, ctx.P5, ctx.P6]) {
            assert.ok(listed.has(String(shown._id)), `${shown.name} must be listed`);
        }

        assert.deepEqual(Object.keys(data.items[0]), PRODUCT_DTO_KEYS, "list rows are the plain product DTO");
        const raw = JSON.stringify(data.items[0]);
        assert.ok(!raw.includes("_id"), "no datastore key leaks");
        assert.ok(!raw.includes("__v"));
    });

    it("2. limit/offset paginates with a total counted before the window", async () => {
        const res = await api("GET", "/catalog/products?limit=2&offset=2");
        assertOk(res, "Products.");

        const data = res.body.data;
        assert.equal(data.total, 6, "total is the filtered set, not the page");
        assert.equal(data.items.length, 2);
        assert.equal(data.limit, 2);
        assert.equal(data.offset, 2);
        assert.equal(data.page, 2, "offset 2 with limit 2 is page 2");
        assert.equal(data.pageSize, 2);
        assert.deepEqual(names(data.items), ["Studio Monitor Headphones", "Desk Lamp"], "creation order, third and fourth");
    });

    it("3. page/pageSize — the dialect the storefront sends — windows the same rows", async () => {
        const res = await api("GET", "/catalog/products?page=2&pageSize=3");
        assertOk(res, "Products.");

        const data = res.body.data;
        assert.equal(data.total, 6);
        assert.equal(data.page, 2);
        assert.equal(data.pageSize, 3);
        assert.equal(data.limit, 3);
        assert.equal(data.offset, 3, "page 2 of size 3 starts at offset 3");
        assert.deepEqual(names(data.items), ["Desk Lamp", "Ceramic Mug", "Yoga Mat"]);
    });

    it("4. an out-of-range size or offset is ONE 422 naming the field", async () => {
        const tooSmall = await api("GET", "/catalog/products?limit=0");
        assert.equal(tooSmall.status, 422);
        assert.equal(tooSmall.body.ok, false);
        assert.equal(tooSmall.body.error.code, "validation_failed");
        assert.deepEqual(tooSmall.body.error.fields, [
            { field: "limit", message: "Enter a page size between 1 and 100." }
        ]);

        const tooBig = await api("GET", "/catalog/products?pageSize=500");
        assert.equal(tooBig.status, 422);
        assert.equal(tooBig.body.error.fields[0].field, "limit", "pageSize is the same knob");

        const badOffset = await api("GET", "/catalog/products?offset=-1");
        assert.equal(badOffset.status, 422);
        assert.equal(badOffset.body.error.fields[0].field, "offset");

        const badPage = await api("GET", "/catalog/products?page=zero");
        assert.equal(badPage.status, 422);
        assert.equal(badPage.body.error.fields[0].field, "page");
    });

    it("5. search matches name, brand and description case-insensitively", async () => {
        const earbuds = await api("GET", "/catalog/products?search=earbuds");
        assertOk(earbuds, "Products.");
        assert.equal(earbuds.body.data.total, 1);
        assert.deepEqual(names(earbuds.body.data.items), ["Wireless Earbuds"]);

        const headphones = await api("GET", "/catalog/products?search=headphones");
        assert.equal(headphones.body.data.total, 2, "both headphone listings match");
        assert.deepEqual(new Set(names(headphones.body.data.items)), new Set(["Noise-Cancelling Headphones", "Studio Monitor Headphones"]));

        const brand = await api("GET", "/catalog/products?search=AURORA");
        assert.deepEqual(new Set(names(brand.body.data.items)), new Set(["Noise-Cancelling Headphones", "Wireless Earbuds", "Yoga Mat"]));

        const description = await api("GET", "/catalog/products?search=noise%20cancelling");
        assert.deepEqual(names(description.body.data.items), ["Noise-Cancelling Headphones"]);

        const empty = await api("GET", "/catalog/products?search=zzzzz");
        assert.equal(empty.body.data.total, 0, "no match is an empty page, not an error");
        assert.deepEqual(empty.body.data.items, []);
    });

    it("6. category rolls up to its children; seller, store, subcategory and brand scope the page", async () => {
        const asChild = (items) => new Set(names(items));

        const parent = await api("GET", `/catalog/products?category=${ctx.categories.electronics._id}`);
        assert.equal(parent.body.data.total, 3, "a parent matches its own rows and its child's");
        assert.deepEqual(asChild(parent.body.data.items), new Set(["Noise-Cancelling Headphones", "Wireless Earbuds", "Studio Monitor Headphones"]));

        const child = await api("GET", `/catalog/products?category=${ctx.categories.audio._id}`);
        assert.equal(child.body.data.total, 2, "a child matches only rows filed under it");

        const sub = await api("GET", `/catalog/products?subcategory=${ctx.categories.kitchen._id}`);
        assert.deepEqual(names(sub.body.data.items), ["Ceramic Mug"]);

        const bySeller = await api("GET", `/catalog/products?sellerId=${ctx.sellerA.profile._id}`);
        assert.equal(bySeller.body.data.total, 3, "seller A owns three visible products");

        const byStore = await api("GET", `/catalog/products?storeId=${ctx.sellerB.store._id}`);
        assert.deepEqual(asChild(byStore.body.data.items), new Set(["Studio Monitor Headphones", "Desk Lamp", "Ceramic Mug"]));

        const byBrand = await api("GET", "/catalog/products?brand=beacon");
        assert.deepEqual(asChild(byBrand.body.data.items), new Set(["Studio Monitor Headphones", "Desk Lamp"]));
    });

    it("7. the price band and every documented sort reorder the same visible set", async () => {
        const band = await api("GET", "/catalog/products?minPrice=1400&maxPrice=5000");
        assert.equal(band.body.data.total, 3, "effective (sale) price decides the band");
        assert.deepEqual(new Set(names(band.body.data.items)), new Set(["Wireless Earbuds", "Studio Monitor Headphones", "Desk Lamp"]));

        const asc = await api("GET", "/catalog/products?sort=price_asc");
        assert.deepEqual(names(asc.body.data.items), [
            "Ceramic Mug",
            "Yoga Mat",
            "Desk Lamp",
            "Wireless Earbuds",
            "Studio Monitor Headphones",
            "Noise-Cancelling Headphones"
        ], "7200 counts as the sale price, not the 8000 list price");

        const desc = await api("GET", "/catalog/products?sort=price_desc");
        assert.deepEqual(names(desc.body.data.items), [...names(asc.body.data.items)].reverse());

        const rating = await api("GET", "/catalog/products?sort=rating");
        assert.deepEqual(names(rating.body.data.items).slice(0, 3), [
            "Noise-Cancelling Headphones",
            "Studio Monitor Headphones",
            "Wireless Earbuds"
        ]);

        const created = await api("GET", "/catalog/products");
        const unknown = await api("GET", "/catalog/products?sort=whatever");
        assert.deepEqual(names(unknown.body.data.items), names(created.body.data.items), "an unknown sort falls back to relevance");
    });

    it("8. the detail answers with the product, its store and seller, and the live price", async () => {
        const res = await api("GET", `/catalog/products/${ctx.P1._id}`);
        assertOk(res, "Product.");

        const data = res.body.data;
        assert.deepEqual(Object.keys(data), ["product", "store", "seller", "effectivePrice", "availableStock", "visible"]);
        assert.deepEqual(Object.keys(data.product), PRODUCT_DTO_KEYS);
        assert.equal(data.product.id, String(ctx.P1._id));
        assert.equal(data.product.name, "Noise-Cancelling Headphones");
        assert.equal(data.product.salePrice, 7200);
        assert.equal(data.visible, true);
        assert.equal(data.effectivePrice, 7200, "the sale price wins");
        assert.equal(data.availableStock, 12);

        assert.equal(data.store.id, String(ctx.sellerA.store._id));
        assert.equal(data.store.name, "Store A");
        assert.equal(data.store.status, "active");

        assert.deepEqual(Object.keys(data.seller), ["id", "fullName", "status", "sellerType"], "the public seller projection only");
        assert.equal(data.seller.id, String(ctx.sellerA.profile._id));
        assert.equal(data.seller.fullName, "Seller A");
        assert.equal(data.seller.status, "active");

        const raw = JSON.stringify(data);
        assert.ok(!raw.includes("nationalId"), "identity paperwork never reaches a buyer");
        assert.ok(!raw.includes("accountNumber"));
        assert.ok(!raw.includes("_id"), "no datastore key leaks");
    });

    it("9. anything a buyer may not see answers the same 404 as an id that never existed", async () => {
        const cases = [
            { label: "draft", id: ctx.P7._id },
            { label: "paused product", id: ctx.P8._id },
            { label: "paused store", id: ctx.P9._id },
            { label: "pending seller", id: ctx.P10._id },
            { label: "suspended seller", id: ctx.P11._id },
            { label: "derived out_of_stock status", id: ctx.P12._id },
            { label: "unknown id", id: new mongoose.Types.ObjectId() },
            { label: "malformed id", id: "not-an-id" }
        ];

        for (const entry of cases) {
            const res = await api("GET", `/catalog/products/${entry.id}`);
            assert.equal(res.status, 404, `${entry.label} must be a 404`);
            assert.equal(res.body.ok, false);
            assert.equal(res.body.error.code, "not_found");
            assert.equal(res.body.error.message, "Product not found.");
        }
    });

    it("10. stock is a display fact, not the gate: active-and-empty stays, derived status does not", async () => {
        const emptyButListed = await api("GET", `/catalog/products/${ctx.P5._id}`);
        assertOk(emptyButListed, "Product.");
        assert.equal(emptyButListed.body.data.product.status, "active");
        assert.equal(emptyButListed.body.data.availableStock, 0, "zero balance is shown, not hidden");
        assert.equal(emptyButListed.body.data.visible, true);

        const listed = await api("GET", "/catalog/products");
        const ids = listed.body.data.items.map((item) => item.id);
        assert.ok(ids.includes(String(ctx.P5._id)), "an active row with no stock still browses");

        const variants = await api("GET", `/catalog/products/${ctx.P6._id}`);
        assert.equal(variants.body.data.availableStock, 12, "variant stock aggregates across the three options");
        assert.equal(variants.body.data.product.variants.length, 3);
        assert.deepEqual(variants.body.data.product.variants[1], {
            id: variants.body.data.product.variants[1].id,
            productId: String(ctx.P6._id),
            sku: "P6-V2",
            attributes: { Size: "M" },
            price: 1300,
            compareAtPrice: null,
            stock: 4,
            image: ""
        });
    });

    it("11. a store answers with its header, its seller pick and its visible shelf", async () => {
        const res = await api("GET", `/catalog/stores/${ctx.sellerA.store._id}`);
        assertOk(res, "Store.");

        const data = res.body.data;
        assert.equal(data.id, String(ctx.sellerA.store._id));
        assert.equal(data.sellerId, String(ctx.sellerA.profile._id));
        assert.equal(data.name, "Store A");
        assert.equal(data.status, "active");
        assert.equal(data.shippingFee, 60);

        assert.deepEqual(Object.keys(data.seller), ["id", "fullName", "status", "sellerType"]);
        assert.equal(data.seller.fullName, "Seller A");

        assert.equal(data.productCount, 3, "counted live, so it matches what the list would serve");
        assert.equal(data.products.length, 3);
        assert.deepEqual(new Set(names(data.products)), new Set(["Noise-Cancelling Headphones", "Wireless Earbuds", "Yoga Mat"]));
        assert.equal(data.store.id, data.id, "the wrapped store carries the same record");
        assert.equal(data.store.productCount, 3);
        for (const product of data.products) {
            assert.deepEqual(Object.keys(product), PRODUCT_DTO_KEYS);
        }
    });

    it("12. the path segment resolves a store id, a seller profile id or a user id", async () => {
        const byStore = await api("GET", `/catalog/stores/${ctx.sellerB.store._id}`);
        const byProfile = await api("GET", `/catalog/stores/${ctx.sellerB.profile._id}`);
        const byUser = await api("GET", `/catalog/stores/${ctx.sellerB.profile.userId}`);

        for (const res of [byStore, byProfile, byUser]) assertOk(res, "Store.");
        assert.equal(byProfile.body.data.id, String(ctx.sellerB.store._id));
        assert.equal(byUser.body.data.id, String(ctx.sellerB.store._id));
        assert.equal(byUser.body.data.name, "Store B");
        assert.equal(byUser.body.data.productCount, 3, "three visible products on the second store");
        assert.deepEqual(new Set(names(byUser.body.data.products)), new Set(["Studio Monitor Headphones", "Desk Lamp", "Ceramic Mug"]));
    });

    it("13. a store that is not publicly tradeable — or not found — is a 404", async () => {
        const cases = [
            { label: "paused store", id: ctx.sellerC.store._id },
            { label: "store of a pending seller", id: ctx.sellerD.store._id },
            { label: "store of a suspended seller", id: ctx.sellerE.store._id },
            { label: "unknown id", id: new mongoose.Types.ObjectId() },
            { label: "malformed id", id: "not-an-id" }
        ];

        for (const entry of cases) {
            const res = await api("GET", `/catalog/stores/${entry.id}`);
            assert.equal(res.status, 404, `${entry.label} must be a 404`);
            assert.equal(res.body.ok, false);
            assert.equal(res.body.error.code, "not_found");
            assert.equal(res.body.error.message, "Store not found.");
        }
    });

    it("14. the summary counts every listing a seller created, and the live ones", async () => {
        const res = await api("GET", "/catalog/summary");
        assertOk(res, "Catalog summary.");

        const data = res.body.data;
        assert.deepEqual(Object.keys(data).sort(), [
            "activeCount",
            "categoryCount",
            "productCount",
            "sellerCount",
            "storeCount",
            "summary"
        ]);

        assert.equal(data.productCount, 12, "all twelve listings, visible or not");
        assert.equal(data.activeCount, 9, "status only: draft, paused and derived rows are out");
        assert.equal(data.storeCount, 5);
        assert.equal(data.sellerCount, 5);
        assert.equal(data.categoryCount, 4, "two parents and two children");
        assert.deepEqual(data.summary, {
            productCount: 12,
            activeCount: 9,
            storeCount: 5,
            sellerCount: 5,
            categoryCount: 4
        });
    });
});

describe("public meta", () => {
    it("15. payment methods name the four options and how honest each one is", async () => {
        const res = await api("GET", "/meta/payment-methods");
        assertOk(res, "Payment methods.");

        const { methods, note } = res.body.data;
        assert.deepEqual(methods.map((method) => method.id), ["cod", "bkash", "nagad", "card"]);
        assert.deepEqual(methods.map((method) => method.label), ["Cash on delivery", "bKash", "Nagad", "Card"]);
        for (const method of methods) {
            assert.equal(typeof method.caption, "string");
            assert.equal(typeof method.simulated, "boolean");
            assert.equal(typeof method.settledOnDelivery, "boolean");
        }
        assert.equal(methods[0].simulated, false, "cash on delivery is the one that settles");
        assert.equal(methods[0].settledOnDelivery, true);
        assert.equal(methods[1].simulated, true);
        assert.match(note, /cash on delivery/i);
    });

    it("16. delivery methods carry the premium and the window, but never a price", async () => {
        const res = await api("GET", "/meta/delivery-methods");
        assertOk(res, "Delivery methods.");

        const { methods } = res.body.data;
        assert.deepEqual(methods.map((method) => method.id), ["standard", "express"]);
        assert.deepEqual(methods.map((method) => method.label), ["Standard delivery", "Express delivery"]);
        assert.equal(methods[0].caption, "Store dispatch with tracking");
        assert.equal(methods[1].caption, "Priority handling for faster arrival");
        assert.equal(methods[0].premiumPerSeller, 0);
        assert.equal(methods[1].premiumPerSeller, 40);
        assert.equal(methods[0].daysMin, 2);
        assert.equal(methods[0].daysMax, 5);
        assert.equal(methods[1].daysMin, 1);
        assert.equal(methods[1].daysMax, 2);
        for (const method of methods) {
            assert.equal("fee" in method, false, "a fee only exists once a store and a seller count are known");
        }
    });

    it("17. media providers report what the environment can actually do", async () => {
        const res = await api("GET", "/meta/media-providers");
        assertOk(res, "Media providers.");

        const data = res.body.data;
        assert.equal(typeof data.active, "string");
        assert.ok(data.active.length > 0);
        assert.ok(Array.isArray(data.providers));
        assert.ok(data.providers.length >= 1);
        for (const provider of data.providers) {
            assert.equal(typeof provider.id, "string");
            assert.equal(typeof provider.label, "string");
            assert.ok(provider.label.length > 0);
            assert.equal(typeof provider.configured, "boolean");
        }
        assert.ok(Array.isArray(data.acceptedContentTypes));
        assert.ok(data.acceptedContentTypes.every((type) => typeof type === "string" && type.includes("/")));
        assert.equal(typeof data.note, "string");
        assert.ok(data.note.length > 0);

        const cloudinaryConfigured = ["CLOUDINARY_API_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]
            .every((name) => (process.env[name] ?? "").trim() !== "");

        const local = data.providers.find((provider) => provider.id === "local");
        assert.ok(local, "the zero-configuration local provider is always listed");
        assert.equal(local.configured, true, "local media works with zero configuration");

        if (cloudinaryConfigured) {
            assert.equal(data.active, "cloudinary", "a configured vendor is the active provider");
            const cloudinary = data.providers.find((provider) => provider.id === "cloudinary");
            assert.ok(cloudinary, "a configured vendor names itself");
            assert.equal(cloudinary.configured, true);
            assert.deepEqual(
                data.acceptedContentTypes,
                ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heic", "video/mp4"],
                "the accepted list mirrors the multer fileFilter exactly"
            );
            assert.match(data.note, /Cloudinary/);
        } else {
            assert.equal(data.active, "local");
            assert.equal(data.providers.length, 1);
            assert.deepEqual(data.acceptedContentTypes, ["image/jpeg", "image/png", "image/webp", "image/gif"]);
            assert.match(data.note, /No object-storage vendor is configured/);
        }
    });
});
