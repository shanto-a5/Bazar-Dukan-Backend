/**
 * Seller catalog write suite (slice "seller catalog write", milestone M12).
 *
 * Runs against a dedicated `vanta_catalog_test` database on the configured
 * MongoDB and listens on an ephemeral port, so every assertion is about what a
 * client observes: status, envelope, message, field errors, ownership and the
 * ledger rows that a stock movement leaves behind — not about internal calls.
 *
 * Run JUST this file:
 *
 *     node --test src/tests/catalog.test.js
 *
 * The slice router is not wired into `src/app.js` yet (a coordinator does that
 * once every slice lands), so the suite stands up the same stack `app.js`
 * builds — request id, body parsers, cookie parser, the identity router — plus
 * this slice's router, then the same JSON 404/error handlers. Same middleware
 * order, same envelopes, and it works before and after the real wiring: the
 * router file under test is the exact one that gets mounted.
 *
 * The suite drops `vanta_catalog_test` when it finishes; it never touches the
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
import sellerRouter from "../routes/seller.route.js";
import sellerProductRouter from "../routes/seller-product.route.js";
import { User } from "../models/user.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Category } from "../models/category.model.js";
import { Product } from "../models/product.model.js";
import { InventoryAdjustment } from "../models/inventory-adjustment.model.js";
import { Notification } from "../models/notification.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let parentCategory;
let subcategory;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `catalog-${label}-${++sequence}-${Date.now()}@example.com`;

/** The same stack `app.js` builds, plus the slice routers under test. */
const buildApp = () => {
    const instance = express();
    instance.disable("x-powered-by");
    instance.use(requestId);
    instance.use(express.urlencoded({ limit: "16kb", extended: true }));
    instance.use(express.json({ limit: "16kb" }));
    instance.use(cookieParser());
    instance.use("/api/v1/auth", userRouter);
    instance.use("/api/v1", sellerRouter);
    instance.use("/api/v1", sellerProductRouter);
    instance.use(notFoundHandler);
    instance.use(errorHandler);
    return instance;
};

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

/** A complete, valid `BecomeSellerInput`. */
const applicationBody = () => ({
    fullName: "Nadia Rahman",
    phone: "01712345678",
    email: uniqueEmail("apply"),
    nationalId: "1990123456789",
    sellerType: "individual",
    storeName: "Nadia Crafts",
    storeDescription: "Handmade crafts shipped from Dhaka within two days.",
    storeLogo: "",
    storeBanner: "",
    pickupDivision: "Dhaka",
    pickupDistrict: "Dhaka",
    pickupArea: "Dhanmondi",
    pickupAddressLine: "House 1, Road 2, Dhanmondi",
    returnDivision: "Dhaka",
    returnDistrict: "Dhaka",
    returnArea: "Dhanmondi",
    returnAddressLine: "House 1, Road 2, Dhanmondi",
    bankName: "BRAC Bank",
    accountName: "Nadia Rahman",
    accountNumber: "12345678901",
    branch: "Dhanmondi",
    agreement: { ...AGREEMENT }
});

/** Leaves a pending application behind, the way a fresh applicant looks. */
const submitApplication = async (token) => {
    const response = await api("POST", "/seller/register", { token, body: applicationBody() });
    assert.equal(response.status, 201, response.raw);
    return response.body.data;
};

/** An approved seller created directly, the way the approve endpoint leaves it. */
const createActiveSeller = async (user) => {
    const profile = await SellerProfile.create({
        userId: user.id,
        fullName: "Active Seller",
        phone: "01712345678",
        email: user.email,
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

    return { profile, store };
};

/** A registered user who is an approved seller, with everything a test needs. */
const asSeller = async (label) => {
    const account = await registerUser(label);
    const { profile, store } = await createActiveSeller(account.user);
    return { ...account, profile, store };
};

/** A valid create payload, rooted in this run's seeded category tree. */
const productBody = (overrides = {}) => ({
    name: "Aurora Wireless Headphones",
    brand: "Sonora",
    categoryId: String(parentCategory._id),
    subcategoryId: String(subcategory._id),
    description: "Over-ear wireless headphones with active noise cancellation.",
    highlights: ["40-hour battery", "USB-C fast charging"],
    images: ["https://cdn.vanta.example/aurora-front.jpg"],
    regularPrice: 199.99,
    salePrice: 179.99,
    sku: "AUR-BT-001",
    stock: 12,
    lowStockThreshold: 5,
    ...overrides
});

/** Creates a product through the API and returns its wire shape. */
const createProduct = async (token, overrides = {}) => {
    const response = await api("POST", "/seller/products", { token, body: productBody(overrides) });
    assert.equal(response.status, 201, response.raw);
    return response.body.data.product;
};

const variantProductBody = (overrides = {}) =>
    productBody({
        hasVariants: true,
        stock: 0,
        variants: [
            { sku: "AUR-BT-BLK", attributes: { colour: "Black" }, price: 199.99, stock: 4, image: "" },
            { sku: "AUR-BT-SLV", attributes: { colour: "Silver" }, price: 199.99, stock: 6, image: "" }
        ],
        ...overrides
    });

/** Asserts a payload carries `id` (string) and no Mongo internals anywhere. */
const assertNoMongoIds = (raw, label) => {
    assert.ok(!raw.includes('"_id"'), `${label} must not expose _id`);
    assert.ok(!raw.includes('"__v"'), `${label} must not expose __v`);
};

const fieldNames = (response) => response.body.error.fields.map((entry) => entry.field);

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the catalog suite");

    await mongoose.connect(`${base}/vanta_catalog_test`);

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
    parentCategory = await Category.create({ name: "Electronics", icon: "\u{1F4E1}", image: "p:\u{1F4E1}:e", order: 0 });
    subcategory = await Category.create({
        name: "Headphones",
        icon: "\u{1F3A7}",
        image: "p:\u{1F3A7}:h",
        parentId: parentCategory._id,
        order: 0
    });
});

// -------------------------------------------------------------------- create

describe("POST /seller/products", () => {
    it("creates a live listing, stamps publishedAt and counts it on the store", async () => {
        const seller = await asSeller("create-ok");

        const response = await api("POST", "/seller/products", { token: seller.token, body: productBody() });

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.meta.message, "Product created.");

        const { product } = response.body.data;
        assert.equal(typeof product.id, "string");
        assert.equal(product.name, "Aurora Wireless Headphones");
        assert.equal(product.brand, "Sonora");
        assert.equal(product.status, "active");
        assert.ok(product.publishedAt, "a listing that goes live is stamped");
        assert.equal(product.stock, 12);
        assert.equal(product.sellerId, String(seller.profile._id));
        assert.equal(product.storeId, String(seller.store._id));
        assert.equal(product.categoryId, String(parentCategory._id));
        assert.equal(product.subcategoryId, String(subcategory._id));
        assert.equal(product.video, null);
        assert.equal(product.salePrice, 179.99);
        assert.equal(product.hasVariants, false);
        assert.deepEqual(product.variants, []);
        assertNoMongoIds(response.raw, "create response");

        const stored = await Product.findById(product.id);
        assert.equal(stored.status, "active", "the write is persisted");
        assert.equal(String(stored.sellerId), String(seller.profile._id));

        const store = await Store.findById(seller.store._id);
        assert.equal(store.productCount, 1, "the store counter is recomputed after a publish");
    });

    it("saves a draft as a draft: unpublished, uncounted, no publishedAt", async () => {
        const seller = await asSeller("create-draft");

        const response = await api("POST", "/seller/products", {
            token: seller.token,
            body: productBody({ saveAsDraft: true })
        });

        assert.equal(response.status, 201, response.raw);
        const { product } = response.body.data;
        assert.equal(product.status, "draft");
        assert.equal(product.publishedAt, null, "a draft has never been live");

        const store = await Store.findById(seller.store._id);
        assert.equal(store.productCount, 0, "a draft is not on the shelf, so it is not counted");
    });

    it("falls back to the simulator's placeholder image when none are sent", async () => {
        const seller = await asSeller("create-no-images");

        const product = await createProduct(seller.token, { images: [] });

        assert.deepEqual(product.images, [`p:\u{1F6CD}\u{FE0F}:Aurora Wireless Headphones`]);
    });

    it("reports every offending field in one 422 and writes nothing", async () => {
        const seller = await asSeller("create-invalid");

        const response = await api("POST", "/seller/products", {
            token: seller.token,
            body: productBody({
                name: "x",
                brand: "",
                description: "short",
                regularPrice: -5,
                subcategoryId: String(new mongoose.Types.ObjectId()),
                video: 42,
                colour: "red"
            })
        });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.message, "Please fix the highlighted fields.");

        const names = fieldNames(response);
        assert.ok(names.includes("name"), "a name of one character is reported");
        assert.ok(names.includes("brand"), "an empty brand is reported");
        assert.ok(names.includes("description"), "a one-word description is reported");
        assert.ok(names.includes("regularPrice"), "a price of -5 is reported");
        assert.ok(names.includes("subcategoryId"), "a subcategory that does not exist is reported");
        assert.ok(names.includes("video"), "a video that is not a video is reported");
        assert.ok(names.includes("colour"), "an unknown key is reported by name");
        assert.equal(response.body.error.fields.length, names.length, "every entry carries a field name");
        for (const entry of response.body.error.fields) {
            assert.equal(typeof entry.message, "string");
            assert.ok(entry.message.length > 0);
        }

        assert.equal(await Product.countDocuments(), 0, "nothing is written when validation fails");
    });

    it("refuses this seller's own SKU again, and lets another seller use it", async () => {
        const seller = await asSeller("create-duplicate-sku");
        await createProduct(seller.token);

        const duplicate = await api("POST", "/seller/products", { token: seller.token, body: productBody() });

        assert.equal(duplicate.status, 422, duplicate.raw);
        assert.deepEqual(fieldNames(duplicate), ["sku"]);
        assert.equal(
            duplicate.body.error.fields[0].message,
            "This SKU is already used by one of your products."
        );
        assert.equal(await Product.countDocuments(), 1, "the rejected create wrote nothing");

        const other = await asSeller("create-other-sku");
        const allowed = await api("POST", "/seller/products", { token: other.token, body: productBody() });

        assert.equal(allowed.status, 201, allowed.raw, "SKUs are unique per seller, not globally");
    });
});

// -------------------------------------------------------------------- gating

describe("gating", () => {
    it("requires a session", async () => {
        const create = await api("POST", "/seller/products", { body: productBody() });
        assert.equal(create.status, 401);
        assert.equal(create.body.error.code, "unauthorized");

        const list = await api("GET", "/seller/products");
        assert.equal(list.status, 401);
        assert.equal(list.body.error.code, "unauthorized");

        assert.equal(await Product.countDocuments(), 0);
    });

    it("tells a pending applicant their application is under review", async () => {
        const { token } = await registerUser("gating-pending");
        await submitApplication(token);

        const response = await api("POST", "/seller/products", { token, body: productBody() });

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, "forbidden");
        assert.equal(response.body.error.message, "Your seller application is still under review.");
        assert.equal(await Product.countDocuments(), 0);
    });

    it("tells a user with no profile that they do not have a seller account", async () => {
        const { token } = await registerUser("gating-none");

        const response = await api("GET", "/seller/inventory/summary", { token });

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, "forbidden");
        assert.equal(response.body.error.message, "You do not have a seller account.");
    });
});

// ---------------------------------------------------------------------- list

describe("GET /seller/products", () => {
    it("lists only this seller's listings and says how many there are", async () => {
        const seller = await asSeller("list-mine");
        await createProduct(seller.token, { name: "Cedar Travel Mug", sku: "CED-MUG-01", regularPrice: 24.5, salePrice: undefined });
        await createProduct(seller.token, { name: "Bolt Desk Lamp", sku: "BOLT-LMP-01", regularPrice: 49.99, salePrice: undefined });

        const other = await asSeller("list-other");
        await createProduct(other.token, { name: "Drift Notebook", sku: "DRF-NBK-01", regularPrice: 9.99, salePrice: undefined });

        const response = await api("GET", "/seller/products", { token: seller.token });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Products.");
        assert.equal(response.body.data.total, 2, "another seller's listing is never counted");
        assert.equal(response.body.data.limit, 20);
        assert.equal(response.body.data.offset, 0);
        assert.equal(response.body.data.products.length, 2);
        assertNoMongoIds(response.raw, "list response");
        for (const product of response.body.data.products) {
            assert.equal(product.sellerId, String(seller.profile._id));
        }
    });

    it("filters by search, stock level, category and price band", async () => {
        const seller = await asSeller("list-filters");
        const aurora = await createProduct(seller.token);
        const bolt = await createProduct(seller.token, {
            name: "Bolt Desk Lamp",
            brand: "Volt",
            sku: "BOLT-LMP-01",
            images: ["https://cdn.vanta.example/bolt.jpg"],
            regularPrice: 49.99,
            salePrice: undefined,
            stock: 3
        });
        const cedar = await createProduct(seller.token, {
            name: "Cedar Travel Mug",
            brand: "Northwood",
            sku: "CED-MUG-01",
            images: ["https://cdn.vanta.example/cedar.jpg"],
            regularPrice: 89.99,
            salePrice: undefined,
            stock: 0
        });

        const byName = await api("GET", "/seller/products?search=aurora", { token: seller.token });
        assert.equal(byName.body.data.total, 1, "search matches the name");
        assert.equal(byName.body.data.products[0].id, aurora.id);

        const byBrand = await api("GET", "/seller/products?search=Northwood", { token: seller.token });
        assert.equal(byBrand.body.data.total, 1, "search matches the brand, case-insensitively");
        assert.equal(byBrand.body.data.products[0].id, cedar.id);

        const low = await api("GET", "/seller/products?status=low", { token: seller.token });
        assert.deepEqual(low.body.data.products.map((product) => product.id), [bolt.id], "stock level beats status");

        const out = await api("GET", "/seller/products?status=out", { token: seller.token });
        assert.deepEqual(out.body.data.products.map((product) => product.id), [cedar.id]);

        const byCategory = await api("GET", `/seller/products?categoryId=${String(subcategory._id)}`, {
            token: seller.token
        });
        assert.equal(byCategory.body.data.total, 3, "the subcategory matches too");

        const affordable = await api("GET", "/seller/products?minPrice=60&maxPrice=200", { token: seller.token });
        assert.deepEqual(
            affordable.body.data.products.map((product) => product.id).sort(),
            [aurora.id, cedar.id].sort(),
            "the band applies to the effective price"
        );

        const page = await api("GET", "/seller/products?limit=0", { token: seller.token });
        assert.equal(page.status, 422);
        assert.deepEqual(page.body.error.fields, [
            { field: "limit", message: "Enter a page size between 1 and 100." }
        ]);
    });

    it("sorts by name and price, and pages a window of the filtered list", async () => {
        const seller = await asSeller("list-sort");
        await createProduct(seller.token, {
            name: "Cedar Travel Mug",
            sku: "CED-MUG-01",
            images: ["https://cdn.vanta.example/cedar.jpg"],
            regularPrice: 89.99,
            salePrice: undefined
        });
        await createProduct(seller.token, {
            name: "Bolt Desk Lamp",
            sku: "BOLT-LMP-01",
            images: ["https://cdn.vanta.example/bolt.jpg"],
            regularPrice: 49.99,
            salePrice: undefined
        });
        const aurora = await createProduct(seller.token);

        const byName = await api("GET", "/seller/products?sort=name", { token: seller.token });
        assert.deepEqual(
            byName.body.data.products.map((product) => product.name),
            ["Aurora Wireless Headphones", "Bolt Desk Lamp", "Cedar Travel Mug"],
            "alphabetical, although they were created the other way round"
        );

        const byPrice = await api("GET", "/seller/products?sort=price_asc", { token: seller.token });
        assert.deepEqual(
            byPrice.body.data.products.map((product) => product.name),
            ["Bolt Desk Lamp", "Cedar Travel Mug", "Aurora Wireless Headphones"],
            "effective price: the sale price is what a buyer pays"
        );

        const window = await api("GET", "/seller/products?sort=name&limit=2&offset=1", { token: seller.token });
        assert.equal(window.body.data.total, 3, "total counts the whole filtered list");
        assert.equal(window.body.data.limit, 2);
        assert.equal(window.body.data.offset, 1);
        assert.deepEqual(
            window.body.data.products.map((product) => product.name),
            ["Bolt Desk Lamp", "Cedar Travel Mug"],
            "the page starts after the first row"
        );
        assert.ok(
            !window.body.data.products.some((product) => product.id === aurora.id),
            "the first row was paged past"
        );

        const fallback = await api("GET", "/seller/products?sort=sideways", { token: seller.token });
        assert.equal(fallback.status, 200, "an unknown sort falls back instead of failing");
        assert.equal(fallback.body.data.total, 3);
    });
});

// ----------------------------------------------------------------------- get

describe("GET /seller/products/:id", () => {
    it("serves one of the seller's own listings", async () => {
        const seller = await asSeller("get-ok");
        const created = await createProduct(seller.token);

        const response = await api("GET", `/seller/products/${created.id}`, { token: seller.token });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Product.");
        assert.equal(response.body.data.product.id, created.id);
        assert.equal(response.body.data.product.name, created.name);
        assertNoMongoIds(response.raw, "get response");
    });

    it("answers an unknown and a malformed id with 404", async () => {
        const seller = await asSeller("get-404");

        const unknown = await api("GET", `/seller/products/${new mongoose.Types.ObjectId()}`, { token: seller.token });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.body.error.code, "not_found");
        assert.equal(unknown.body.error.message, "Product not found.");

        const malformed = await api("GET", "/seller/products/not-an-id", { token: seller.token });
        assert.equal(malformed.status, 404, "a malformed id is a 404, never a 500");
        assert.equal(malformed.body.error.message, "Product not found.");
    });
});

// --------------------------------------------------------------------- update

describe("PATCH /seller/products/:id", () => {
    it("updates the fields a listing owns and persists them", async () => {
        const seller = await asSeller("patch-ok");
        const created = await createProduct(seller.token);

        const response = await api("PATCH", `/seller/products/${created.id}`, {
            token: seller.token,
            body: {
                name: "Aurora Pro Headphones",
                brand: "Sonora Audio",
                description: "Flagship over-ear headphones with hybrid noise cancellation.",
                highlights: ["Hybrid ANC", "Multipoint Bluetooth"],
                images: ["https://cdn.vanta.example/aurora-pro.jpg"],
                regularPrice: 149.99,
                salePrice: 129.99
            }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Product updated.");

        const { product } = response.body.data;
        assert.equal(product.name, "Aurora Pro Headphones");
        assert.equal(product.brand, "Sonora Audio");
        assert.equal(product.regularPrice, 149.99);
        assert.equal(product.salePrice, 129.99);
        assert.equal(product.status, "active", "an edit of a live listing leaves it live");
        assertNoMongoIds(response.raw, "patch response");

        const reread = await api("GET", `/seller/products/${created.id}`, { token: seller.token });
        assert.equal(reread.body.data.product.name, "Aurora Pro Headphones", "the write is persisted");
        assert.deepEqual(reread.body.data.product.highlights, ["Hybrid ANC", "Multipoint Bluetooth"]);
    });

    it("refuses stock, status, server-owned keys and saveAsDraft by name", async () => {
        const seller = await asSeller("patch-immutable");
        const created = await createProduct(seller.token);

        for (const field of ["stock", "status", "saveAsDraft", "sellerId", "storeId", "ratingAvg", "soldCount", "id", "colour"]) {
            const response = await api("PATCH", `/seller/products/${created.id}`, {
                token: seller.token,
                body: { [field]: "nope" }
            });
            assert.equal(response.status, 422, `${field} must be refused`);
            assert.equal(response.body.error.code, "validation_failed");
            assert.deepEqual(fieldNames(response), [field], `${field} must be named in the error`);
            assert.equal(response.body.error.fields[0].message, `${field} cannot be set from a request.`);
        }

        const stored = await Product.findById(created.id);
        assert.equal(stored.name, "Aurora Wireless Headphones", "no rejected field reached the datastore");
        assert.equal(stored.stock, 12, "stock only moves through its own endpoint");
        assert.equal(stored.status, "active", "status only moves through its own endpoint");
    });

    it("refuses a sale price that is not below the regular price", async () => {
        const seller = await asSeller("patch-sale-price");
        const created = await createProduct(seller.token);

        const response = await api("PATCH", `/seller/products/${created.id}`, {
            token: seller.token,
            body: { salePrice: 250 }
        });

        assert.equal(response.status, 422, response.raw);
        assert.deepEqual(fieldNames(response), ["salePrice"]);
        assert.equal(
            response.body.error.fields[0].message,
            "The sale price must be lower than the regular price."
        );
    });

    it("refuses an empty patch instead of answering with a silent no-op", async () => {
        const seller = await asSeller("patch-empty");
        const created = await createProduct(seller.token);

        const response = await api("PATCH", `/seller/products/${created.id}`, { token: seller.token, body: {} });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.message, "No product fields were provided.");
    });

    it("re-derives stock and status after an edit", async () => {
        const seller = await asSeller("patch-recompute");
        const created = await createProduct(seller.token);

        const drained = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: -12 }
        });
        assert.equal(drained.body.data.status, "out_of_stock", "an empty shelf takes the listing out of stock");

        const response = await api("PATCH", `/seller/products/${created.id}`, {
            token: seller.token,
            body: { description: "Renamed after the shelf ran dry, still sold out." }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.product.stock, 0);
        assert.equal(response.body.data.product.status, "out_of_stock", "an edit does not resurrect a sold-out listing");
    });
});

// --------------------------------------------------------------------- status

describe("PATCH /seller/products/:id/status", () => {
    it("moves a listing active -> paused -> active and keeps its publication date", async () => {
        const seller = await asSeller("status-happy");
        const created = await createProduct(seller.token);

        const pause = await api("PATCH", `/seller/products/${created.id}/status`, {
            token: seller.token,
            body: { status: "paused" }
        });

        assert.equal(pause.status, 200, pause.raw);
        assert.equal(pause.body.meta.message, "Product status updated.");
        assert.equal(pause.body.data.status, "paused", "the status endpoint answers with the product itself");
        assert.equal(pause.body.data.publishedAt, created.publishedAt, "pausing does not move the publication date");
        assertNoMongoIds(pause.raw, "status response");

        const resume = await api("PATCH", `/seller/products/${created.id}/status`, {
            token: seller.token,
            body: { status: "active" }
        });

        assert.equal(resume.status, 200, resume.raw);
        assert.equal(resume.body.data.status, "active");
        assert.equal(resume.body.data.publishedAt, created.publishedAt, "still the original publication date");
    });

    it("refuses to publish what is not ready to be published", async () => {
        const seller = await asSeller("status-publish");
        const emptyDraft = await createProduct(seller.token, { saveAsDraft: true, stock: 0, salePrice: undefined });

        const unstocked = await api("PATCH", `/seller/products/${emptyDraft.id}/status`, {
            token: seller.token,
            body: { status: "active" }
        });
        assert.equal(unstocked.status, 422, unstocked.raw);
        assert.equal(unstocked.body.error.message, "Restock before publishing.");
        assert.deepEqual(unstocked.body.error.fields, [
            { field: "status", message: "Restock before publishing." }
        ]);
    });

    it("unlocks an archived listing straight back to live", async () => {
        const seller = await asSeller("status-unlock");
        const live = await createProduct(seller.token, { name: "Bolt Desk Lamp", sku: "BOLT-LMP-01" });

        const archived = await api("PATCH", `/seller/products/${live.id}/status`, {
            token: seller.token,
            body: { status: "archived" }
        });
        assert.equal(archived.status, 200, "an active listing may be locked");
        assert.equal(archived.body.data.status, "archived");

        const unlocked = await api("PATCH", `/seller/products/${live.id}/status`, {
            token: seller.token,
            body: { status: "active" }
        });
        assert.equal(unlocked.status, 200, unlocked.raw);
        assert.equal(unlocked.body.data.status, "active", "a locked listing may be unlocked straight to live");
        assert.equal(unlocked.body.data.publishedAt, live.publishedAt, "unlocking keeps the original publication date");

        const stored = await Product.findById(live.id);
        assert.equal(stored.status, "active");

        const empty = await createProduct(seller.token, {
            name: "Cedar Shelf",
            sku: "CEDAR-01",
            saveAsDraft: true,
            stock: 0,
            salePrice: undefined
        });
        await api("PATCH", `/seller/products/${empty.id}/status`, {
            token: seller.token,
            body: { status: "archived" }
        });
        const restockFirst = await api("PATCH", `/seller/products/${empty.id}/status`, {
            token: seller.token,
            body: { status: "active" }
        });
        assert.equal(restockFirst.status, 422, restockFirst.raw);
        assert.equal(restockFirst.body.error.message, "Restock before publishing.", "unlocking still refuses an unstocked listing");
    });

    it("answers every refused transition with its own reason", async () => {
        const seller = await asSeller("status-guards");
        const live = await createProduct(seller.token);

        const again = await api("PATCH", `/seller/products/${live.id}/status`, {
            token: seller.token,
            body: { status: "active" }
        });
        assert.equal(again.status, 422, again.raw);
        assert.equal(again.body.error.message, "Already in that state.");

        const toDraft = await api("PATCH", `/seller/products/${live.id}/status`, {
            token: seller.token,
            body: { status: "draft" }
        });
        assert.equal(toDraft.status, 422, toDraft.raw);
        assert.equal(toDraft.body.error.message, "Only an archived listing can be restored.");

        const draft = await createProduct(seller.token, { name: "Bolt Desk Lamp", sku: "BOLT-LMP-01", saveAsDraft: true });
        const toPaused = await api("PATCH", `/seller/products/${draft.id}/status`, {
            token: seller.token,
            body: { status: "paused" }
        });
        assert.equal(toPaused.status, 422, toPaused.raw);
        assert.equal(toPaused.body.error.message, "Only a live listing can be paused.");

        const stored = await Product.findById(live.id);
        assert.equal(stored.status, "active", "a refused transition changes nothing");
    });

    it("refuses a status this endpoint does not accept, and any key beside it", async () => {
        const seller = await asSeller("status-invalid");
        const created = await createProduct(seller.token);

        for (const status of ["out_of_stock", "pending", "bogus"]) {
            const response = await api("PATCH", `/seller/products/${created.id}/status`, {
                token: seller.token,
                body: { status }
            });
            assert.equal(response.status, 422, `${status} must be refused`);
            assert.deepEqual(response.body.error.fields, [
                { field: "status", message: "Choose a valid listing status." }
            ]);
        }

        const extra = await api("PATCH", `/seller/products/${created.id}/status`, {
            token: seller.token,
            body: { status: "paused", publishedAt: "2020-01-01T00:00:00.000Z" }
        });
        assert.equal(extra.status, 422, extra.raw);
        assert.deepEqual(
            extra.body.error.fields,
            [{ field: "publishedAt", message: "publishedAt cannot be set from a request." }],
            "a valid status is not an excuse for the keys that do not belong"
        );

        const stored = await Product.findById(created.id);
        assert.equal(stored.status, "active", "nothing was applied");
        assert.equal(stored.publishedAt.toISOString(), created.publishedAt);
    });
});

// ---------------------------------------------------------------------- stock

describe("POST /seller/products/:id/stock", () => {
    it("moves units, writes the ledger row and answers with the product", async () => {
        const seller = await asSeller("stock-add");
        const created = await createProduct(seller.token);

        const response = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 5 }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Stock updated.");
        assert.equal(response.body.data.stock, 17, "the status endpoint answers with the product itself");
        assert.equal(response.body.data.status, "active");
        assertNoMongoIds(response.raw, "stock response");

        const rows = await InventoryAdjustment.find({});
        assert.equal(rows.length, 1, "every movement is recorded");
        assert.equal(rows[0].quantity, 5);
        assert.equal(rows[0].reason, "restock", "restock is the default reason");
        assert.equal(rows[0].variantId, null);
        assert.equal(String(rows[0].sellerId), String(seller.profile._id));
        assert.equal(String(rows[0].productId), created.id);

        const byQuantity = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { quantity: -3, reason: "manual" }
        });
        assert.equal(byQuantity.status, 200, byQuantity.raw, "the storefront client's `quantity` name works too");
        assert.equal(byQuantity.body.data.stock, 14);
        assert.equal((await InventoryAdjustment.find({})).length, 2);
    });

    it("clamps at zero, flips to out of stock and tells the seller", async () => {
        const seller = await asSeller("stock-clamp");
        const created = await createProduct(seller.token);

        const response = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: -30 }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.stock, 0, "stock never goes negative");
        assert.equal(response.body.data.status, "out_of_stock", "the listing is taken down automatically");

        const rows = await InventoryAdjustment.find({});
        assert.equal(rows.length, 1);
        assert.equal(rows[0].quantity, -12, "the ledger records what actually moved, not what was asked for");

        const notes = await Notification.find({});
        assert.equal(notes.length, 1, "the seller hears about an empty shelf exactly once");
        assert.equal(notes[0].type, "seller_low_stock");
        assert.equal(notes[0].title, "Product out of stock");
        assert.equal(
            notes[0].body,
            "Aurora Wireless Headphones is out of stock. Update the quantity so buyers can order again."
        );
        assert.equal(String(notes[0].userId), String(seller.user.id));
        assert.equal(notes[0].data.level, "out");
        assert.equal(notes[0].data.productId, created.id);
        assert.equal(notes[0].data.sellerId, String(seller.profile._id));

        const store = await Store.findById(seller.store._id);
        assert.equal(store.productCount, 1, "an out-of-stock listing is still one of the seller's listings");
    });

    it("pings the seller once, when a balance crosses the alert level", async () => {
        const seller = await asSeller("stock-crossing");
        const created = await createProduct(seller.token, { stock: 12, lowStockThreshold: 5 });

        await api("POST", `/seller/products/${created.id}/stock`, { token: seller.token, body: { delta: -8 } });

        const notes = await Notification.find({});
        assert.equal(notes.length, 1, "dropping from 12 to 4 crosses the level of 5");
        assert.equal(notes[0].title, "Low stock alert");
        assert.equal(
            notes[0].body,
            "Aurora Wireless Headphones has 4 unit(s) left, at or below your alert level of 5."
        );
        assert.equal(notes[0].data.level, "low");

        const restocked = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 10 }
        });
        assert.equal(restocked.body.data.stock, 14, "4 units plus 10 is 14");

        assert.equal((await Notification.find({})).length, 1, "restocking never pings, and neither does a second dip");
    });

    it("insists on a variant for a variant product and matches it by SKU", async () => {
        const seller = await asSeller("stock-variant");
        const created = await createProduct(seller.token, variantProductBody());
        assert.equal(created.stock, 10, "a variant product's stock is the sum of its variants");
        const blackId = created.variants[0].id;
        assert.match(blackId, /^[0-9a-f]{24}$/, "a variant carries its own id on the wire");
        assert.notEqual(blackId, "AUR-BT-BLK", "the id is the variant's _id, not its SKU");

        const missing = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 5 }
        });
        assert.equal(missing.status, 422, missing.raw);
        assert.equal(missing.body.error.message, "Choose the variant you want to update.");
        assert.deepEqual(missing.body.error.fields, [
            { field: "variantId", message: "Choose the variant you want to update." }
        ]);

        const wrong = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 5, variantId: "AUR-BT-GRN" }
        });
        assert.equal(wrong.status, 422, wrong.raw);
        assert.equal(wrong.body.error.message, "That variant no longer exists on this product.");

        const adjusted = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: -2, variantId: "AUR-BT-BLK", reason: "manual" }
        });

        assert.equal(adjusted.status, 200, adjusted.raw);
        assert.equal(adjusted.body.data.stock, 8, "only the chosen variant moved");
        const black = adjusted.body.data.variants.find((variant) => variant.sku === "AUR-BT-BLK");
        const silver = adjusted.body.data.variants.find((variant) => variant.sku === "AUR-BT-SLV");
        assert.equal(black.stock, 2);
        assert.equal(silver.stock, 6, "the other variant is untouched");

        const adjustment = await InventoryAdjustment.findOne({});
        assert.equal(adjustment.quantity, -2);
        assert.equal(adjustment.variantId, "AUR-BT-BLK", "the ledger keeps exactly what the client sent");

        const byId = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 1, variantId: blackId, reason: "manual" }
        });
        assert.equal(byId.status, 200, byId.raw, "the variant's own id matches as well");
        assert.equal(byId.body.data.stock, 9);
        assert.equal(
            byId.body.data.variants.find((variant) => variant.sku === "AUR-BT-BLK").stock,
            3
        );
        assert.equal((await InventoryAdjustment.find({})).length, 2);
    });

    it("refuses a movement that is not a whole non-zero number, and any other input", async () => {
        const seller = await asSeller("stock-invalid");
        const created = await createProduct(seller.token);

        const fractional = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 1.5 }
        });
        assert.equal(fractional.status, 422, fractional.raw);
        assert.deepEqual(fractional.body.error.fields, [
            { field: "delta", message: "Enter a whole number of units to add or remove." }
        ]);

        const zeroByQuantity = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { quantity: 0 }
        });
        assert.equal(zeroByQuantity.status, 422);
        assert.deepEqual(zeroByQuantity.body.error.fields, [
            { field: "quantity", message: "Enter a whole number of units to add or remove." }
        ]);

        const badReason = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 3, reason: "theft" }
        });
        assert.equal(badReason.status, 422);
        assert.deepEqual(badReason.body.error.fields, [
            { field: "reason", message: "Choose a valid reason for this adjustment." }
        ]);

        const unknown = await api("POST", `/seller/products/${created.id}/stock`, {
            token: seller.token,
            body: { delta: 3, colour: "red" }
        });
        assert.equal(unknown.status, 422);
        assert.deepEqual(unknown.body.error.fields, [{ field: "colour", message: "colour cannot be set from a request." }]);

        assert.equal(await InventoryAdjustment.countDocuments(), 0, "nothing moved");
        assert.equal((await Product.findById(created.id)).stock, 12, "the shelf is untouched");
    });
});

// ------------------------------------------------------------------- summary

describe("GET /seller/inventory/summary", () => {
    it("rolls the shelf up worst-first and leaves archived listings out", async () => {
        const seller = await asSeller("summary");
        await createProduct(seller.token, {
            name: "Cedar Travel Mug",
            sku: "CED-MUG-01",
            images: ["https://cdn.vanta.example/cedar.jpg"],
            regularPrice: 89.99,
            salePrice: undefined,
            stock: 0
        });
        await createProduct(seller.token, {
            name: "Bolt Desk Lamp",
            sku: "BOLT-LMP-01",
            images: ["https://cdn.vanta.example/bolt.jpg"],
            regularPrice: 49.99,
            salePrice: undefined,
            stock: 3
        });
        const aurora = await createProduct(seller.token);
        const drift = await createProduct(seller.token, {
            name: "Drift Notebook",
            sku: "DRF-NBK-01",
            images: ["https://cdn.vanta.example/drift.jpg"],
            regularPrice: 9.99,
            salePrice: undefined,
            stock: 7
        });
        await api("PATCH", `/seller/products/${drift.id}/status`, { token: seller.token, body: { status: "archived" } });

        const response = await api("GET", "/seller/inventory/summary", { token: seller.token });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Inventory summary.");

        const summary = response.body.data;
        assert.equal(summary.sellerId, String(seller.profile._id));
        assert.equal(summary.storeId, String(seller.store._id));
        assert.equal(summary.totalProducts, 3, "an archived listing is off the shelf");
        assert.equal(summary.activeProducts, 3);
        assert.equal(summary.totalUnits, 15);
        assert.equal(summary.outOfStock, 1);
        assert.equal(summary.lowStock, 1);
        assert.equal(summary.healthy, 1);
        assert.deepEqual(
            summary.rows.map((row) => row.level),
            ["out", "low", "healthy"],
            "worst first, so what needs attention is at the top"
        );
        assert.deepEqual(
            summary.rows.map((row) => row.productId),
            [summary.rows[0].productId, summary.rows[1].productId, aurora.id],
            "within a level, by name"
        );

        const row = summary.rows[0];
        assert.equal(row.name, "Cedar Travel Mug");
        assert.equal(row.status, "active");
        assert.equal(row.stock, 0);
        assert.equal(row.lowStockThreshold, 5);
        assertNoMongoIds(response.raw, "summary response");
    });
});

// --------------------------------------------------------------- adjustments

describe("GET /seller/inventory/adjustments", () => {
    it("lists this seller's movements newest first, and can scope to one product", async () => {
        const seller = await asSeller("adjustments");
        const first = await createProduct(seller.token, { name: "Cedar Travel Mug", sku: "CED-MUG-01" });
        const second = await createProduct(seller.token, { name: "Bolt Desk Lamp", sku: "BOLT-LMP-01" });

        await api("POST", `/seller/products/${first.id}/stock`, { token: seller.token, body: { delta: 5 } });
        await api("POST", `/seller/products/${first.id}/stock`, { token: seller.token, body: { delta: -2, reason: "manual" } });
        await api("POST", `/seller/products/${second.id}/stock`, { token: seller.token, body: { delta: 7 } });

        const response = await api("GET", "/seller/inventory/adjustments", { token: seller.token });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Inventory adjustments.");
        assert.equal(response.body.data.adjustments.length, 3);
        assert.deepEqual(
            response.body.data.adjustments.map((entry) => entry.quantity),
            [7, -2, 5],
            "newest first"
        );
        assertNoMongoIds(response.raw, "adjustments response");

        const entry = response.body.data.adjustments[0];
        assert.equal(typeof entry.id, "string");
        assert.equal(entry.productId, second.id);
        assert.equal(entry.variantId, null);
        assert.equal(entry.reason, "restock");
        assert.equal(entry.referenceId, null);
        assert.equal(entry.sellerId, String(seller.profile._id));
        assert.ok(entry.createdAt, "a ledger row is timestamped");

        const scoped = await api("GET", `/seller/inventory/adjustments?productId=${first.id}`, { token: seller.token });
        assert.equal(scoped.body.data.adjustments.length, 2, "scoped to the one product asked for");
        for (const row of scoped.body.data.adjustments) {
            assert.equal(row.productId, first.id);
        }

        const limited = await api("GET", "/seller/inventory/adjustments?limit=1", { token: seller.token });
        assert.equal(limited.body.data.adjustments.length, 1);
        assert.equal(limited.body.data.adjustments[0].quantity, 7);
    });

    it("refuses to read another seller's ledger through a product id", async () => {
        const seller = await asSeller("adjustments-mine");
        const other = await asSeller("adjustments-theirs");
        const theirs = await createProduct(other.token);
        await api("POST", `/seller/products/${theirs.id}/stock`, { token: other.token, body: { delta: 5 } });

        const foreign = await api("GET", `/seller/inventory/adjustments?productId=${theirs.id}`, {
            token: seller.token
        });
        assert.equal(foreign.status, 404, foreign.raw);
        assert.equal(foreign.body.error.message, "Product not found.");

        const malformed = await api("GET", "/seller/inventory/adjustments?productId=not-an-id", { token: seller.token });
        assert.equal(malformed.status, 404);

        const mine = await api("GET", "/seller/inventory/adjustments", { token: seller.token });
        assert.equal(mine.body.data.adjustments.length, 0, "the ledger is scoped to its owner");
    });
});

// ----------------------------------------------------------------- ownership

describe("ownership", () => {
    it("answers 404 on every write to another seller's listing, and changes nothing", async () => {
        const owner = await asSeller("owner");
        const intruder = await asSeller("intruder");
        const created = await createProduct(owner.token);

        const read = await api("GET", `/seller/products/${created.id}`, { token: intruder.token });
        assert.equal(read.status, 404);
        assert.equal(read.body.error.message, "Product not found.");

        const update = await api("PATCH", `/seller/products/${created.id}`, {
            token: intruder.token,
            body: { name: "Hijacked Listing Name" }
        });
        assert.equal(update.status, 404);
        assert.equal(update.body.error.message, "Product not found.");

        const status = await api("PATCH", `/seller/products/${created.id}/status`, {
            token: intruder.token,
            body: { status: "archived" }
        });
        assert.equal(status.status, 404);

        const stock = await api("POST", `/seller/products/${created.id}/stock`, {
            token: intruder.token,
            body: { delta: -50 }
        });
        assert.equal(stock.status, 404);

        const stored = await Product.findById(created.id);
        assert.equal(stored.name, "Aurora Wireless Headphones", "nothing an intruder sent was applied");
        assert.equal(stored.stock, 12);
        assert.equal(stored.status, "active");
        assert.equal(await InventoryAdjustment.countDocuments({ sellerId: intruder.profile._id }), 0);

        const intruderList = await api("GET", "/seller/products", { token: intruder.token });
        assert.equal(intruderList.body.data.total, 0, "the listing is not in the intruder's catalog either");
    });
});
