/**
 * Store-follow foundation suite (M13).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_follow_test` database, so every assertion is about what a client
 * would actually observe: status, envelope, error code, and the
 * `{ following, followerCount }` / `{ stores }` shapes.
 *
 * Run: node --test src/tests/follow.test.js
 *
 * The suite drops `vanta_follow_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import followRouter from "../routes/follow.route.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { StoreFollower } from "../models/store-follower.model.js";
import { toStoreDto } from "../services/seller.service.js";
import { storeFollowerRepository } from "../repositories/store-follower.repository.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let ctx;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `follow-${label}-${++sequence}-${Date.now()}@example.com`;

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

const follow = async (token, store, body) =>
    api("POST", `/stores/${store._id}/follow`, { token, body });

const unfollow = async (token, store, body) =>
    api("DELETE", `/stores/${store._id}/follow`, { token, body });

const followState = async (token, store) => api("GET", `/stores/${store._id}/follow`, { token });

const storedCount = async (store) => (await Store.findById(store._id)).followerCount;

const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// Seller/store fixtures — created DIRECTLY via models, as spec'd.
const makeStore = async (label) => {
    const profile = await SellerProfile.create({
        userId: new mongoose.Types.ObjectId(),
        fullName: `Seller ${label}`,
        phone: `017${String(sequence).padStart(8, "0")}`,
        email: uniqueEmail(`seller-${label}`),
        nationalId: `NID-FOL-${label}-${Date.now()}-${sequence}`,
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
        status: "active",
        shippingFee: 60,
        freeShippingThreshold: 999,
        deliveryEstimateDays: { min: 2, max: 4 }
    });
    return { profile, store };
};

const buildFixtures = async () => {
    const userA = await registerUser("A");
    const userB = await registerUser("B");

    const sellerOne = await makeStore("One");
    const sellerTwo = await makeStore("Two");

    return { userA, userB, sellerOne, sellerTwo, storeOne: sellerOne.store, storeTwo: sellerTwo.store };
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the follow suite");

    // app.js does not mount the follow router yet (the coordinator adds
    // `app.use("/api/v1", followRouter);`). For this suite the router is
    // mounted the same way cart/wishlist mount theirs: inserted directly
    // before the not-found handler so every other route keeps behaving.
    app.use("/api/v1", followRouter);
    const stack = app.router.stack;
    const layer = stack.pop();
    stack.splice(stack.length - 2, 0, layer);

    await mongoose.connect(`${base}/vanta_follow_test`);

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

describe("store-follow foundation", () => {
    it("1. first follow inserts the row and bumps followerCount to 1", async () => {
        const { token, user } = ctx.userA;

        const res = await follow(token, ctx.storeOne);
        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(res.body.data, { following: true, followerCount: 1 });
        assert.equal(await storedCount(ctx.storeOne), 1, "re-read from the store document");

        const row = await StoreFollower.findOne({ userId: user.id, storeId: ctx.storeOne._id });
        assert.ok(row, "the (userId, storeId) row exists");
        assert.equal(String(row.storeId), String(ctx.storeOne._id));
    });

    it("2. a duplicate follow is a no-op: still following, count stays 1, one row", async () => {
        const { token, user } = ctx.userA;

        await follow(token, ctx.storeOne);
        const again = await follow(token, ctx.storeOne);

        assert.equal(again.status, 200, again.raw);
        assert.deepEqual(again.body.data, { following: true, followerCount: 1 }, "desired state, count unchanged");
        assert.equal(await StoreFollower.countDocuments({ userId: user.id }), 1, "one row only");
        assert.equal(await storedCount(ctx.storeOne), 1, "the count never double-increments");
    });

    it("3. unfollow removes the row and decrements the count to 0", async () => {
        const { token, user } = ctx.userA;

        await follow(token, ctx.storeOne);
        const res = await unfollow(token, ctx.storeOne);

        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(res.body.data, { following: false, followerCount: 0 });
        assert.equal(await StoreFollower.countDocuments({ userId: user.id }), 0, "the row is gone");
        assert.equal(await storedCount(ctx.storeOne), 0, "the store document agrees");
    });

    it("4. unfollowing without a follow is a no-op that leaves the count alone", async () => {
        const res = await unfollow(ctx.userA.token, ctx.storeOne);

        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(res.body.data, { following: false, followerCount: 0 });
        assert.equal(await storedCount(ctx.storeOne), 0, "count unchanged (0)");
        assert.equal(await StoreFollower.countDocuments({}), 0);
    });

    it("5. GET state answers both directions with following and followerCount", async () => {
        const { token } = ctx.userA;

        const fresh = await followState(token, ctx.storeOne);
        assert.equal(fresh.status, 200, fresh.raw);
        assert.deepEqual(fresh.body.data, { following: false, followerCount: 0 });

        await follow(token, ctx.storeOne);
        const whileFollowing = await followState(token, ctx.storeOne);
        assert.deepEqual(whileFollowing.body.data, { following: true, followerCount: 1 });

        await unfollow(token, ctx.storeOne);
        const afterUnfollow = await followState(token, ctx.storeOne);
        assert.deepEqual(afterUnfollow.body.data, { following: false, followerCount: 0 });
    });

    it("6. GET /me/follows returns exactly the followed stores, follow-creation order, as toStoreDto", async () => {
        const { token: tokenA, user: userA } = ctx.userA;
        const { token: tokenB } = ctx.userB;

        const empty = await api("GET", "/me/follows", { token: tokenA });
        assert.equal(empty.status, 200, empty.raw);
        assert.deepEqual(empty.body.data.stores, []);

        await follow(tokenA, ctx.storeOne);
        await pause();
        await follow(tokenA, ctx.storeTwo);

        const res = await api("GET", "/me/follows", { token: tokenA });
        assert.equal(res.status, 200, res.raw);

        const freshOne = await Store.findById(ctx.storeOne._id);
        const freshTwo = await Store.findById(ctx.storeTwo._id);
        assert.deepEqual(
            res.body.data.stores,
            [toStoreDto(freshOne), toStoreDto(freshTwo)],
            "follow-creation order, exact toStoreDto"
        );
        for (const store of res.body.data.stores) {
            assert.equal(store._id, undefined, "no raw _id leaks");
            assert.equal(store.__v, undefined, "no version key leaks");
            assert.equal(typeof store.id, "string");
            assert.equal(typeof store.followerCount, "number");
        }

        const other = await api("GET", "/me/follows", { token: tokenB });
        assert.deepEqual(other.body.data.stores, [], "B follows nothing");

        await unfollow(tokenA, ctx.storeOne);
        const after = await api("GET", "/me/follows", { token: tokenA });
        assert.deepEqual(
            after.body.data.stores.map((store) => store.id),
            [String(ctx.storeTwo._id)],
            "the unfollowed store disappeared"
        );
        assert.equal(await StoreFollower.countDocuments({ userId: userA.id }), 1);
    });

    it("7. a missing or malformed store id is a 404 Store not found on every route", async () => {
        const { token } = ctx.userA;
        const missing = new mongoose.Types.ObjectId().toString();

        for (const storeId of [missing, "not-an-id"]) {
            for (const [method, path, hasBody] of [
                ["POST", `/stores/${storeId}/follow`, true],
                ["DELETE", `/stores/${storeId}/follow`, true],
                ["GET", `/stores/${storeId}/follow`, false]
            ]) {
                const res = await api(method, path, { token, body: hasBody ? {} : undefined });
                assert.equal(res.status, 404, `${method} ${path} → 404 (${res.raw})`);
                assert.equal(res.body.error.code, "not_found");
                assert.equal(res.body.error.message, "Store not found.");
            }
        }
        assert.equal(await StoreFollower.countDocuments({}), 0, "nothing was recorded");
    });

    it("8. two users following one store produce followerCount 2 and serve listForStore", async () => {
        const { token: tokenA } = ctx.userA;
        const { token: tokenB } = ctx.userB;

        const first = await follow(tokenA, ctx.storeOne);
        const second = await follow(tokenB, ctx.storeOne);

        assert.deepEqual(first.body.data, { following: true, followerCount: 1 });
        assert.deepEqual(second.body.data, { following: true, followerCount: 2 });
        assert.equal(await storedCount(ctx.storeOne), 2);
        assert.equal(await StoreFollower.countDocuments({ storeId: ctx.storeOne._id }), 2);

        const rows = await storeFollowerRepository.listForStore(ctx.storeOne._id);
        assert.equal(rows.length, 2, "the { storeId } index serves the store-side read");
    });

    it("9. B's unfollow leaves A's follow intact", async () => {
        const { token: tokenA, user: userA } = ctx.userA;
        const { token: tokenB, user: userB } = ctx.userB;

        await follow(tokenA, ctx.storeOne);
        await follow(tokenB, ctx.storeOne);

        const res = await unfollow(tokenB, ctx.storeOne);
        assert.equal(res.status, 200, res.raw);
        assert.deepEqual(res.body.data, { following: false, followerCount: 1 });
        assert.equal(await storedCount(ctx.storeOne), 1);

        const stateA = await followState(tokenA, ctx.storeOne);
        assert.deepEqual(stateA.body.data, { following: true, followerCount: 1 }, "A still follows");
        assert.ok(await StoreFollower.findOne({ userId: userA.id, storeId: ctx.storeOne._id }));
        assert.equal(await StoreFollower.countDocuments({ userId: userB.id }), 0, "B's row is gone");
    });

    it("10. A cannot make B unfollow: A's no-op delete never touches B's row or the count", async () => {
        const { token: tokenB, user: userB } = ctx.userB;
        const { token: tokenA } = ctx.userA;

        await follow(tokenB, ctx.storeOne);

        const res = await unfollow(tokenA, ctx.storeOne);
        assert.equal(res.status, 200, "scoped to A it is simply a no-op, not an error");
        assert.deepEqual(res.body.data, { following: false, followerCount: 1 }, "the count is unchanged");
        assert.equal(await storedCount(ctx.storeOne), 1);

        const stateB = await followState(tokenB, ctx.storeOne);
        assert.deepEqual(stateB.body.data, { following: true, followerCount: 1 }, "B still follows");
        assert.ok(await StoreFollower.findOne({ userId: userB.id, storeId: ctx.storeOne._id }));
    });

    it("11. unauthenticated requests are 401 on every route", async () => {
        const id = String(ctx.storeOne._id);

        const post = await api("POST", `/stores/${id}/follow`, { body: {} });
        assert.equal(post.status, 401);
        assert.equal(post.body.error.code, "unauthorized");

        const del = await api("DELETE", `/stores/${id}/follow`);
        assert.equal(del.status, 401);
        assert.equal(del.body.error.code, "unauthorized");

        const state = await api("GET", `/stores/${id}/follow`);
        assert.equal(state.status, 401);
        assert.equal(state.body.error.code, "unauthorized");

        const list = await api("GET", "/me/follows");
        assert.equal(list.status, 401);
        assert.equal(list.body.error.code, "unauthorized");
    });

    it("12. client-supplied userId or followerCount is a 422 that records nothing", async () => {
        const { token, user } = ctx.userA;

        const injected = await follow(token, ctx.storeOne, { userId: user.id });
        assert.equal(injected.status, 422);
        assert.equal(injected.body.error.code, "validation_failed");
        assert.ok(injected.body.error.fields.find((entry) => entry.field === "userId"));

        const counter = await follow(token, ctx.storeOne, { followerCount: 50 });
        assert.equal(counter.status, 422);
        assert.ok(counter.body.error.fields.find((entry) => entry.field === "followerCount"));

        const del = await unfollow(token, ctx.storeOne, { userId: user.id, followerCount: 50 });
        assert.equal(del.status, 422);
        assert.equal(del.body.error.fields.length, 2, "every offending field is reported at once");

        assert.equal(await StoreFollower.countDocuments({}), 0, "a rejected follow records nothing");
        assert.equal(await storedCount(ctx.storeOne), 0, "and never moves the count");
    });

    it("13. the count can never go negative: a drifted counter floors at 0, no-ops never decrement", async () => {
        const { token: tokenA } = ctx.userA;
        const { token: tokenB } = ctx.userB;

        // real follow, then drift the denormalised counter below the row count
        await follow(tokenA, ctx.storeOne);
        await Store.updateOne({ _id: ctx.storeOne._id }, { $set: { followerCount: 0 } });

        const decrement = await unfollow(tokenA, ctx.storeOne);
        assert.equal(decrement.status, 200, decrement.raw);
        assert.equal(decrement.body.data.followerCount, 0, "floored at 0 in the database itself");
        assert.equal(await storedCount(ctx.storeOne), 0, "stored value is non-negative");

        const repeat = await unfollow(tokenA, ctx.storeOne);
        assert.equal(repeat.status, 200, "a second unfollow is still a 200");
        assert.deepEqual(repeat.body.data, { following: false, followerCount: 0 }, "no-op never decrements");
        assert.equal(await storedCount(ctx.storeOne), 0);

        const untouched = await unfollow(tokenB, ctx.storeTwo);
        assert.equal(untouched.body.data.followerCount, 0, "a never-followed store stays at 0");
        assert.equal(await storedCount(ctx.storeTwo), 0);
    });
});
