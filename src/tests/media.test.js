/**
 * Seller media slice suite (M13).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_media_test` database, so every assertion below is about what a
 * client would actually observe: status, envelope, error code, message and
 * the state of `./public/temp` afterwards — not about internal calls.
 *
 * Run: node --test src/tests/media.test.js
 *
 * No test in this file performs a real Cloudinary upload: the cases stop at
 * the intake rules (auth, role, missing file, type, size) plus the delete
 * rules, where the only storage call is the idempotent "already gone" delete
 * of case 9 — and that one branches on whether CLOUDINARY_* credentials are
 * configured. No credential value is ever printed.
 *
 * The suite drops `vanta_media_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";

import { app } from "../app.js";
import sellerMediaRouter from "../routes/seller-media.route.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";

const PASSWORD = "Sup3rSecret!";

/** The multer staging folder this slice stages (and must clear) files in. */
const TEMP_DIR = path.resolve("public/temp");

/** Same folder the middleware uses, resolved from this process's cwd. */
const listTempFiles = () => (fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR).sort() : null);

const CLOUDINARY_CONFIGURED = Boolean(
    (process.env.CLOUDINARY_API_NAME ?? "").trim() &&
    (process.env.CLOUDINARY_API_KEY ?? "").trim() &&
    (process.env.CLOUDINARY_API_SECRET ?? "").trim()
);

let server;
let origin;
let sequence = 0;
let ctx;
let baseline;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `media-${label}-${++sequence}-${Date.now()}@example.com`;

const parse = async (response) => {
    const raw = await response.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch {
        json = null;
    }
    return { status: response.status, body: json, raw };
};

const api = async (method, path, { body, token } = {}) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;

    return parse(
        await fetch(`${origin}/api/v1${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body)
        })
    );
};

/**
 * Multipart POST to the upload endpoint. `file` is null to send a body that
 * carries fields but no `file` part; otherwise it is `{filename, content,
 * type}` and the bytes go out as a real multipart file part.
 */
const uploadRequest = async (token, file) => {
    const form = new FormData();
    if (file) form.append("file", new File([file.content], file.filename, { type: file.type }));
    else form.append("note", "a body with no file part");

    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;

    return parse(await fetch(`${origin}/api/v1/seller/media`, { method: "POST", headers, body: form }));
};

/** Asserts `./public/temp` holds exactly what it held before the suite ran. */
const assertTempClean = (label) => {
    assert.equal(fs.existsSync(TEMP_DIR), true, `${label}: ./public/temp must exist`);
    assert.deepEqual(listTempFiles(), baseline, `${label}: ./public/temp must hold no leftover file`);
};

const registerUser = async (label) => {
    const response = await api("POST", "/auth/register", {
        body: { name: "Ada Lovelace", email: uniqueEmail(label), phone: "01712345678", password: PASSWORD }
    });
    assert.equal(response.status, 201, response.raw);
    return { token: response.body.data.token, user: response.body.data.user };
};

const AGREEMENT = {
    marketplaceTerms: true,
    sellerPolicies: true,
    productAuthenticity: true,
    fulfillmentResponsibility: true
};

/** An approved seller created directly, the way the approve endpoint leaves it. */
const createActiveSeller = async (user, label) => {
    const profile = await SellerProfile.create({
        userId: user.id,
        fullName: `Media Seller ${label}`,
        phone: "01712345678",
        email: user.email,
        nationalId: `199012345678${label}`,
        sellerType: "individual",
        storeName: `Media Store ${label}`,
        storeDescription: "An approved storefront used by the media suite.",
        pickupDivision: "Dhaka",
        pickupDistrict: "Dhaka",
        pickupArea: "Dhanmondi",
        pickupAddressLine: "House 3, Dhanmondi",
        returnDivision: "Dhaka",
        returnDistrict: "Dhaka",
        returnArea: "Dhanmondi",
        returnAddressLine: "House 3, Dhanmondi",
        bank: { bankName: "BRAC Bank", accountName: `Media Seller ${label}`, accountNumber: "12345678901", branch: "Dhanmondi" },
        agreement: { ...AGREEMENT },
        status: "active"
    });

    const store = await Store.create({
        sellerId: profile._id,
        name: `Media Store ${label}`,
        description: "An approved storefront used by the media suite.",
        location: "Dhaka, Dhaka"
    });

    return { profile, store };
};

/** A registered ACTIVE seller, a plain customer, and a SECOND active seller. */
const buildFixtures = async () => {
    const sellerA = await registerUser("a");
    const sellerB = await registerUser("b");
    const customer = await registerUser("customer");

    const a = await createActiveSeller(sellerA.user, "A");
    const b = await createActiveSeller(sellerB.user, "B");

    return {
        sellerA: { ...sellerA, profile: a.profile, store: a.store },
        sellerB: { ...sellerB, profile: b.profile, store: b.store },
        customer
    };
};

/** A Cloudinary-shaped delivery URL inside a given seller's namespace. */
const cloudinaryUrl = (sellerId, name = "x.png") =>
    `https://res.cloudinary.com/vanta-demo/image/upload/v1/vanta/sellers/${sellerId}/${name}`;

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the media suite");

    // app.js does not mount the media router yet (the coordinator adds
    // `app.use("/api/v1", sellerMediaRouter);`). For this suite the router is
    // mounted the same way, inserted directly before the not-found handler so
    // every other route keeps behaving exactly as before.
    app.use("/api/v1", sellerMediaRouter);
    const stack = app.router.stack;
    const mediaLayer = stack.pop();
    stack.splice(stack.length - 2, 0, mediaLayer);

    await mongoose.connect(`${base}/vanta_media_test`);

    server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    origin = `http://127.0.0.1:${server.address().port}`;

    // whatever the developer already had staged is theirs, not ours
    baseline = listTempFiles();
    assert.notEqual(baseline, null, "./public/temp must exist (the multer middleware creates it)");
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

describe("seller media", () => {
    it("1. an unauthenticated upload is 401 before anything is staged", async () => {
        const res = await uploadRequest(null, { filename: "pixel.png", content: Buffer.from("png"), type: "image/png" });

        assert.equal(res.status, 401, res.raw);
        assert.equal(res.body.error.code, "unauthorized");
        assertTempClean("unauthenticated upload");
    });

    it("2. a customer without a seller account is 403", async () => {
        const res = await uploadRequest(ctx.customer.token, { filename: "pixel.png", content: Buffer.from("png"), type: "image/png" });

        assert.equal(res.status, 403, res.raw);
        assert.equal(res.body.error.code, "forbidden");
        assert.equal(res.body.error.message, "You do not have a seller account.");
        assertTempClean("customer upload");
    });

    it("3. a multipart body with no file field is 422 'No file was uploaded.'", async () => {
        const res = await uploadRequest(ctx.sellerA.token, null);

        assert.equal(res.status, 422, res.raw);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "No file was uploaded.");
        assert.equal(res.body.error.fields[0].field, "file");
        assertTempClean("missing file field");
    });

    it("4. a .txt upload is refused with the unsupported-type 422 and no temp file", async () => {
        const res = await uploadRequest(ctx.sellerA.token, {
            filename: "notes.txt",
            content: Buffer.from("plain text, not an image"),
            type: "text/plain"
        });

        assert.equal(res.status, 422, res.raw);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "That file type is not supported.");
        assertTempClean("rejected file type");
    });

    it("5. an 11 MB file is refused with the size 422 and the partial is removed", async () => {
        const oversized = Buffer.alloc(11 * 1024 * 1024, 0x61);
        const res = await uploadRequest(ctx.sellerA.token, {
            filename: "huge.png",
            content: oversized,
            type: "image/png"
        });

        assert.equal(res.status, 422, res.raw);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "That file is too large. The maximum size is 10 MB.");
        assertTempClean("oversized upload");
    });

    it("6. DELETE without url, or with an injected identity field, is a 422", async () => {
        const missing = await api("DELETE", "/seller/media", { token: ctx.sellerA.token, body: {} });
        assert.equal(missing.status, 422, missing.raw);
        assert.equal(missing.body.error.code, "validation_failed");
        assert.ok(
            missing.body.error.fields.some((entry) => entry.field === "url"),
            "the missing url is reported as a field error"
        );

        const injected = await api("DELETE", "/seller/media", {
            token: ctx.sellerA.token,
            body: { url: cloudinaryUrl(String(ctx.sellerA.profile._id)), userId: String(ctx.customer.user.id) }
        });
        assert.equal(injected.status, 422, injected.raw);
        assert.equal(injected.body.error.code, "validation_failed");
        assert.ok(
            injected.body.error.fields.some((entry) => entry.field === "userId"),
            "an identity key in the body is refused, never read"
        );
    });

    it("7. a non-Cloudinary url is 422 'That media URL is not managed by Vanta.'", async () => {
        const res = await api("DELETE", "/seller/media", {
            token: ctx.sellerA.token,
            body: { url: "p:\u{1F6CD}\u{FE0F}:Thing" }
        });

        assert.equal(res.status, 422, res.raw);
        assert.equal(res.body.error.code, "validation_failed");
        assert.equal(res.body.error.message, "That media URL is not managed by Vanta.");
    });

    it("8. a URL under another seller's namespace is the same 404 as a missing asset (no IDOR)", async () => {
        // crafted with seller A's namespace while authenticated as seller B
        const res = await api("DELETE", "/seller/media", {
            token: ctx.sellerB.token,
            body: { url: cloudinaryUrl(String(ctx.sellerA.profile._id)) }
        });

        assert.equal(res.status, 404, res.raw);
        assert.equal(res.body.error.code, "not_found");
        assert.equal(res.body.error.message, "Media not found.");

        // The namespace check happens before any storage call, so the answer
        // is the same 404 whether or not Cloudinary is reachable — a foreign
        // asset is never probed, which is what keeps this from being an IDOR
        // oracle.
        const unknownSeller = await api("DELETE", "/seller/media", {
            token: ctx.sellerB.token,
            body: { url: cloudinaryUrl(new mongoose.Types.ObjectId().toString()) }
        });
        assert.equal(unknownSeller.status, 404, unknownSeller.raw);
        assert.equal(unknownSeller.body.error.message, res.body.error.message, "no oracle: same message either way");
    });

    it("9. deleting one's own non-existent asset is idempotent success (500 without credentials)", async () => {
        const ownUrl = cloudinaryUrl(String(ctx.sellerB.profile._id), `ghost-${Date.now()}.png`);
        const res = await api("DELETE", "/seller/media", { token: ctx.sellerB.token, body: { url: ownUrl } });

        if (CLOUDINARY_CONFIGURED) {
            // Cloudinary answers `{result: "not found"}` for an asset that is
            // already gone — that IS a successful delete.
            assert.equal(res.status, 200, res.raw);
            assert.deepEqual(res.body.data, { deleted: true });
        } else {
            // no credentials: the destroy call fails and is a 500, not a lie
            assert.equal(res.status, 500, res.raw);
            assert.equal(res.body.error.code, "internal_error");
            assert.equal(res.body.error.message, "The file could not be deleted. Please try again.");
        }
    });

    it("10. ./public/temp exists and holds no file staged by this suite", () => {
        assert.equal(fs.existsSync(TEMP_DIR), true, "the middleware keeps the staging folder alive");
        assert.deepEqual(listTempFiles(), baseline, "nothing this suite uploaded is left behind");
    });
});
