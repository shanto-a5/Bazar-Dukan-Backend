/**
 * Address book foundation suite (M13).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_address_test` database, so every assertion is about what a client
 * would actually observe: status, envelope, error code, exact validation
 * wording and the single-default invariant.
 *
 * Run: node --test src/tests/address.test.js
 *
 * The suite drops `vanta_address_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import addressRouter from "../routes/address.route.js";
import { Address } from "../models/address.model.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;
let ctx;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `addr-${label}-${++sequence}-${Date.now()}@example.com`;

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

const validAddress = (overrides = {}) => ({
    label: "Home",
    recipientName: "Ada Lovelace",
    phone: "01712345678",
    division: "Dhaka",
    district: "Gulshan",
    area: "Banani",
    addressLine: "12 Road 5",
    postalCode: "1213",
    ...overrides
});

const createAddress = async (token, overrides = {}) => {
    const response = await api("POST", "/addresses", { token, body: validAddress(overrides) });
    assert.equal(response.status, 201, response.raw);
    return response;
};

/** Exactly one default must hold after every mutation. */
const countDefaults = async (userId) => Address.countDocuments({ userId, isDefault: true });

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the address suite");

    // app.js does not mount the address router yet (the coordinator adds
    // `app.use("/api/v1", addressRouter);`). Mounted the same way cart.test.js
    // mounts its router, inserted directly before the not-found handler.
    app.use("/api/v1", addressRouter);
    const stack = app.router.stack;
    const addressLayer = stack.pop();
    stack.splice(stack.length - 2, 0, addressLayer);

    await mongoose.connect(`${base}/vanta_address_test`);

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
    const userA = await registerUser("A");
    const userB = await registerUser("B");
    ctx = { userA, userB };
});

// --------------------------------------------------------------------- tests

describe("address book foundation", () => {
    it("1. the first address a user creates becomes default automatically", async () => {
        const { token } = ctx.userA;
        const res = await createAddress(token);

        assert.equal(res.status, 201, res.raw);
        const address = res.body.data.address;
        assert.equal(address.isDefault, true);
        assert.equal(address.label, "Home");
        assert.equal(typeof address.id, "string");
        assert.equal(address._id, undefined, "no raw _id leaks");
        assert.equal(typeof address.createdAt, "string");
        assert.equal(typeof address.updatedAt, "string");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("2. creating with isDefault:true unseats the previous default (one default always)", async () => {
        const { token } = ctx.userA;
        const first = await createAddress(token);
        const second = await createAddress(token, { isDefault: true });

        assert.equal(second.body.data.address.isDefault, true);
        assert.equal(first.body.data.address.isDefault, true, "the first was default before the second");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);

        const list = await api("GET", "/addresses", { token });
        const flags = list.body.data.addresses.map((entry) => entry.isDefault);
        assert.equal(flags.filter(Boolean).length, 1, "exactly one default after each mutation");

        const third = await createAddress(token, { label: "Office" });
        assert.equal(third.body.data.address.isDefault, false, "a plain third address is not promoted");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("3. validation collects every offending field in one 422 with exact wording", async () => {
        const { token } = ctx.userA;
        const res = await api("POST", "/addresses", {
            token,
            body: {
                recipientName: "   ",
                phone: "123",
                division: "",
                district: "",
                addressLine: "",
                postalCode: "12"
            }
        });

        assert.equal(res.status, 422, res.raw);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "Who should receive the order?");

        const byField = Object.fromEntries(res.body.error.fields.map((entry) => [entry.field, entry.message]));
        assert.ok(res.body.error.fields.length >= 4, "at least four offending fields at once");
        assert.equal(byField.recipientName, "Who should receive the order?");
        assert.equal(byField.phone, "Enter a valid phone number");
        assert.equal(byField.division, "Division is required");
        assert.equal(byField.district, "District is required");
        assert.equal(byField.addressLine, "Street address is required");
        assert.equal(byField.postalCode, "Use a 4 digit postal code");
    });

    it("4. phone needs at least 6 digits after stripping non-digits", async () => {
        const { token } = ctx.userA;

        const short = await api("POST", "/addresses", { token, body: validAddress({ phone: "0171" }) });
        assert.equal(short.status, 422);
        assert.ok(short.body.error.fields.find((entry) => entry.field === "phone"));
        assert.equal(short.body.error.fields.find((entry) => entry.field === "phone").message, "Enter a valid phone number");

        const symbols = await createAddress(token, { phone: "+88-017-1234-5678" });
        assert.equal(symbols.status, 201, "digits are counted after stripping punctuation");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("5. postal code must be exactly 4 digits when present", async () => {
        const { token } = ctx.userA;

        const short = await api("POST", "/addresses", { token, body: validAddress({ postalCode: "12" }) });
        assert.equal(short.status, 422);
        assert.equal(short.body.error.fields[0].message, "Use a 4 digit postal code");

        const long = await api("POST", "/addresses", { token, body: validAddress({ postalCode: "12345" }) });
        assert.equal(long.status, 422);

        const good = await createAddress(token, { postalCode: "1213" });
        assert.equal(good.status, 201);

        const absent = await createAddress(token, { postalCode: "" });
        assert.equal(absent.status, 201, "an absent postal code is fine");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("6. list returns addresses in insertion order", async () => {
        const { token } = ctx.userA;
        const a1 = await createAddress(token, { label: "One" });
        const a2 = await createAddress(token, { label: "Two" });
        const a3 = await createAddress(token, { label: "Three" });

        const res = await api("GET", "/addresses", { token });
        assert.equal(res.status, 200, res.raw);
        const ids = res.body.data.addresses.map((entry) => entry.id);
        assert.deepEqual(ids, [a1.body.data.address.id, a2.body.data.address.id, a3.body.data.address.id]);
    });

    it("7. GET /addresses/:id returns only the caller's own address", async () => {
        const { token } = ctx.userA;
        const created = await createAddress(token);

        const own = await api("GET", `/addresses/${created.body.data.address.id}`, { token: ctx.userA.token });
        assert.equal(own.status, 200);
        assert.equal(own.body.data.address.id, created.body.data.address.id);

        const other = await api("GET", `/addresses/${created.body.data.address.id}`, { token: ctx.userB.token });
        assert.equal(other.status, 404);
        assert.equal(other.body.error.code, "not_found");
        assert.equal(other.body.error.message, "Address not found.");
    });

    it("8. PATCH merges the given fields and falls back to the Address label", async () => {
        const { token } = ctx.userA;
        const created = await createAddress(token, { label: "Home" });

        const res = await api("PATCH", `/addresses/${created.body.data.address.id}`, {
            token,
            body: { label: "   ", recipientName: "Grace Hopper" }
        });
        assert.equal(res.status, 200, res.raw);
        const address = res.body.data.address;
        assert.equal(address.label, "Address", "blank label falls back");
        assert.equal(address.recipientName, "Grace Hopper");
        assert.equal(address.phone, "01712345678", "untouched fields survive the merge");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("9. PATCH isDefault:true moves the single-default flag", async () => {
        const { token } = ctx.userA;
        const a1 = await createAddress(token);
        const a2 = await createAddress(token);

        assert.equal(a1.body.data.address.isDefault, true);

        const res = await api("PATCH", `/addresses/${a1.body.data.address.id}`, { token, body: { isDefault: true } });
        assert.equal(res.status, 200, res.raw);
        assert.equal(res.body.data.address.isDefault, true);

        const list = await api("GET", "/addresses", { token });
        const a2Row = list.body.data.addresses.find((entry) => entry.id === a2.body.data.address.id);
        assert.equal(a2Row.isDefault, false, "the previous default is unseated");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("10. PATCH default:false with another address hands the flag to the first remaining", async () => {
        const { token } = ctx.userA;
        const a1 = await createAddress(token);
        const a2 = await createAddress(token);
        assert.equal(a1.body.data.address.isDefault, true);

        const res = await api("PATCH", `/addresses/${a1.body.data.address.id}`, { token, body: { isDefault: false } });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.address.isDefault, false);

        const list = await api("GET", "/addresses", { token });
        const a2Row = list.body.data.addresses.find((entry) => entry.id === a2.body.data.address.id);
        assert.equal(a2Row.isDefault, true, "the first remaining address inherits the flag");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("11. PATCH default:false on the sole address keeps it default", async () => {
        const { token } = ctx.userA;
        const created = await createAddress(token);
        assert.equal(created.body.data.address.isDefault, true);

        const res = await api("PATCH", `/addresses/${created.body.data.address.id}`, { token, body: { isDefault: false } });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.address.isDefault, true, "the only address stays default");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("12. DELETE a non-default address leaves the default untouched", async () => {
        const { token } = ctx.userA;
        const a1 = await createAddress(token);
        const a2 = await createAddress(token);
        assert.equal(a1.body.data.address.isDefault, true);

        const res = await api("DELETE", `/addresses/${a2.body.data.address.id}`, { token });
        assert.equal(res.status, 200, res.raw);
        assert.equal(res.body.data.deleted, true);
        assert.deepEqual(res.body.data.addresses.map((entry) => entry.id), [a1.body.data.address.id]);
        assert.equal(res.body.data.addresses[0].isDefault, true, "the default flag did not move");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("13. DELETE the default hands the flag to the first remaining address", async () => {
        const { token } = ctx.userA;
        const a1 = await createAddress(token);
        const a2 = await createAddress(token);
        const a3 = await createAddress(token);
        assert.equal(a1.body.data.address.isDefault, true);

        const res = await api("DELETE", `/addresses/${a1.body.data.address.id}`, { token });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.addresses.length, 2);
        const [nowDefault, other] = res.body.data.addresses;
        assert.equal(a2.body.data.address.id, nowDefault.id);
        assert.equal(nowDefault.isDefault, true, "remaining[0] becomes default");
        assert.equal(other.isDefault, false);
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("14. DELETE the last address returns an empty book", async () => {
        const { token } = ctx.userA;
        const created = await createAddress(token);

        const res = await api("DELETE", `/addresses/${created.body.data.address.id}`, { token });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.deleted, true);
        assert.deepEqual(res.body.data.addresses, []);

        const list = await api("GET", "/addresses", { token });
        assert.deepEqual(list.body.data.addresses, []);
        assert.equal(await countDefaults(ctx.userA.user.id), 0);
    });

    it("15. IDOR: a foreign user cannot patch, delete or promote another user's address", async () => {
        const created = await createAddress(ctx.userA.token, { recipientName: "Ada Lovelace" });
        const foreignId = created.body.data.address.id;

        const patch = await api("PATCH", `/addresses/${foreignId}`, {
            token: ctx.userB.token,
            body: { recipientName: "Hacked" }
        });
        assert.equal(patch.status, 404);
        assert.equal(patch.body.error.message, "Address not found.");

        const del = await api("DELETE", `/addresses/${foreignId}`, { token: ctx.userB.token });
        assert.equal(del.status, 404);

        const promote = await api("POST", `/addresses/${foreignId}/default`, { token: ctx.userB.token });
        assert.equal(promote.status, 404);

        const stored = await Address.findById(foreignId);
        assert.equal(stored.recipientName, "Ada Lovelace", "A's row is byte-for-byte untouched");
        assert.equal(await countDefaults(ctx.userA.user.id), 1);
    });

    it("16. mass assignment: userId and garbage isDefault types are one 422", async () => {
        const created = await createAddress(ctx.userA.token);
        const ownId = created.body.data.address.id;

        const res = await api("PATCH", `/addresses/${ownId}`, {
            token: ctx.userA.token,
            body: { userId: ctx.userA.user.id, isDefault: "yes" }
        });

        assert.equal(res.status, 422, res.raw);
        assert.equal(res.body.error.code, "validation_failed");
        const byField = Object.fromEntries(res.body.error.fields.map((entry) => [entry.field, entry.message]));
        assert.ok(byField.userId, "userId is rejected");
        assert.ok(byField.isDefault, "garbage isDefault is rejected");

        const stored = await Address.findById(ownId);
        assert.equal(stored.userId.toString(), ctx.userA.user.id, "A's ownership is unchanged");
        assert.equal(stored.isDefault, true, "the row itself is unchanged");

        const postMass = await api("POST", "/addresses", {
            token: ctx.userA.token,
            body: validAddress({ userId: ctx.userA.user.id })
        });
        assert.equal(postMass.status, 422);
        assert.ok(postMass.body.error.fields.find((entry) => entry.field === "userId"));
    });

    it("17. unauthenticated requests are 401", async () => {
        const get = await api("GET", "/addresses");
        assert.equal(get.status, 401);
        assert.equal(get.body.error.code, "unauthorized");

        const post = await api("POST", "/addresses", { body: validAddress() });
        assert.equal(post.status, 401);

        const patch = await api("PATCH", `/addresses/${new mongoose.Types.ObjectId()}`, { body: { label: "X" } });
        assert.equal(patch.status, 401);

        const del = await api("DELETE", `/addresses/${new mongoose.Types.ObjectId()}`);
        assert.equal(del.status, 401);
    });
});