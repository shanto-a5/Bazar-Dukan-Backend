/**
 * Voucher suite (M12 — vouchers + notifications slice).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_voucher_test` database, so every assertion below is about what a
 * client would actually observe: status, envelope, error code, exact field
 * messages, ownership 404s and the `/vouchers/eligible` quotes — not about
 * internal calls.
 *
 * Run: node --test src/tests/voucher.test.js
 *
 * The suite drops `vanta_voucher_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import voucherRouter from "../routes/voucher.route.js";
import { Voucher } from "../models/voucher.model.js";
import { Cart } from "../models/cart.model.js";
import { Product } from "../models/product.model.js";
import { Store } from "../models/store.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Category } from "../models/category.model.js";
import { markUsed } from "../services/voucher.service.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `voucher-${label}-${++sequence}-${Date.now()}@example.com`;

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
    return { token: response.body.data.token, userId: response.body.data.user.id };
};

/** An active seller account: profile + session token for that user. */
const makeSeller = async (label) => {
    const { token, userId } = await registerUser(`seller-${label}`);
    const profile = await SellerProfile.create({
        userId,
        fullName: `Seller ${label}`,
        phone: `017${String(++sequence).padStart(8, "0")}`,
        email: uniqueEmail(`profile-${label}`),
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

    return { token, userId, sellerId: String(profile._id), profile };
};

/** A valid create body; every test overrides only what it is about. */
const voucherBody = (overrides = {}) => ({
    code: "SAVE10",
    title: "Save Ten",
    type: "percentage",
    discountValue: 10,
    minimumOrder: 0,
    startAt: new Date(Date.now() - 60000).toISOString(),
    expiry: new Date(Date.now() + 86400000).toISOString(),
    usageLimit: 100,
    perUserLimit: 1,
    ...overrides
});

const createVoucher = async (token, overrides = {}) => {
    const response = await api("POST", "/seller/vouchers", { token, body: voucherBody(overrides) });
    return response;
};

const fieldOf = (response, field) => response.body.error.fields.find((entry) => entry.field === field);

/** One active store per seller (the schema allows exactly one). */
const makeStore = async (profile, { shippingFee, freeShippingThreshold }) =>
    Store.create({
        sellerId: profile._id,
        name: `Storefront of ${profile.storeName}`,
        status: "active",
        shippingFee,
        freeShippingThreshold,
        deliveryEstimateDays: { min: 2, max: 4 }
    });

/** A live product, so a cart line over it resolves to a priced group. */
const makeProduct = async (profile, store, category, { name, price }) =>
    Product.create({
        sellerId: profile._id,
        storeId: store._id,
        categoryId: category._id,
        name,
        brand: "Alpha",
        sku: `SKU-${++sequence}`,
        regularPrice: price,
        status: "active",
        stock: 10,
        images: [`${name}.png`]
    });

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the voucher suite");

    // app.js does not mount the voucher router yet (the coordinator adds
    // `app.use("/api/v1", voucherRouter);`). For this suite the router is
    // mounted the same way, inserted directly before the not-found handler so
    // every other route keeps behaving exactly as before.
    app.use("/api/v1", voucherRouter);
    const stack = app.router.stack;
    const layer = stack.pop();
    stack.splice(stack.length - 2, 0, layer);

    await mongoose.connect(`${base}/vanta_voucher_test`);

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
});

// ------------------------------------------------------- seller management

describe("seller voucher management", () => {
    it("1. creates a voucher with a forced seller scope and an uppercased code", async () => {
        const { token, sellerId } = await makeSeller("create");
        const response = await createVoucher(token, { code: "  save10  " });

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.meta.message, "Voucher created.");

        const voucher = response.body.data.voucher;
        assert.equal(voucher.code, "SAVE10");
        assert.equal(voucher.scope, "seller");
        assert.equal(voucher.sellerId, sellerId);
        assert.equal(voucher.state, "live");
        assert.equal(voucher.usageCount, 0);
        assert.equal(typeof voucher.id, "string");
        assert.equal(voucher._id, undefined, "the DTO never exposes _id");
        assert.equal(voucher.__v, undefined, "the DTO never exposes __v");
        assert.equal(voucher.perUserUsed, undefined, "the DTO never exposes the per-user tally");

        const stored = await Voucher.findOne({ code: "SAVE10" });
        assert.ok(stored);
        assert.equal(String(stored.sellerId), sellerId);
        assert.equal(stored.scope, "seller");
    });

    it("2. refuses a client-supplied scope or sellerId with 422", async () => {
        const { token, sellerId } = await makeSeller("forced");
        const response = await createVoucher(token, {
            scope: "platform",
            sellerId: new mongoose.Types.ObjectId().toHexString()
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.deepEqual(response.body.error.fields.map((entry) => entry.field).sort(), ["scope", "sellerId"]);
        assert.equal(await Voucher.countDocuments(), 0, "nothing may be written");
        assert.ok(sellerId);
    });

    it("3. answers a non-seller with 403 forbidden", async () => {
        const { token } = await registerUser("plain");
        const response = await createVoucher(token);

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, "forbidden");
        assert.equal(await Voucher.countDocuments(), 0);
    });

    it("4. rejects a code that does not match the pattern", async () => {
        const { token } = await makeSeller("pattern");
        const response = await createVoucher(token, { code: "ab" });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.deepEqual(response.body.error.fields.map((entry) => entry.field), ["code"]);
        assert.equal(fieldOf(response, "code").message, "Use 3-20 letters, numbers, dashes or underscores.");
        assert.equal(await Voucher.countDocuments(), 0);
    });

    it("5. reports a duplicate code with the seller-aware message", async () => {
        const a = await makeSeller("dup-a");
        const first = await createVoucher(a.token, { code: "SAVE10" });
        assert.equal(first.status, 201, first.raw);

        const again = await createVoucher(a.token, { code: " save10 " });
        assert.equal(again.status, 422);
        assert.equal(fieldOf(again, "code").message, "You already have a voucher with this code.");

        const b = await makeSeller("dup-b");
        const otherSeller = await createVoucher(b.token, { code: "SAVE10" });
        assert.equal(otherSeller.status, 422);
        assert.equal(fieldOf(otherSeller, "code").message, "That code is already used on Vanta.");

        await Voucher.create({
            code: "TAKEN",
            title: "Platform code",
            type: "percentage",
            discountValue: 5,
            minimumOrder: 0,
            scope: "platform",
            sellerId: null,
            startAt: new Date(Date.now() - 60000),
            expiry: new Date(Date.now() + 86400000)
        });
        const platformClash = await createVoucher(a.token, { code: "taken" });
        assert.equal(platformClash.status, 422);
        assert.equal(fieldOf(platformClash, "code").message, "That code is already used on Vanta.");

        assert.equal(await Voucher.countDocuments(), 2, "only the two accepted vouchers exist");
    });

    it("6. enforces the discount-value rule per voucher type", async () => {
        const { token } = await makeSeller("value");

        const freeShipping = await createVoucher(token, { code: "SHIP01", type: "free_shipping", discountValue: 5 });
        assert.equal(freeShipping.status, 422);
        assert.equal(fieldOf(freeShipping, "discountValue").message, "A free-delivery promotion does not use a discount amount.");

        const overHundred = await createVoucher(token, { code: "PCT150", type: "percentage", discountValue: 150 });
        assert.equal(overHundred.status, 422);
        assert.equal(fieldOf(overHundred, "discountValue").message, "A percentage discount must be between 1 and 100.");

        const freeOk = await createVoucher(token, { code: "SHIP02", type: "free_shipping", discountValue: 0, perUserLimit: undefined });
        assert.equal(freeOk.status, 201, freeOk.raw);
        assert.equal(freeOk.body.data.voucher.type, "free_shipping");
        assert.equal(freeOk.body.data.voucher.discountValue, 0);
    });

    it("7. requires the expiry to be after the start date", async () => {
        const { token } = await makeSeller("window");
        const startAt = new Date(Date.now() + 7200000).toISOString();
        const response = await createVoucher(token, { startAt, expiry: new Date(Date.now() + 3600000).toISOString() });

        assert.equal(response.status, 422);
        assert.deepEqual(response.body.error.fields.map((entry) => entry.field), ["expiry"]);
        assert.equal(fieldOf(response, "expiry").message, "The expiry must be after the start date.");
    });

    it("8. enforces both maximum-discount cap rules", async () => {
        const { token } = await makeSeller("caps");

        const impossibleCap = await createVoucher(token, { minimumOrder: 100, maximumDiscount: 500 });
        assert.equal(impossibleCap.status, 422);
        assert.equal(fieldOf(impossibleCap, "maximumDiscount").message, "The cap is above the minimum spend, so it can never apply.");

        const tinyCap = await createVoucher(token, { code: "FIX50", type: "fixed", discountValue: 50, maximumDiscount: 30 });
        assert.equal(tinyCap.status, 422);
        assert.equal(fieldOf(tinyCap, "maximumDiscount").message, "The cap is lower than the discount you set.");

        const reachable = await createVoucher(token, { code: "PCT20", minimumOrder: 500, maximumDiscount: 50 });
        assert.equal(reachable.status, 201, reachable.raw);
        assert.equal(reachable.body.data.voucher.maximumDiscount, 50);
    });

    it("9. refuses to change the code or the type through PATCH", async () => {
        const { token } = await makeSeller("immutable");
        const created = await createVoucher(token, { code: "SAVE10" });
        const { id } = created.body.data.voucher;

        const response = await api("PATCH", `/seller/vouchers/${id}`, {
            token,
            body: { code: "NEWCODE", type: "fixed" }
        });

        assert.equal(response.status, 422);
        assert.deepEqual(response.body.error.fields.map((entry) => entry.field).sort(), ["code", "type"]);
        assert.equal(fieldOf(response, "code").message, "code cannot be changed.");

        const stored = await Voucher.findById(id);
        assert.equal(stored.code, "SAVE10");
        assert.equal(stored.type, "percentage");
    });

    it("10. updates the writable columns and re-derives the state", async () => {
        const { token } = await makeSeller("patch");
        const created = await createVoucher(token, { code: "SAVE10" });
        const { id } = created.body.data.voucher;

        const response = await api("PATCH", `/seller/vouchers/${id}`, {
            token,
            body: { title: "Renamed deal", minimumOrder: 250, description: "Only this weekend", active: false }
        });

        assert.equal(response.status, 200, response.raw);
        const voucher = response.body.data.voucher;
        assert.equal(voucher.title, "Renamed deal");
        assert.equal(voucher.minimumOrder, 250);
        assert.equal(voucher.description, "Only this weekend");
        assert.equal(voucher.active, false);
        assert.equal(voucher.code, "SAVE10", "the code never changes");
        assert.equal(voucher.state, "inactive");
        assert.ok(voucher.problems.includes("Disabled — customers cannot apply it."));
    });

    it("11. hard-deletes a voucher that was never used", async () => {
        const { token } = await makeSeller("delete-clean");
        const created = await createVoucher(token, { code: "GONE01" });
        const { id } = created.body.data.voucher;

        const response = await api("DELETE", `/seller/vouchers/${id}`, { token });

        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body.data, { deleted: true });
        assert.equal(await Voucher.countDocuments(), 0);
        assert.equal((await api("GET", `/seller/vouchers/${id}`, { token })).status, 404);
    });

    it("12. archives a used voucher instead of deleting it", async () => {
        const { token } = await makeSeller("delete-used");
        const created = await createVoucher(token, { code: "USED01" });
        const { id } = created.body.data.voucher;
        await Voucher.updateOne({ _id: id }, { $set: { usageCount: 3 } });

        const response = await api("DELETE", `/seller/vouchers/${id}`, { token });

        assert.equal(response.status, 200, response.raw);
        const voucher = response.body.data.voucher;
        assert.equal(voucher.active, false);
        assert.equal(voucher.usageCount, 3, "the history is kept");
        assert.equal(voucher.state, "inactive");

        const stored = await Voucher.findById(id);
        assert.ok(stored, "the row still exists");
        assert.equal(stored.active, false);
        assert.ok(new Date(stored.expiry).getTime() <= Date.now(), "the window is closed at archive time");
    });

    it("13. answers another seller's voucher id with 404, never 403", async () => {
        const owner = await makeSeller("owner");
        const thief = await makeSeller("thief");
        const created = await createVoucher(owner.token, { code: "SECRET1" });
        const { id } = created.body.data.voucher;

        const read = await api("GET", `/seller/vouchers/${id}`, { token: thief.token });
        assert.equal(read.status, 404);
        assert.equal(read.body.error.code, "not_found");
        assert.equal(read.body.error.message, "Voucher not found.");

        const patch = await api("PATCH", `/seller/vouchers/${id}`, { token: thief.token, body: { title: "Stolen" } });
        assert.equal(patch.status, 404);

        const remove = await api("DELETE", `/seller/vouchers/${id}`, { token: thief.token });
        assert.equal(remove.status, 404);
        assert.equal(await Voucher.countDocuments(), 1, "the owner's voucher is untouched");

        const own = await api("GET", `/seller/vouchers/${id}`, { token: owner.token });
        assert.equal(own.status, 200);

        const malformed = await api("GET", "/seller/vouchers/not-an-id", { token: owner.token });
        assert.equal(malformed.status, 404);
    });

    it("14. lists the seller's vouchers newest first with the derived state", async () => {
        const { token, sellerId, profile } = await makeSeller("states");
        const now = Date.now();
        const window = { startAt: new Date(now - 3600000), expiry: new Date(now + 3600000) };

        const seed = [
            ["LIVE01", { createdAt: new Date(now), usageLimit: 10, usageCount: 5 }],
            ["SCHED01", { createdAt: new Date(now - 60000), startAt: new Date(now + 3600000) }],
            ["EXH01", { createdAt: new Date(now - 120000), usageLimit: 2, usageCount: 2 }],
            ["EXP01", { createdAt: new Date(now - 180000), expiry: new Date(now - 1000) }],
            ["OFF01", { createdAt: new Date(now - 240000), active: false }]
        ];
        for (const [code, overrides] of seed) {
            await Voucher.create({
                code,
                title: `Voucher ${code}`,
                type: "percentage",
                discountValue: 10,
                minimumOrder: 0,
                scope: "seller",
                sellerId: profile._id,
                ...window,
                usageCount: 0,
                active: true,
                perUserUsed: {},
                ...overrides
            });
        }
        assert.equal(String(sellerId), String(profile._id));

        const response = await api("GET", "/seller/vouchers", { token });
        assert.equal(response.status, 200, response.raw);

        const vouchers = response.body.data.vouchers;
        assert.deepEqual(vouchers.map((entry) => entry.code), ["LIVE01", "SCHED01", "EXH01", "EXP01", "OFF01"]);
        assert.deepEqual(vouchers.map((entry) => entry.state), ["live", "scheduled", "exhausted", "expired", "inactive"]);
        assert.deepEqual(vouchers.map((entry) => entry.usedByPercent), [50, 0, 100, 0, 0]);
        assert.equal(vouchers[0].discountLabel, "10% off");
        assert.ok(vouchers[1].problems.includes("Starts later."));
        assert.ok(vouchers[2].problems.includes("Usage limit reached."));
        assert.ok(vouchers[3].problems.includes("Expired."));
        for (const voucher of vouchers) {
            assert.equal(typeof voucher.id, "string");
            assert.equal(voucher._id, undefined);
        }
    });
});

// ------------------------------------------------------------- eligibility

describe("GET /vouchers/eligible", () => {
    /** Customer + two sellers with live products, and a cart over both. */
    const buildCart = async () => {
        const customer = await registerUser("eligible");
        const sellerA = await makeSeller("cart-a");
        const sellerB = await makeSeller("cart-b");
        const sellerC = await makeSeller("cart-c");
        const category = await Category.create({ name: "Fixtures" });
        const storeA = await makeStore(sellerA.profile, { shippingFee: 60, freeShippingThreshold: 999 });
        const storeB = await makeStore(sellerB.profile, { shippingFee: 0, freeShippingThreshold: 0 });

        const a1 = await makeProduct(sellerA.profile, storeA, category, { name: "Widget", price: 500 });
        const a2 = await makeProduct(sellerA.profile, storeA, category, { name: "Gadget", price: 100 });
        const b1 = await makeProduct(sellerB.profile, storeB, category, { name: "Doohickey", price: 300 });

        await Cart.create({
            userId: customer.userId,
            items: [
                { productId: a1._id, sellerId: sellerA.profile._id, quantity: 1, selected: true, priceSnapshot: 500 },
                { productId: a2._id, sellerId: sellerA.profile._id, quantity: 1, selected: false, priceSnapshot: 100 },
                { productId: b1._id, sellerId: sellerB.profile._id, quantity: 1, selected: true, priceSnapshot: 300 }
            ]
        });

        return { customer, sellerA, sellerB, sellerC, category };
    };

    const seed = (overrides) =>
        Voucher.create({
            title: "Fixture voucher",
            type: "percentage",
            discountValue: 10,
            minimumOrder: 0,
            startAt: new Date(Date.now() - 60000),
            expiry: new Date(Date.now() + 86400000),
            usageCount: 0,
            active: true,
            perUserUsed: {},
            scope: "platform",
            sellerId: null,
            ...overrides
        });

    const quoteFor = (quotes, code) => quotes.find((quote) => quote.code === code);

    it("15. requires a session and answers an empty cart with no quotes", async () => {
        const anonymous = await api("GET", "/vouchers/eligible");
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.body.error.code, "unauthorized");

        const { token } = await registerUser("empty-cart");
        const response = await api("GET", "/vouchers/eligible", { token });

        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body.data.quotes, []);
    });

    it("16. quotes platform vouchers against the whole cart, sorted best first", async () => {
        const { customer, sellerA } = await buildCart();
        // Seller A selected lines: 500. Seller B: 300. Cart subtotal: 800.
        await seed({ code: "PLAT10" }); // 10% of 800 = 80
        await seed({ code: "PLAT05", discountValue: 5 }); // 5% of 800 = 40
        await seed({ code: "PLATBIG", type: "fixed", discountValue: 500, minimumOrder: 1000 });
        await seed({ code: "SHIP01", type: "free_shipping", discountValue: 0 });
        await seed({
            code: "SELLA",
            scope: "seller",
            sellerId: sellerA.profile._id,
            discountValue: 20 // 20% of seller A's 500 = 100
        });

        const response = await api("GET", "/vouchers/eligible", { token: customer.token });
        assert.equal(response.status, 200, response.raw);

        const quotes = response.body.data.quotes;
        assert.equal(quotes.length, 5);

        const discounts = quotes.map((quote) => quote.discount);
        assert.deepEqual(discounts, [...discounts].sort((left, right) => right - left), "sorted by discount desc");
        assert.deepEqual(quotes.slice(0, 4).map((quote) => quote.code), ["SELLA", "PLAT10", "SHIP01", "PLAT05"]);
        assert.equal(quoteFor(quotes, "SELLA").discount, 100);
        assert.equal(quoteFor(quotes, "PLAT10").discount, 80);
        assert.equal(quoteFor(quotes, "SHIP01").discount, 60, "free shipping quotes the cart's real fees");
        assert.equal(quoteFor(quotes, "PLAT05").discount, 40);

        const tooHigh = quoteFor(quotes, "PLATBIG");
        assert.equal(tooHigh.valid, false);
        assert.equal(tooHigh.reason, "Minimum 1000 required");
        assert.equal(tooHigh.discount, 0);

        for (const quote of quotes) {
            assert.equal(typeof quote.id, "string");
            assert.equal(typeof quote.code, "string");
            assert.equal(typeof quote.title, "string");
            assert.equal(quote.type.length > 0, true);
            assert.ok(["platform", "seller"].includes(quote.scope));
            assert.ok(!("_id" in quote));
            assert.ok(Number.isFinite(Date.parse(quote.expiry)));
            assert.equal(typeof quote.valid, "boolean");
            assert.equal(typeof quote.discount, "number");
            // The cart/vouchers screens render the scope label from these.
            assert.ok("categoryId" in quote);
            assert.ok(Array.isArray(quote.productIds));
            assert.equal(typeof quote.description, "string");
        }
    });

    it("19. echoes the scope fields the cart screen labels (category, products, description)", async () => {
        const { customer, category } = await buildCart();
        await seed({
            code: "PROD01",
            productIds: ["prod-limited-1", "prod-limited-2"],
            categoryId: category._id,
            description: "Only for the fixtures"
        });

        const response = await api("GET", "/vouchers/eligible", { token: customer.token });
        assert.equal(response.status, 200, response.raw);
        const quote = quoteFor(response.body.data.quotes, "PROD01");
        assert.ok(quote, "an out-of-scope voucher is still quoted, flagged invalid");
        assert.deepEqual(quote.productIds, ["prod-limited-1", "prod-limited-2"]);
        assert.equal(quote.categoryId, String(category._id));
        assert.equal(quote.description, "Only for the fixtures");
    });

    it("17. scopes seller vouchers to that seller's SELECTED lines and minimum", async () => {
        const { customer, sellerA, sellerC } = await buildCart();
        await seed({ code: "SELLA", scope: "seller", sellerId: sellerA.profile._id, discountValue: 20 });
        await seed({ code: "SELLMIN", scope: "seller", sellerId: sellerA.profile._id, type: "fixed", discountValue: 50, minimumOrder: 600 });
        await seed({ code: "SELLC", scope: "seller", sellerId: sellerC.profile._id, discountValue: 15 });

        const response = await api("GET", "/vouchers/eligible", { token: customer.token });
        assert.equal(response.status, 200, response.raw);
        const quotes = response.body.data.quotes;
        assert.equal(quotes.length, 3);

        // Seller A's selected lines total 500 — the deselected 100 line does not count.
        const valid = quoteFor(quotes, "SELLA");
        assert.equal(valid.valid, true);
        assert.equal(valid.sellerId, String(sellerA.profile._id));
        assert.equal(valid.discount, 100);

        const belowMinimum = quoteFor(quotes, "SELLMIN");
        assert.equal(belowMinimum.valid, false);
        assert.equal(belowMinimum.reason, "Minimum 600 required");

        const otherSeller = quoteFor(quotes, "SELLC");
        assert.equal(otherSeller.valid, false);
        assert.equal(otherSeller.reason, "Applies to a different seller");
    });

    it("18. blocks a per-user spent limit and an exhausted usage limit with reasons", async () => {
        const { customer } = await buildCart();
        await seed({ code: "ONCE01", perUserLimit: 1, perUserUsed: { [customer.userId]: 1 } });
        await seed({ code: "FULL01", usageLimit: 2, usageCount: 2 });

        const response = await api("GET", "/vouchers/eligible", { token: customer.token });
        assert.equal(response.status, 200, response.raw);
        const quotes = response.body.data.quotes;
        assert.equal(quotes.length, 2);

        const perUser = quoteFor(quotes, "ONCE01");
        assert.equal(perUser.valid, false);
        assert.equal(perUser.reason, "Already used");
        assert.equal(perUser.discount, 0);

        const exhausted = quoteFor(quotes, "FULL01");
        assert.equal(exhausted.valid, false);
        assert.equal(exhausted.reason, "Usage limit reached");
        assert.equal(exhausted.discount, 0);
    });
});

// ------------------------------------------------------------- atomic markUsed

describe("markUsed atomic redemption", () => {
    const window = {
        startAt: new Date(Date.now() - 60000),
        expiry: new Date(Date.now() + 86400000),
        active: true,
        perUserUsed: {}
    };

    it("refuses a redemption that would cross the usage limit", async () => {
        const voucher = await Voucher.create({
            ...window,
            code: "MARKLIMIT",
            title: "Two uses",
            type: "percentage",
            discountValue: 10,
            usageLimit: 2,
            usageCount: 2
        });

        await assert.rejects(
            markUsed(voucher._id, "someone"),
            (error) => error.statusCode === 422 && error.message === "Usage limit reached"
        );
        const stored = await Voucher.findById(voucher._id);
        assert.equal(stored.usageCount, 2, "nothing is incremented past the limit");
    });

    it("refuses a redemption that would cross the per-customer limit", async () => {
        const spent = String(new mongoose.Types.ObjectId());
        const voucher = await Voucher.create({
            ...window,
            code: "MARKPERUSER",
            title: "One each",
            type: "percentage",
            discountValue: 10,
            perUserLimit: 1,
            perUserUsed: { [spent]: 1 }
        });

        await assert.rejects(
            markUsed(voucher._id, spent),
            (error) => error.statusCode === 422 && error.message === "Usage limit reached"
        );
    });

    it("increments both tallies in one operation when within the limits", async () => {
        const voucher = await Voucher.create({
            ...window,
            code: "MARKROOM",
            title: "Plenty of room",
            type: "percentage",
            discountValue: 10,
            usageLimit: 10,
            perUserLimit: 3
        });

        const first = await markUsed(voucher._id, "ada");
        assert.equal(first.usageCount, 1);
        assert.equal(first.perUserUsed, undefined, "the DTO never exposes the per-user tally");
        let stored = await Voucher.findById(voucher._id);
        assert.equal(stored.perUserUsed["ada"], 1);

        const second = await markUsed(voucher._id, "ada");
        assert.equal(second.usageCount, 2);
        stored = await Voucher.findById(voucher._id);
        assert.equal(stored.perUserUsed["ada"], 2);
    });
});
