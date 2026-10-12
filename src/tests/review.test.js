/**
 * Reviews suite (slice "reviews", milestone M12).
 *
 * Runs against a dedicated `vanta_review_test` database and an ephemeral port,
 * asserting what a client observes: status, envelope, the simulator's exact
 * messages, ownership (IDOR = 404), the rating denormalisation on Product and
 * Store, the seller/customer notification rows, the seller scope and the
 * reply rules.
 *
 * Run JUST this file:
 *
 *     node --test src/tests/review.test.js
 *
 * The slice router is not wired into `src/app.js` yet (a coordinator does that
 * once every slice lands), so the suite stands up the same stack `app.js`
 * builds — request id, body parsers, cookie parser, the identity router — plus
 * this slice's router, then the same JSON 404/error handlers.
 *
 * The suite drops `vanta_review_test` when it finishes; it never touches the
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
import reviewRouter from "../routes/review.route.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Product } from "../models/product.model.js";
import { Order } from "../models/order.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { Review } from "../models/review.model.js";
import { Notification } from "../models/notification.model.js";

const PASSWORD = "Sup3rSecret!";
const HEADLINE = "Exactly what I expected";
const BODY = "Held up beautifully after a week of daily use.";

let server;
let origin;
let sequence = 0;
let lineSequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `review-${label}-${++sequence}-${Date.now()}@example.com`;

/** The same stack `app.js` builds, plus the slice router under test. */
const buildApp = () => {
    const instance = express();
    instance.disable("x-powered-by");
    instance.use(requestId);
    instance.use(express.urlencoded({ limit: "16kb", extended: true }));
    instance.use(express.json({ limit: "16kb" }));
    instance.use(cookieParser());
    instance.use("/api/v1/auth", userRouter);
    instance.use("/api/v1", reviewRouter);
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

const registerUser = async (label, overrides = {}) => {
    const email = uniqueEmail(label);
    const response = await api("POST", "/auth/register", {
        body: {
            name: "Ada Lovelace",
            email,
            phone: "01712345678",
            password: PASSWORD,
            ...overrides
        }
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

/**
 * An order + seller order written straight through the models, so a line can
 * start life `delivered` (or `pending`) without walking the fulfilment flow.
 * `items` keep the snapshot shape checkout writes, including the `hasReview`
 * flags this slice stamps.
 */
const placeOrder = async ({ customer, seller, products, itemStatus = "delivered", orderStatus = "delivered" }) => {
    const items = products.map((product) => ({
        id: `line-${++lineSequence}`,
        productId: String(product._id),
        productName: product.name,
        brand: product.brand ?? "",
        image: (product.images ?? [])[0] ?? "",
        variantId: null,
        variantAttributes: null,
        unitPrice: product.salePrice ?? product.regularPrice,
        discount: 0,
        quantity: 1,
        subtotal: product.salePrice ?? product.regularPrice,
        status: itemStatus,
        reviewId: null,
        hasReview: false,
        returnRequestId: null,
        returnedQuantity: 0,
        remainingQuantity: null
    }));
    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const delivered = orderStatus === "delivered";

    const order = await Order.create({
        customerId: customer.user.id,
        orderCode: `ORD-${Date.now()}-${++sequence}`,
        status: orderStatus,
        sellerOrderIds: [],
        subtotal,
        shippingTotal: 0,
        vouchersDiscount: 0,
        total: subtotal,
        paymentMethod: "cod",
        paymentStatus: delivered ? "paid" : "pending",
        deliveryMethod: "standard",
        shippingAddress: { ...ADDRESS },
        placedAt: new Date(),
        deliveredAt: delivered ? new Date() : null
    });

    const sellerOrder = await SellerOrder.create({
        orderId: order._id,
        sellerId: seller.profile._id,
        storeId: seller.store._id,
        storeName: seller.store.name,
        status: orderStatus,
        items,
        subtotal,
        shippingFee: 0,
        total: subtotal,
        shippingAddress: { ...ADDRESS },
        timeline: [{ status: orderStatus, at: new Date() }],
        fulfilledAt: delivered ? new Date() : null
    });

    order.sellerOrderIds = [String(sellerOrder._id)];
    await order.save();

    return { order, sellerOrder, items, orderCode: order.orderCode };
};

const reviewBody = (orderItemId, overrides = {}) => ({
    orderItemId,
    rating: 5,
    title: HEADLINE,
    text: BODY,
    ...overrides
});

const postReview = (token, body) => api("POST", "/reviews", { token, body });

const assertNoMongoIds = (raw, label) => {
    assert.ok(!raw.includes("\"_id\""), `${label} must not expose _id`);
    assert.ok(!raw.includes("\"__v\""), `${label} must not expose __v`);
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the review suite");

    await mongoose.connect(`${base}/vanta_review_test`);

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

// ------------------------------------------------------------ eligible lines

describe("eligible lines", () => {
    it("lists the caller's delivered, un-reviewed lines only — newest order first", async () => {
        const seller = await makeSeller("eligible");
        const customer = await registerUser("eligible-customer");
        const other = await registerUser("eligible-other");
        const productA = await makeProduct(seller);
        const productB = await makeProduct(seller, { name: "Ceramic Mug", sku: `MUG-${++sequence}` });

        const mine = await placeOrder({ customer, seller, products: [productA, productB] });
        await placeOrder({ customer: other, seller, products: [productA] });

        // The first line is already reviewed, so it must drop out of the list.
        const created = await postReview(customer.token, reviewBody(mine.items[0].id));
        assert.equal(created.status, 201, created.raw);

        const response = await api("GET", "/reviews/eligible", { token: customer.token });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.ok, true);
        const { items } = response.body.data;
        assert.equal(items.length, 1, "reviewed lines and other people's lines are excluded");

        const entry = items[0];
        assert.equal(entry.orderItemId, mine.items[1].id);
        assert.equal(entry.orderId, String(mine.order._id));
        assert.equal(entry.sellerOrderId, String(mine.sellerOrder._id));
        assert.equal(entry.orderNumber, mine.orderCode);
        assert.equal(entry.productId, String(productB._id));
        assert.equal(entry.productName, "Ceramic Mug");
        assert.deepEqual(entry.product, {
            id: String(productB._id),
            name: "Ceramic Mug",
            image: productB.images[0]
        });
        assert.equal(entry.status, "delivered");
        assertNoMongoIds(response.raw, "eligible response");

        // A different customer sees their own line and never this one.
        const foreign = await api("GET", "/reviews/eligible", { token: other.token });
        assert.equal(foreign.status, 200, foreign.raw);
        assert.equal(foreign.body.data.items.length, 1);
        assert.notEqual(foreign.body.data.items[0].orderItemId, mine.items[1].id);
    });

    it("excludes lines that are not delivered yet", async () => {
        const seller = await makeSeller("eligible-pending");
        const customer = await registerUser("eligible-pending-customer");
        const product = await makeProduct(seller);
        const pending = await placeOrder({
            customer,
            seller,
            products: [product],
            itemStatus: "pending",
            orderStatus: "placed"
        });

        const response = await api("GET", "/reviews/eligible", { token: customer.token });

        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body.data.items, [], "a pending line is not reviewable");
        assert.ok(!response.raw.includes(pending.items[0].id));
    });
});

// ---------------------------------------------------------------- creation

describe("creating a review", () => {
    it("creates a review, recomputes product and store ratings, stamps the line and notifies the seller", async () => {
        const seller = await makeSeller("create");
        const customer = await registerUser("create-customer");
        const product = await makeProduct(seller);
        const { items, sellerOrder } = await placeOrder({ customer, seller, products: [product] });

        const response = await postReview(customer.token, reviewBody(items[0].id, { rating: 4 }));

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.meta.message, "Review created.");
        assertNoMongoIds(response.raw, "create response");

        const review = response.body.data.review;
        assert.equal(typeof review.id, "string");
        assert.equal(review.rating, 4);
        assert.equal(review.title, HEADLINE);
        assert.equal(review.text, BODY);
        assert.equal(review.userName, "Ada Lovelace");
        assert.equal(review.orderItemId, items[0].id);
        assert.equal(review.orderId, String((await Order.findOne({}))._id));
        assert.equal(review.productId, String(product._id));
        assert.equal(review.sellerId, String(seller.profile._id));
        assert.equal(review.verifiedPurchase, true, "a delivered line is a verified purchase");
        assert.equal(review.sellerReply, null);
        assert.ok(review.createdAt, "timestamps are exposed");

        // The mean the simulator writes back: sum / count, no rounding.
        const expectedAvg = 4 / 1;
        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.ratingCount, 1);
        assert.equal(productAfter.ratingAvg, expectedAvg);

        const storeAfter = await Store.findById(seller.store._id);
        assert.equal(storeAfter.ratingCount, 1, "the store counter is denormalised too");
        assert.equal(storeAfter.ratingAvg, expectedAvg);

        // The order line carries the review, exactly as the simulator stamps it.
        const line = await SellerOrder.findById(sellerOrder._id);
        assert.equal(line.items[0].hasReview, true);
        assert.equal(line.items[0].reviewId, review.id);

        // The seller is notified with the simulator's wording.
        const note = await Notification.findOne({ type: "seller_review_received" });
        assert.ok(note, "a seller_review_received notification exists");
        assert.equal(String(note.userId), String(seller.profile.userId));
        assert.equal(note.title, "New Review");
        assert.equal(note.body, `Ada Lovelace reviewed "${product.name}".`);
        assert.equal(note.data.reviewId, review.id);
        assert.equal(note.data.productId, String(product._id));
    });

    it("refuses a second review of the same line with the simulator's message", async () => {
        const seller = await makeSeller("duplicate");
        const customer = await registerUser("duplicate-customer");
        const product = await makeProduct(seller);
        const { items } = await placeOrder({ customer, seller, products: [product] });

        const first = await postReview(customer.token, reviewBody(items[0].id));
        assert.equal(first.status, 201, first.raw);

        const second = await postReview(customer.token, reviewBody(items[0].id, { rating: 1 }));

        assert.equal(second.status, 422, second.raw);
        assert.equal(second.body.ok, false);
        assert.equal(second.body.error.code, "validation_failed");
        assert.equal(second.body.error.message, "You already reviewed this item.");
        assert.equal(await Review.countDocuments({}), 1, "only the first review exists");
    });

    it("refuses a pending line, a foreign line and an unknown line with their own messages", async () => {
        const seller = await makeSeller("guard");
        const customer = await registerUser("guard-customer");
        const other = await registerUser("guard-other");
        const product = await makeProduct(seller);

        const pending = await placeOrder({
            customer,
            seller,
            products: [product],
            itemStatus: "pending",
            orderStatus: "placed"
        });
        const notDelivered = await postReview(customer.token, reviewBody(pending.items[0].id));
        assert.equal(notDelivered.status, 422, notDelivered.raw);
        assert.equal(notDelivered.body.error.code, "validation_failed");
        assert.equal(notDelivered.body.error.message, "This item has not been delivered yet.");

        const foreignOrder = await placeOrder({ customer: other, seller, products: [product] });
        const notMine = await postReview(customer.token, reviewBody(foreignOrder.items[0].id));
        assert.equal(notMine.status, 422, notMine.raw);
        assert.equal(notMine.body.error.message, "You can only review your own delivered items.");

        const unknown = await postReview(customer.token, reviewBody("line-that-never-existed"));
        assert.equal(unknown.status, 422, unknown.raw);
        assert.equal(unknown.body.error.message, "Order item not found.");

        assert.equal(await Review.countDocuments({}), 0, "no rejected review is written");
    });

    it("rejects out-of-range ratings and short text, reporting every field in one 422", async () => {
        const seller = await makeSeller("validation");
        const customer = await registerUser("validation-customer");
        const product = await makeProduct(seller);
        const { items } = await placeOrder({ customer, seller, products: [product] });

        const low = await postReview(customer.token, reviewBody(items[0].id, { rating: 0 }));
        assert.equal(low.status, 422, low.raw);
        assert.equal(low.body.error.code, "validation_failed");
        assert.equal(low.body.error.message, "Choose a rating between 1 and 5.");
        assert.deepEqual(low.body.error.fields, [
            { field: "rating", message: "Choose a rating between 1 and 5." }
        ]);

        const high = await postReview(customer.token, reviewBody(items[0].id, { rating: 6 }));
        assert.equal(high.status, 422, high.raw);
        assert.equal(high.body.error.message, "Choose a rating between 1 and 5.");

        const shortText = await postReview(customer.token, reviewBody(items[0].id, { text: "too short" }));
        assert.equal(shortText.status, 422, shortText.raw);
        assert.equal(shortText.body.error.message, "Tell other shoppers a little more (at least 10 characters).");
        assert.equal(shortText.body.error.fields[0].field, "text");

        const noTitle = await postReview(customer.token, reviewBody(items[0].id, { title: " x " }));
        assert.equal(noTitle.status, 422, noTitle.raw);
        assert.equal(noTitle.body.error.message, "Add a short headline for your review.");

        // Every problem at once, led by the rule the simulator checks first.
        const both = await postReview(customer.token, reviewBody(items[0].id, { rating: 9, text: "short" }));
        assert.equal(both.status, 422, both.raw);
        assert.deepEqual(both.body.error.fields.map((entry) => entry.field), ["rating", "text"]);
        assert.equal(both.body.error.message, "Choose a rating between 1 and 5.");

        assert.equal(await Review.countDocuments({}), 0, "a rejected body writes nothing");
    });

    it("requires an authenticated session", async () => {
        const seller = await makeSeller("auth");
        const customer = await registerUser("auth-customer");
        const product = await makeProduct(seller);
        const { items } = await placeOrder({ customer, seller, products: [product] });

        const response = await postReview(undefined, reviewBody(items[0].id));

        assert.equal(response.status, 401, response.raw);
        assert.equal(response.body.error.code, "unauthorized");
    });
});

// ------------------------------------------------------- editing & deleting

describe("editing and deleting", () => {
    let seller;
    let customer;
    let other;
    let product;
    let placed;
    let firstReview;
    let secondReview;

    beforeEach(async () => {
        seller = await makeSeller("edit");
        customer = await registerUser("edit-customer");
        other = await registerUser("edit-other");
        product = await makeProduct(seller);

        // Two lines of the SAME product, so the two reviews share one aggregate.
        placed = await placeOrder({ customer, seller, products: [product, product] });

        const first = await postReview(customer.token, reviewBody(placed.items[0].id, { rating: 5 }));
        assert.equal(first.status, 201, first.raw);
        firstReview = first.body.data.review;

        const second = await postReview(customer.token, reviewBody(placed.items[1].id, { rating: 4 }));
        assert.equal(second.status, 201, second.raw);
        secondReview = second.body.data.review;
    });

    it("updates the author's rating and recomputes both aggregates", async () => {
        const response = await api("PATCH", `/reviews/${secondReview.id}`, {
            token: customer.token,
            body: { rating: 2 }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.meta.message, "Review updated.");
        assert.equal(response.body.data.review.rating, 2);
        assertNoMongoIds(response.raw, "patch response");

        const expectedAvg = (5 + 2) / 2;
        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.ratingCount, 2);
        assert.equal(productAfter.ratingAvg, expectedAvg);

        const storeAfter = await Store.findById(seller.store._id);
        assert.equal(storeAfter.ratingCount, 2);
        assert.equal(storeAfter.ratingAvg, expectedAvg);
    });

    it("404s a foreign review on PATCH and DELETE (IDOR guard)", async () => {
        const patch = await api("PATCH", `/reviews/${firstReview.id}`, {
            token: other.token,
            body: { rating: 1 }
        });
        assert.equal(patch.status, 404, patch.raw);
        assert.equal(patch.body.error.code, "not_found");
        assert.equal(patch.body.error.message, "Review not found.");

        const remove = await api("DELETE", `/reviews/${firstReview.id}`, { token: other.token });
        assert.equal(remove.status, 404, remove.raw);
        assert.equal(remove.body.error.message, "Review not found.");

        assert.equal(await Review.countDocuments({}), 2, "both reviews are untouched");
        const stored = await Review.findById(firstReview.id);
        assert.equal(stored.rating, 5, "the rating did not move");
    });

    it("deletes the author's review, recomputes the aggregates down and clears the line flag", async () => {
        const response = await api("DELETE", `/reviews/${secondReview.id}`, { token: customer.token });

        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body.data, { deleted: true });
        assertNoMongoIds(response.raw, "delete response");

        const expectedAvg = 5 / 1;
        const productAfter = await Product.findById(product._id);
        assert.equal(productAfter.ratingCount, 1);
        assert.equal(productAfter.ratingAvg, expectedAvg);

        const line = await SellerOrder.findById(placed.sellerOrder._id);
        assert.equal(line.items[1].hasReview, false, "the line flag is cleared");
        assert.equal(line.items[1].reviewId, null);

        // Removing the last review empties the counters, the simulator's 0/0.
        const second = await api("DELETE", `/reviews/${firstReview.id}`, { token: customer.token });
        assert.equal(second.status, 200, second.raw);

        const emptied = await Product.findById(product._id);
        assert.equal(emptied.ratingCount, 0);
        assert.equal(emptied.ratingAvg, 0);

        const storeAfter = await Store.findById(seller.store._id);
        assert.equal(storeAfter.ratingCount, 0);
        assert.equal(storeAfter.ratingAvg, 0);
    });
});

// -------------------------------------------------------- public product page

describe("product reviews", () => {
    let seller;
    let customer;
    let product;
    let placed;

    beforeEach(async () => {
        seller = await makeSeller("public");
        customer = await registerUser("public-customer", { name: "Grace Hopper" });
        product = await makeProduct(seller);
        placed = await placeOrder({ customer, seller, products: [product, product] });

        const first = await postReview(customer.token, reviewBody(placed.items[0].id, { rating: 5 }));
        assert.equal(first.status, 201, first.raw);
        const second = await postReview(customer.token, reviewBody(placed.items[1].id, { rating: 4 }));
        assert.equal(second.status, 201, second.raw);
    });

    it("lists reviews newest first with reviewer names, totals and pagination", async () => {
        const response = await api("GET", `/catalog/products/${product._id}/reviews`);

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.ok, true);
        assertNoMongoIds(response.raw, "product reviews");

        const { reviews, total, ratingAvg, ratingCount } = response.body.data;
        assert.equal(total, 2);
        assert.equal(ratingCount, 2);
        assert.equal(ratingAvg, (5 + 4) / 2, "the mean is unrounded, like the simulator's breakdown");
        assert.equal(reviews.length, 2);
        assert.equal(reviews[0].rating, 4, "the newest review comes first");

        // The simulator renders `review.userName` verbatim (no masking anywhere),
        // so the stored display name travels back exactly as written.
        assert.equal(reviews[0].userName, "Grace Hopper");
        assert.equal(reviews[0].title, HEADLINE);
        assert.equal(reviews[0].text, BODY);
        assert.equal(reviews[0].verifiedPurchase, true);
        assert.ok(reviews[0].createdAt);

        const page = await api("GET", `/catalog/products/${product._id}/reviews?limit=1&offset=1`);
        assert.equal(page.status, 200, page.raw);
        assert.equal(page.body.data.reviews.length, 1, "one row per page");
        assert.equal(page.body.data.total, 2, "total counts every review, not the page");
        assert.equal(page.body.data.reviews[0].rating, 5, "offset walks past the newest row");
    });

    it("404s an unknown, malformed or invisible product", async () => {
        const unknown = await api("GET", "/catalog/products/64b000000000000000000000/reviews");
        assert.equal(unknown.status, 404, unknown.raw);
        assert.equal(unknown.body.error.code, "not_found");
        assert.equal(unknown.body.error.message, "Product not found.");

        const malformed = await api("GET", "/catalog/products/not-an-id/reviews");
        assert.equal(malformed.status, 404, malformed.raw);
        assert.equal(malformed.body.error.message, "Product not found.");

        // A draft is invisible to buyers, so its reviews are unreachable too.
        const draft = await makeProduct(seller, { status: "draft", name: "Hidden Draft" });
        const hidden = await api("GET", `/catalog/products/${draft._id}/reviews`);
        assert.equal(hidden.status, 404, hidden.raw);
        assert.equal(hidden.body.error.message, "Product not found.");
    });
});

// ------------------------------------------------------- seller review surface

describe("seller review surface", () => {
    let sellerA;
    let sellerB;
    let customer;
    let productA;
    let productB;
    let orderA;
    let reviewA;
    let reviewB;

    beforeEach(async () => {
        sellerA = await makeSeller("surface-a");
        sellerB = await makeSeller("surface-b");
        customer = await registerUser("surface-customer");
        productA = await makeProduct(sellerA);
        productB = await makeProduct(sellerB, { name: "Ceramic Vase", sku: `CER-${++sequence}` });

        orderA = await placeOrder({ customer, seller: sellerA, products: [productA] });
        const orderB = await placeOrder({ customer, seller: sellerB, products: [productB] });

        const first = await postReview(customer.token, reviewBody(orderA.items[0].id, { rating: 5 }));
        assert.equal(first.status, 201, first.raw);
        reviewA = first.body.data.review;

        const second = await postReview(customer.token, reviewBody(orderB.items[0].id, { rating: 2 }));
        assert.equal(second.status, 201, second.raw);
        reviewB = second.body.data.review;
    });

    it("scopes the list to this seller's own products and carries the seller view fields", async () => {
        const listA = await api("GET", "/seller/reviews", { token: sellerA.token });

        assert.equal(listA.status, 200, listA.raw);
        assertNoMongoIds(listA.raw, "seller reviews");
        assert.equal(listA.body.data.reviews.length, 1, "only this seller's product reviews");

        const view = listA.body.data.reviews[0];
        assert.equal(view.id, reviewA.id);
        assert.equal(view.productId, String(productA._id));
        assert.equal(view.productName, "Aurora Wireless Headphones");
        assert.equal(view.rating, 5);
        assert.equal(view.userName, "Ada Lovelace");
        assert.equal(view.orderCode, orderA.orderCode);
        assert.equal(view.verified, true);
        assert.equal(view.hasReply, false);
        assert.equal(view.replyText, null);
        assert.equal(view.listingStatus, "live");

        const listB = await api("GET", "/seller/reviews", { token: sellerB.token });
        assert.equal(listB.status, 200, listB.raw);
        assert.equal(listB.body.data.reviews.length, 1);
        assert.equal(listB.body.data.reviews[0].id, reviewB.id, "B's own review, not A's");
    });

    it("filters by reply status, rating and search", async () => {
        const awaiting = await api("GET", "/seller/reviews?reply=awaiting", { token: sellerA.token });
        assert.equal(awaiting.status, 200, awaiting.raw);
        assert.equal(awaiting.body.data.reviews.length, 1, "nothing answered yet");

        const wrongRating = await api("GET", "/seller/reviews?rating=3", { token: sellerA.token });
        assert.equal(wrongRating.status, 200, wrongRating.raw);
        assert.deepEqual(wrongRating.body.data.reviews, []);

        const rightRating = await api("GET", "/seller/reviews?rating=5", { token: sellerA.token });
        assert.equal(rightRating.body.data.reviews.length, 1);

        const search = await api("GET", "/seller/reviews?search=ceramic", { token: sellerA.token });
        assert.equal(search.body.data.reviews.length, 0, "A does not carry B's vase");

        const searchMine = await api("GET", "/seller/reviews?search=aurora", { token: sellerA.token });
        assert.equal(searchMine.body.data.reviews.length, 1);
    });

    it("accepts a reply, notifies the reviewer, and a second reply replaces the first", async () => {
        const first = await api("POST", `/seller/reviews/${reviewA.id}/reply`, {
            token: sellerA.token,
            body: { reply: "Thanks for the kind words!" }
        });

        assert.equal(first.status, 200, first.raw);
        assert.equal(first.body.meta.message, "Reply saved.");
        assertNoMongoIds(first.raw, "reply response");
        assert.equal(first.body.data.review.sellerReply.text, "Thanks for the kind words!");
        assert.ok(first.body.data.review.sellerReply.at, "the reply is stamped");

        const note = await Notification.findOne({ type: "review_reply" });
        assert.ok(note, "the customer is notified of the reply");
        assert.equal(String(note.userId), String(customer.user.id));
        assert.equal(note.title, "Seller replied to your review");
        assert.equal(note.body, `${sellerA.store.name} replied on "${productA.name}".`);
        assert.equal(note.data.reviewId, reviewA.id);
        assert.equal(note.data.productId, String(productA._id));

        // The reply-status filters flip once answered.
        const awaiting = await api("GET", "/seller/reviews?reply=awaiting", { token: sellerA.token });
        assert.equal(awaiting.body.data.reviews.length, 0);
        const replied = await api("GET", "/seller/reviews?reply=replied", { token: sellerA.token });
        assert.equal(replied.body.data.reviews.length, 1);

        // The simulator has NO "already replied" error: a re-reply overwrites.
        const second = await api("POST", `/seller/reviews/${reviewA.id}/reply`, {
            token: sellerA.token,
            body: { reply: "Updated: the batch issue is fixed for everyone." }
        });
        assert.equal(second.status, 200, second.raw);
        assert.equal(second.body.data.review.sellerReply.text, "Updated: the batch issue is fixed for everyone.");
        assert.equal(await Review.countDocuments({}), 2, "still one row per line");
        assert.equal(
            await Notification.countDocuments({ type: "review_reply" }),
            2,
            "every reply notifies, as the simulator does"
        );
    });

    it("rejects a too-short reply with the simulator's message", async () => {
        const response = await api("POST", `/seller/reviews/${reviewA.id}/reply`, {
            token: sellerA.token,
            body: { reply: "ok" }
        });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.message, "Write a slightly longer reply (at least 5 characters).");
        assert.deepEqual(response.body.error.fields, [
            { field: "reply", message: "Write a slightly longer reply (at least 5 characters)." }
        ]);
        assert.equal(await Notification.countDocuments({ type: "review_reply" }), 0);
    });

    it("404s another seller's review on read and reply, and gates the surface behind requireSeller", async () => {
        const read = await api("GET", `/seller/reviews/${reviewB.id}`, { token: sellerA.token });
        assert.equal(read.status, 404, read.raw);
        assert.equal(read.body.error.code, "not_found");
        assert.equal(read.body.error.message, "Review not found.");

        const reply = await api("POST", `/seller/reviews/${reviewB.id}/reply`, {
            token: sellerA.token,
            body: { reply: "This is not my product." }
        });
        assert.equal(reply.status, 404, reply.raw);
        assert.equal(reply.body.error.message, "Review not found.");

        const stored = await Review.findById(reviewB.id);
        assert.equal(stored.sellerReply, null, "no reply was written");

        const unknown = await api("GET", "/seller/reviews/64b000000000000000000000", { token: sellerA.token });
        assert.equal(unknown.status, 404, unknown.raw);

        const customerList = await api("GET", "/seller/reviews", { token: customer.token });
        assert.equal(customerList.status, 403, customerList.raw);
        assert.equal(customerList.body.error.code, "forbidden");
        assert.equal(customerList.body.error.message, "You do not have a seller account.");
    });
});

// ------------------------------------------------------------------ my reviews

describe("my reviews", () => {
    it("lists only the caller's own reviews, newest first", async () => {
        const seller = await makeSeller("mine");
        const customer = await registerUser("mine-customer");
        const other = await registerUser("mine-other");
        const product = await makeProduct(seller);

        const mine = await placeOrder({ customer, seller, products: [product, product] });
        const theirs = await placeOrder({ customer: other, seller, products: [product] });

        const first = await postReview(customer.token, reviewBody(mine.items[0].id, { rating: 5 }));
        assert.equal(first.status, 201, first.raw);
        const second = await postReview(customer.token, reviewBody(mine.items[1].id, { rating: 3 }));
        assert.equal(second.status, 201, second.raw);
        const foreign = await postReview(other.token, reviewBody(theirs.items[0].id, { rating: 1 }));
        assert.equal(foreign.status, 201, foreign.raw);

        const response = await api("GET", "/reviews/mine", { token: customer.token });

        assert.equal(response.status, 200, response.raw);
        assertNoMongoIds(response.raw, "my reviews");
        const { reviews } = response.body.data;
        assert.equal(reviews.length, 2, "the other customer's review is not mine");
        assert.equal(reviews[0].id, second.body.data.review.id, "newest first");
        assert.deepEqual(reviews.map((entry) => entry.rating), [3, 5]);
        for (const review of reviews) {
            assert.equal(review.userId, customer.user.id);
        }
    });

    it("requires an authenticated session", async () => {
        const response = await api("GET", "/reviews/eligible");
        assert.equal(response.status, 401, response.raw);
        assert.equal(response.body.error.code, "unauthorized");

        const mine = await api("GET", "/reviews/mine");
        assert.equal(mine.status, 401, mine.raw);
    });
});

// ------------------------------------------------- remote submit (M17.1)

/**
 * The remote client's `ReviewService.create` POSTs the line id plus the four
 * optional cross-check ids it holds in its local mirror (`orderId`,
 * `sellerOrderId`, `productId`, `sellerId`). These tests pin that exact request
 * shape: it must persist, then be served everywhere the review surfaces read.
 */
describe("remote submit with the client's match ids", () => {
    it("persists the review, then serves it to the product page, my-reviews and eligibility", async () => {
        const seller = await makeSeller("remote-submit");
        const customer = await registerUser("remote-submit-customer");
        const product = await makeProduct(seller);
        const placed = await placeOrder({ customer, seller, products: [product] });

        const body = reviewBody(placed.items[0].id, {
            orderId: String(placed.order._id),
            sellerOrderId: String(placed.sellerOrder._id),
            productId: String(product._id),
            sellerId: String(seller.profile._id)
        });

        const created = await postReview(customer.token, body);
        assert.equal(created.status, 201, created.raw);
        const review = created.body.data.review;

        assert.equal(await Review.countDocuments({}), 1, "the review survived the write");

        const page = await api("GET", `/catalog/products/${product._id}/reviews`);
        assert.equal(page.status, 200, page.raw);
        assert.deepEqual(page.body.data.reviews.map((entry) => entry.id), [review.id]);

        const mine = await api("GET", "/reviews/mine", { token: customer.token });
        assert.deepEqual(mine.body.data.reviews.map((entry) => entry.id), [review.id]);

        const eligible = await api("GET", "/reviews/eligible", { token: customer.token });
        assert.deepEqual(eligible.body.data.items, [], "a reviewed line leaves the eligible list");
    });

    it("rejects a body whose cross-check id does not match the delivered line", async () => {
        const seller = await makeSeller("remote-mismatch");
        const customer = await registerUser("remote-mismatch-customer");
        const product = await makeProduct(seller);
        const placed = await placeOrder({ customer, seller, products: [product] });

        const response = await postReview(
            customer.token,
            reviewBody(placed.items[0].id, { productId: new mongoose.Types.ObjectId().toString() })
        );

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.message, "This review does not match the delivered order item.");
        assert.equal(await Review.countDocuments({}), 0);
    });

    it("still refuses a foreign line and an unauthenticated submit", async () => {
        const seller = await makeSeller("remote-guard");
        const customer = await registerUser("remote-guard-customer");
        const other = await registerUser("remote-guard-other");
        const product = await makeProduct(seller);
        const placed = await placeOrder({ customer, seller, products: [product] });

        const foreign = await postReview(other.token, reviewBody(placed.items[0].id));
        assert.equal(foreign.status, 422, foreign.raw);
        assert.equal(foreign.body.error.message, "You can only review your own delivered items.");

        const anonymous = await postReview(undefined, reviewBody(placed.items[0].id));
        assert.equal(anonymous.status, 401, anonymous.raw);
        assert.equal(anonymous.body.error.code, "unauthorized");

        assert.equal(await Review.countDocuments({}), 0);
    });
});
