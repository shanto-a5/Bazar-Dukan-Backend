/**
 * Seller foundation suite (slice "seller foundation", milestone M12).
 *
 * Runs against a dedicated `vanta_seller_test` database on the configured
 * MongoDB and listens on an ephemeral port, so every assertion is about what a
 * client observes: status, envelope, error code, field errors and ownership —
 * not about internal calls.
 *
 * Run JUST this file:
 *
 *     node --test src/tests/seller.test.js
 *
 * The slice routers are not wired into `src/app.js` yet (a coordinator does
 * that once every slice lands), so the suite stands up the same stack `app.js`
 * builds — request id, body parsers, cookie parser, the identity router — plus
 * this slice's two routers, then the same JSON 404/error handlers. Same
 * middleware order, same envelopes, and it works before and after the real
 * wiring: the router files under test are the exact ones that get mounted.
 *
 * The suite drops `vanta_seller_test` when it finishes; it never touches the
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
import categoryRouter from "../routes/category.route.js";
import { User } from "../models/user.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";
import { Category } from "../models/category.model.js";
import { Product } from "../models/product.model.js";
import { SellerOrder } from "../models/seller-order.model.js";
import { roundMoney } from "../core/money.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `seller-${label}-${++sequence}-${Date.now()}@example.com`;

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
    instance.use("/api/v1", categoryRouter);
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

/** Roles are server-controlled, so a test grants them the way the server does. */
const grantRole = async (userId, role) => {
    await User.updateOne({ _id: userId }, { $addToSet: { roles: role } });
};

const AGREEMENT = {
    marketplaceTerms: true,
    sellerPolicies: true,
    productAuthenticity: true,
    fulfillmentResponsibility: true
};

/** A complete, valid `BecomeSellerInput`; override keys per test. */
const applicationBody = (overrides = {}) => ({
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
    agreement: { ...AGREEMENT },
    ...overrides
});

/** Applies and returns a pending application for the given token. */
const submitApplication = async (token, overrides = {}) => {
    const response = await api("POST", "/seller/register", { token, body: applicationBody(overrides) });
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

/** Asserts a payload carries `id` (string) and no Mongo internals anywhere. */
const assertNoMongoIds = (raw, label) => {
    assert.ok(!raw.includes('"_id"'), `${label} must not expose _id`);
    assert.ok(!raw.includes('"__v"'), `${label} must not expose __v`);
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the seller suite");

    await mongoose.connect(`${base}/vanta_seller_test`);

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

// ---------------------------------------------------------------- registration

describe("POST /seller/register", () => {
    it("creates a pending profile and its store, with no _id anywhere in the answer", async () => {
        const { token, user } = await registerUser("apply-ok");
        const data = await submitApplication(token);

        assert.equal(data.canUseSellerArea, false, "a pending applicant must not reach the seller area");
        assert.equal(data.profile.status, "pending");
        assert.equal(data.profile.userId, user.id);
        assert.equal(typeof data.profile.id, "string");
        assert.equal(data.profile.storeName, "Nadia Crafts");
        assert.equal(data.profile.storeId, data.store.id, "the profile carries its store id");
        assert.ok(data.profile.appliedAt, "the application records when it was made");

        // The simulator's store creation defaults, verbatim.
        assert.equal(data.store.status, "active");
        assert.equal(data.store.name, "Nadia Crafts");
        assert.equal(data.store.shippingFee, 60);
        assert.equal(data.store.freeShippingThreshold, 999);
        assert.deepEqual(data.store.deliveryEstimateDays, { min: 2, max: 4 });
        assert.equal(data.store.responseRate, 100);
        assert.equal(data.store.verified, true);
        assert.equal(data.store.sellerId, data.profile.id);
        assert.ok(data.store.location.includes("Dhaka"));

        assertNoMongoIds(JSON.stringify(data), "register response");

        // Approval is what grants the role — registration must not.
        const stored = await User.findById(user.id);
        assert.deepEqual(stored.roles, ["customer"], "the seller role is granted on approval, not on apply");

        const profile = await SellerProfile.findOne({ userId: user.id });
        assert.equal(profile.status, "pending");
        const store = await Store.findOne({ sellerId: profile._id });
        assert.ok(store, "the store is created alongside the application");
    });

    it("refuses a second application with 409 conflict", async () => {
        const { token } = await registerUser("apply-twice");
        await submitApplication(token);

        const second = await api("POST", "/seller/register", { token, body: applicationBody() });

        assert.equal(second.status, 409);
        assert.equal(second.body.ok, false);
        assert.equal(second.body.error.code, "conflict");
        assert.equal(second.body.error.message, "You already have a seller account.");
        assert.equal(await SellerProfile.countDocuments(), 1, "still exactly one profile");
    });

    it("reports every offending field in one 422", async () => {
        const { token } = await registerUser("apply-invalid");
        const response = await api("POST", "/seller/register", {
            token,
            body: {
                email: "not-an-email",
                nationalId: "12",
                storeDescription: "short",
                agreement: { marketplaceTerms: true }
            }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");

        const fields = response.body.error.fields;
        assert.ok(fields.length >= 4, `expected many field errors, got ${fields.length}`);
        for (const entry of fields) {
            assert.equal(typeof entry.field, "string");
            assert.equal(typeof entry.message, "string");
        }
        const names = fields.map((entry) => entry.field);
        assert.ok(names.includes("email"));
        assert.ok(names.includes("fullName"));
        assert.ok(names.includes("phone"));
        assert.ok(names.includes("nationalId"));
        assert.ok(names.includes("storeDescription"));
        assert.ok(names.includes("sellerPolicies"), "an unticked agreement is reported by its own name");
        assert.ok(names.includes("fulfillmentResponsibility"));
        assert.equal(await SellerProfile.countDocuments(), 0, "nothing is written when validation fails");
    });

    it("requires a session", async () => {
        const response = await api("POST", "/seller/register", { body: applicationBody() });

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "unauthorized");
        assert.equal(await SellerProfile.countDocuments(), 0);
    });
});

// ------------------------------------------------------------ application read

describe("application and profile reads", () => {
    it("answers a user who never applied with nulls and canUseSellerArea false", async () => {
        const { token } = await registerUser("no-application");
        const response = await api("GET", "/seller/application", { token });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.profile, null);
        assert.equal(response.body.data.store, null);
        assert.equal(response.body.data.canUseSellerArea, false);
    });

    it("answers a plain customer's /seller/profile with nulls rather than 404", async () => {
        const { token } = await registerUser("plain-customer");
        const response = await api("GET", "/seller/profile", { token });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.profile, null);
        assert.equal(response.body.data.store, null);
    });

    it("reports canUseSellerArea only once the application is active", async () => {
        const { token } = await registerUser("pending-read");
        await submitApplication(token);

        const pending = await api("GET", "/seller/application", { token });
        assert.equal(pending.body.data.canUseSellerArea, false);
        assert.equal(pending.body.data.profile.status, "pending");
        assert.equal(pending.body.data.profile.storeId, pending.body.data.store.id);
        assert.ok(pending.body.data.store, "the store exists while the application is reviewed");
    });
});

// ----------------------------------------------------------------- approvals

describe("approvals", () => {
    const asApprover = async (label) => {
        const account = await registerUser(label);
        await grantRole(account.user.id, "seller_approver");
        return account;
    };

    it("lists pending applications newest first, each with its store", async () => {
        const { token: approverToken } = await asApprover("approver-list");
        const applicant = await registerUser("queue-a");
        const first = await submitApplication(applicant.token);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const secondApplicant = await registerUser("queue-b");
        const second = await submitApplication(secondApplicant.token);

        const response = await api("GET", "/approvals/sellers", { token: approverToken });

        assert.equal(response.status, 200);
        const sellers = response.body.data.sellers;
        assert.equal(sellers.length, 2);
        assert.equal(sellers[0].profile.id, second.profile.id, "newest application first");
        assert.equal(sellers[1].profile.id, first.profile.id);
        assert.ok(sellers[0].store, "an approver sees the store that will be created");
        assert.equal(sellers[0].profile.status, "pending");
        assertNoMongoIds(response.raw, "approvals response");
    });

    it("approves an application: status active, decidedAt set, seller role granted", async () => {
        const { token: approverToken } = await asApprover("approver-ok");
        const applicant = await registerUser("approvee");
        const { profile } = await submitApplication(applicant.token);

        const response = await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: approverToken });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.profile.status, "active");
        assert.ok(response.body.data.profile.decidedAt, "the decision is timestamped");
        const approveStore = await Store.findOne({ sellerId: profile.id });
        assert.equal(response.body.data.profile.storeId, String(approveStore._id));

        const stored = await User.findById(applicant.user.id);
        assert.ok(stored.roles.includes("seller"), "approval grants the seller role");
        assert.deepEqual(stored.roles, ["customer", "seller"], "exactly one grant, no duplicates");

        // The grant is what unlocks the seller area.
        const application = await api("GET", "/seller/application", { token: applicant.token });
        assert.equal(application.body.data.canUseSellerArea, true);
    });

    it("refuses the approve call for a user who is not an approver", async () => {
        const { token: plainToken } = await registerUser("not-approver");
        const applicant = await registerUser("approvee-guard");
        const { profile } = await submitApplication(applicant.token);

        const response = await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: plainToken });

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, "forbidden");

        const stored = await SellerProfile.findById(profile.id);
        assert.equal(stored.status, "pending", "nothing changed");
    });

    it("answers an unknown and a malformed application id with 404", async () => {
        const { token: approverToken } = await asApprover("approver-404");

        const unknown = await api("POST", `/approvals/sellers/${new mongoose.Types.ObjectId()}/approve`, {
            token: approverToken
        });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.body.error.code, "not_found");

        const malformed = await api("POST", "/approvals/sellers/not-an-id/approve", { token: approverToken });
        assert.equal(malformed.status, 404);
        assert.equal(malformed.body.error.code, "not_found");
    });

    it("rejects an application with the reviewer's note", async () => {
        const { token: approverToken } = await asApprover("approver-reject");
        const applicant = await registerUser("rejectee");
        const { profile } = await submitApplication(applicant.token);

        const response = await api("POST", `/approvals/sellers/${profile.id}/reject`, {
            token: approverToken,
            body: { note: "The national ID could not be verified." }
        });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.profile.status, "rejected");
        assert.equal(response.body.data.profile.decisionNote, "The national ID could not be verified.");
        assert.ok(response.body.data.profile.decidedAt);

        const application = await api("GET", "/seller/application", { token: applicant.token });
        assert.equal(application.body.data.canUseSellerArea, false);
        assert.equal(application.body.data.profile.status, "rejected");
    });

    it("refuses a rejection note longer than 500 characters", async () => {
        const { token: approverToken } = await asApprover("approver-note");
        const applicant = await registerUser("rejectee-long");
        const { profile } = await submitApplication(applicant.token);

        const response = await api("POST", `/approvals/sellers/${profile.id}/reject`, {
            token: approverToken,
            body: { note: "x".repeat(501) }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.fields[0].field, "note");

        const stored = await SellerProfile.findById(profile.id);
        assert.equal(stored.status, "pending", "an invalid note does not decide anything");
    });

    it("refuses a repeated approval with 409 and writes nothing", async () => {
        const { token: approverToken } = await asApprover("approver-409");
        const applicant = await registerUser("approvee-twice");
        const { profile } = await submitApplication(applicant.token);

        const first = await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: approverToken });
        assert.equal(first.status, 200, first.raw);

        const decided = await SellerProfile.findById(profile.id);
        const decidedAt = String(decided.decidedAt);
        const rolesAfterFirst = [...(await User.findById(applicant.user.id)).roles].sort();

        const second = await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: approverToken });

        assert.equal(second.status, 409, second.raw);
        assert.equal(second.body.error.code, "conflict");

        const stored = await SellerProfile.findById(profile.id);
        assert.equal(stored.status, "active", "the profile stays active");
        assert.equal(String(stored.decidedAt), decidedAt, "a refused decision does not touch the timestamp");
        assert.equal(stored.decisionHistory.length, 1, "a refused decision appends nothing");

        const userRoles = [...(await User.findById(applicant.user.id)).roles].sort();
        assert.deepEqual(userRoles, rolesAfterFirst, "no duplicate role grant");
    });

    it("refuses a repeated rejection with 409 and writes nothing", async () => {
        const { token: approverToken } = await asApprover("rejector-409");
        const applicant = await registerUser("rejectee-twice");
        const { profile } = await submitApplication(applicant.token);
        const note = "The documents did not match.";

        const first = await api("POST", `/approvals/sellers/${profile.id}/reject`, {
            token: approverToken,
            body: { note }
        });
        assert.equal(first.status, 200, first.raw);

        const decided = await SellerProfile.findById(profile.id);

        const second = await api("POST", `/approvals/sellers/${profile.id}/reject`, {
            token: approverToken,
            body: { note: "A second, different reason." }
        });

        assert.equal(second.status, 409, second.raw);
        assert.equal(second.body.error.code, "conflict");

        const stored = await SellerProfile.findById(profile.id);
        assert.equal(stored.status, "rejected");
        assert.equal(stored.decisionNote, note, "the original reason survives");
        assert.equal(String(stored.decidedAt), String(decided.decidedAt), "the timestamp is untouched");
        assert.equal(stored.decisionHistory.length, 1, "a refused decision appends nothing");
    });
});

// ------------------------------------------------------- approval history

describe("GET /approvals/sellers/:id/history", () => {
    const asApprover = async (label) => {
        const account = await registerUser(label);
        await grantRole(account.user.id, "seller_approver");
        return account;
    };

    it("answers a never-decided application with an empty history", async () => {
        const { token: approverToken } = await asApprover("hist-empty");
        const applicant = await registerUser("hist-pending");
        const { profile } = await submitApplication(applicant.token);

        const response = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: approverToken });

        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body.data.history, []);
        assertNoMongoIds(response.raw, "history response");
    });

    it("records an approval as one entry with the actor and a timestamp", async () => {
        const { token: approverToken, user: approver } = await asApprover("hist-approve");
        const applicant = await registerUser("hist-approvee");
        const { profile } = await submitApplication(applicant.token);

        const approved = await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: approverToken });
        assert.equal(approved.status, 200, approved.raw);

        const response = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: approverToken });

        assert.equal(response.status, 200, response.raw);
        const history = response.body.data.history;
        assert.equal(history.length, 1, "one decision, one entry");
        assert.equal(history[0].decision, "approved");
        assert.equal(history[0].actorId, approver.id, "the trail records who decided");
        assert.ok(history[0].actorLabel, "the operator label is present");
        assert.ok(history[0].at, "the entry is timestamped");
        assert.equal(history[0].note, "", "an approval carries no note");
        assertNoMongoIds(response.raw, "history response");
    });

    it("records a rejection with its reason", async () => {
        const { token: approverToken, user: approver } = await asApprover("hist-reject");
        const applicant = await registerUser("hist-rejectee");
        const { profile } = await submitApplication(applicant.token);
        const note = "The store address could not be verified.";

        const rejected = await api("POST", `/approvals/sellers/${profile.id}/reject`, {
            token: approverToken,
            body: { note }
        });
        assert.equal(rejected.status, 200, rejected.raw);

        const response = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: approverToken });

        assert.equal(response.status, 200, response.raw);
        const history = response.body.data.history;
        assert.equal(history.length, 1);
        assert.equal(history[0].decision, "rejected");
        assert.equal(history[0].actorId, approver.id);
        assert.equal(history[0].note, note, "the reason is part of the trail");
        assert.ok(history[0].at);
    });

    it("is append-only: a later decision never rewrites an earlier entry", async () => {
        const { token: firstApproverToken, user: firstApprover } = await asApprover("hist-append-1");
        const { token: secondApproverToken, user: secondApprover } = await asApprover("hist-append-2");
        const applicant = await registerUser("hist-appendee");
        const { profile } = await submitApplication(applicant.token);

        await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: firstApproverToken });
        const afterApproval = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: firstApproverToken });
        const firstEntry = afterApproval.body.data.history[0];

        // An active account can still be rejected (a state change, not a no-op),
        // so the trail grows to two entries written by different operators.
        const rejected = await api("POST", `/approvals/sellers/${profile.id}/reject`, {
            token: secondApproverToken,
            body: { note: "Suspended after review." }
        });
        assert.equal(rejected.status, 200, rejected.raw);

        const final = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: firstApproverToken });
        const history = final.body.data.history;

        assert.equal(history.length, 2, "one entry per successful decision");
        assert.deepEqual(history[0], firstEntry, "the earlier entry is byte-for-byte unchanged");
        assert.equal(history[0].decision, "approved");
        assert.equal(history[0].actorId, firstApprover.id);
        assert.equal(history[1].decision, "rejected");
        assert.equal(history[1].actorId, secondApprover.id, "each entry keeps its own actor");
        assert.equal(history[1].note, "Suspended after review.");
        assert.ok(new Date(history[1].at).getTime() >= new Date(history[0].at).getTime());
    });

    it("is closed to anonymous callers, customers and even approved sellers", async () => {
        const { token: approverToken } = await asApprover("hist-guard");
        const applicant = await registerUser("hist-guard-subject");
        const { profile } = await submitApplication(applicant.token);

        const anonymous = await api("GET", `/approvals/sellers/${profile.id}/history`);
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.body.error.code, "unauthorized");

        const customer = await registerUser("hist-guard-customer");
        const asCustomer = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: customer.token });
        assert.equal(asCustomer.status, 403);
        assert.equal(asCustomer.body.error.code, "forbidden");

        // The applicant becomes a seller through the real flow and still must
        // not read the approver's trail.
        const approved = await api("POST", `/approvals/sellers/${profile.id}/approve`, { token: approverToken });
        assert.equal(approved.status, 200, approved.raw);
        const asSeller = await api("GET", `/approvals/sellers/${profile.id}/history`, { token: applicant.token });
        assert.equal(asSeller.status, 403);
        assert.equal(asSeller.body.error.code, "forbidden");

        const stored = await SellerProfile.findById(profile.id);
        assert.equal(stored.decisionHistory.length, 1, "the refused reads appended nothing");
    });

    it("answers unknown and malformed ids with the same safe 404", async () => {
        const { token: approverToken } = await asApprover("hist-404");

        const unknown = await api("GET", `/approvals/sellers/${new mongoose.Types.ObjectId()}/history`, {
            token: approverToken
        });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.body.error.code, "not_found");

        const malformed = await api("GET", "/approvals/sellers/not-an-id/history", { token: approverToken });
        assert.equal(malformed.status, 404);
        assert.equal(malformed.body.error.code, "not_found");
    });
});

// ------------------------------------------------------------- seller gating

describe("requireSeller gating", () => {
    it("tells a pending applicant their application is under review", async () => {
        const { token } = await registerUser("gating-pending");
        await submitApplication(token);

        const response = await api("GET", "/seller/store", { token });

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, "forbidden");
        assert.equal(response.body.error.message, "Your seller application is still under review.");
    });

    it("tells a user with no profile that they do not have a seller account", async () => {
        const { token } = await registerUser("gating-none");

        const response = await api("GET", "/seller/store", { token });

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, "forbidden");
        assert.equal(response.body.error.message, "You do not have a seller account.");
    });

    it("lets an active seller read their store", async () => {
        const { token, user } = await registerUser("gating-active");
        await createActiveSeller(user);

        const response = await api("GET", "/seller/store", { token });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.store.name, "Active Store");
        assert.equal(typeof response.body.data.store.id, "string");
        assertNoMongoIds(response.raw, "store response");
    });

    it("rejects an unauthenticated call with 401", async () => {
        const response = await api("GET", "/seller/store");

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "unauthorized");
    });
});

// ----------------------------------------------------------------- dashboard

describe("GET /seller/dashboard", () => {
    const ADDRESS = {
        label: "Home",
        recipientName: "Ada Lovelace",
        phone: "01712345678",
        division: "Dhaka",
        district: "Dhaka",
        area: "Dhanmondi",
        addressLine: "House 1, Road 2",
        postalCode: "1209",
        instructions: "",
        isDefault: false
    };

    it("requires a session and an active seller account", async () => {
        const anonymous = await api("GET", "/seller/dashboard");
        assert.equal(anonymous.status, 401);
        assert.equal(anonymous.body.error.code, "unauthorized");

        const plain = await registerUser("dash-plain");
        const denied = await api("GET", "/seller/dashboard", { token: plain.token });
        assert.equal(denied.status, 403);
        assert.equal(denied.body.error.code, "forbidden");

        const applicant = await registerUser("dash-pending");
        await submitApplication(applicant.token);
        const pending = await api("GET", "/seller/dashboard", { token: applicant.token });
        assert.equal(pending.status, 403);
        assert.equal(pending.body.error.message, "Your seller application is still under review.");
    });

    it("counts products, orders, pending fulfilment and delivered revenue for this seller only", async () => {
        const { token, user } = await registerUser("dash-ok");
        const { profile, store } = await createActiveSeller(user);
        const other = await registerUser("dash-other");
        const otherSeller = await createActiveSeller(other.user);

        const category = await Category.create({ name: "Dashboard" });
        for (const name of ["Dash One", "Dash Two"]) {
            await Product.create({
                sellerId: profile._id,
                storeId: store._id,
                categoryId: category._id,
                name,
                brand: "Alpha",
                sku: `SKU-${name.replace(/\s+/g, "-").toUpperCase()}`,
                regularPrice: 100,
                status: "active",
                stock: 5
            });
        }

        const split = (seller, storeRow, status, total) =>
            SellerOrder.create({
                orderId: new mongoose.Types.ObjectId(),
                sellerId: seller._id,
                storeId: storeRow._id,
                storeName: storeRow.name,
                status,
                total,
                subtotal: total,
                shippingAddress: { ...ADDRESS }
            });
        await split(profile, store, "new", 100);
        await split(profile, store, "packed", 200);
        await split(profile, store, "delivered", 500);
        await split(profile, store, "shipped", 300);
        await split(otherSeller.profile, otherSeller.store, "delivered", 9999);

        const response = await api("GET", "/seller/dashboard", { token });

        assert.equal(response.status, 200, response.raw);
        const data = response.body.data;
        assert.equal(data.seller.id, String(profile._id));
        assert.equal(data.seller.storeId, String(store._id));
        assert.equal(data.store.id, String(store._id));
        assert.equal(data.productCount, 2, "all of this seller's listings, however they are statused");
        assert.equal(data.orderCount, 4, "never another seller's splits");
        assert.equal(data.pendingFulfilment, 2, "new + packed are awaiting fulfilment");
        assert.equal(data.revenue, 500, "only DELIVERED splits add to revenue");
        assertNoMongoIds(response.raw, "dashboard response");
    });
});

// ------------------------------------------------------------- store settings

describe("store settings", () => {
    it("updates shipping settings and rounds money the way checkout does", async () => {
        const { token, user } = await registerUser("store-patch");
        await createActiveSeller(user);

        const response = await api("PATCH", "/seller/store", {
            token,
            body: {
                name: "Renamed Store",
                description: "A renamed demo storefront with a longer description.",
                shippingFee: 75.456,
                freeShippingThreshold: 1200.345,
                deliveryEstimateDays: { min: 3, max: 7 },
                location: "Chattogram, Chattogram"
            }
        });

        assert.equal(response.status, 200, response.raw);
        const { store } = response.body.data;
        assert.equal(store.name, "Renamed Store");
        assert.equal(store.shippingFee, roundMoney(75.456));
        assert.equal(store.freeShippingThreshold, roundMoney(1200.345));
        assert.deepEqual(store.deliveryEstimateDays, { min: 3, max: 7 });
        assert.equal(store.location, "Chattogram, Chattogram");

        const reread = await api("GET", "/seller/store", { token });
        assert.equal(reread.body.data.store.shippingFee, roundMoney(75.456), "the write is persisted");
        assertNoMongoIds(response.raw, "store patch response");
    });

    it("rejects unknown and immutable fields by name", async () => {
        const { token, user } = await registerUser("store-immutable");
        await createActiveSeller(user);

        const unknown = await api("PATCH", "/seller/store", { token, body: { colour: "red" } });
        assert.equal(unknown.status, 422);
        assert.equal(unknown.body.error.code, "validation_failed");
        assert.equal(unknown.body.error.fields[0].field, "colour");

        for (const field of ["status", "sellerId", "ratingAvg", "productCount", "verified", "id"]) {
            const response = await api("PATCH", "/seller/store", { token, body: { [field]: "nope" } });
            assert.equal(response.status, 422, `${field} must be refused`);
            assert.equal(response.body.error.fields[0].field, field, `${field} must be named in the error`);
        }

        const empty = await api("PATCH", "/seller/store", { token, body: {} });
        assert.equal(empty.status, 422);

        const stored = await Store.findOne({});
        assert.equal(stored.name, "Active Store", "no rejected field reached the datastore");
    });

    it("leaves another seller's store untouched", async () => {
        const sellerA = await registerUser("store-a");
        const a = await createActiveSeller(sellerA.user);
        const sellerB = await registerUser("store-b");
        const b = await createActiveSeller(sellerB.user);

        const response = await api("PATCH", "/seller/store", {
            token: sellerB.token,
            body: { name: "B Renamed", shippingFee: 25 }
        });
        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.store.id, String(b.store._id));

        const storeA = await Store.findById(a.store._id);
        assert.equal(storeA.name, "Active Store", "seller A's store is unchanged");
        assert.equal(storeA.shippingFee, 60);

        const readA = await api("GET", "/seller/store", { token: sellerA.token });
        assert.equal(readA.body.data.store.name, "Active Store");
    });

    it("toggles store status active -> paused -> active", async () => {
        const { token, user } = await registerUser("store-status");
        await createActiveSeller(user);

        const pause = await api("POST", "/seller/store/status", { token, body: { status: "paused" } });
        assert.equal(pause.status, 200, pause.raw);
        assert.equal(pause.body.data.store.status, "paused");

        const resume = await api("POST", "/seller/store/status", { token, body: { status: "active" } });
        assert.equal(resume.status, 200);
        assert.equal(resume.body.data.store.status, "active");

        const stored = await Store.findOne({});
        assert.equal(stored.status, "active");
    });

    it("refuses a status that is neither active nor paused", async () => {
        const { token, user } = await registerUser("store-bad-status");
        await createActiveSeller(user);

        const response = await api("POST", "/seller/store/status", { token, body: { status: "archived" } });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.fields[0].field, "status");

        const stored = await Store.findOne({});
        assert.equal(stored.status, "active", "the store keeps its real status");
    });
});

// ------------------------------------------------------------------- catalog

describe("GET /catalog/categories", () => {
    it("serves the ordered category tree without any authentication", async () => {
        const parentB = await Category.create({ name: "Second", icon: "\u{1F6D2}", image: "p:\u{1F6D2}:b", order: 1 });
        const parentA = await Category.create({ name: "First", icon: "\u{1F454}", image: "p:\u{1F454}:a", order: 0 });
        const childB = await Category.create({ name: "Child B", icon: "\u{1F454}", parentId: parentA._id, order: 1 });
        const childA = await Category.create({ name: "Child A", icon: "\u{1F454}", parentId: parentA._id, order: 0 });

        const response = await fetch(`${origin}/api/v1/catalog/categories`, { headers: { accept: "application/json" } });
        const body = await response.json();
        const raw = JSON.stringify(body);

        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assertNoMongoIds(raw, "categories response");

        const categories = body.data.categories;
        assert.equal(categories.length, 4);
        assert.deepEqual(
            categories.map((entry) => entry.id),
            [String(parentA._id), String(childA._id), String(childB._id), String(parentB._id)],
            "top level first by order, then each parent's children by order"
        );
        assert.equal(categories[0].parentId, null);
        assert.equal(categories[1].parentId, String(parentA._id));
        for (const entry of categories) {
            assert.equal(typeof entry.name, "string");
            assert.equal(typeof entry.icon, "string");
            assert.equal(typeof entry.image, "string");
            assert.equal(typeof entry.order, "number");
            assert.ok(Number.isFinite(Date.parse(entry.createdAt)), "categories expose their timestamps");
            assert.ok(Number.isFinite(Date.parse(entry.updatedAt)));
        }
    });
});
