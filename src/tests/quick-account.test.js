/**
 * Quick-account suite (M14).
 *
 * Frictionless onboarding: `POST /auth/quick-account` takes only a phone number
 * and the server mints the account (serial "Customer N" display name, unique
 * placeholder email, random password) and starts a session. These assertions
 * are about what a client observes — status, envelope, the public user shape,
 * the field errors, and that the returned token is a real session — against the
 * real Express app on an ephemeral port and a dedicated `vanta_quick_test`
 * database.
 *
 * Run: node --test src/tests/quick-account.test.js
 * The suite drops `vanta_quick_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";

let server;
let origin;

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
    let envelope = null;
    try {
        envelope = JSON.parse(raw);
    } catch {
        envelope = null;
    }
    return { status: response.status, body: envelope, raw };
};

const createQuick = (phone = "01712345678", token) =>
    api("POST", "/auth/quick-account", { body: { phone }, token });

before(async () => {
    process.env.MAIL_PROVIDER = "console";
    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    if (!base) throw new Error("MONGODB_URI must be set to run the quick-account suite.");

    await mongoose.connect(`${base}/vanta_quick_test`);
    await mongoose.connection.dropDatabase();

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise((resolve) => server.close(resolve));
});

describe("POST /auth/quick-account", () => {
    it("creates a customer from just a phone number and starts a session", async () => {
        const response = await createQuick("01711112222");

        assert.equal(response.status, 201, response.raw);
        assert.equal(response.body.ok, true);

        const { user, token, expiresAt } = response.body.data;
        assert.match(user.name, /^Customer \d+$/, "the display name is a serial Customer N");
        assert.equal(user.phone, "01711112222");
        assert.deepEqual(user.roles, ["customer"]);
        assert.match(user.email, /@quick\.vanta\.local$/, "the placeholder email stays on the reserved domain");
        assert.match(token, /^[0-9a-f]{64}$/, "the opaque session token is 32 bytes of hex");
        assert.ok(Date.parse(expiresAt) > Date.now(), "the session expiry is in the future");
        assert.equal(user.passwordHash, undefined, "no secret is ever projected");

        const me = await api("GET", "/auth/me", { token });
        assert.equal(me.status, 200, me.raw);
        assert.equal(me.body.data.user.id, user.id, "the returned token authenticates as the new account");
    });

    it("gives each caller a distinct serial name and email", async () => {
        const first = await createQuick("01722223333");
        const second = await createQuick("01722223344");

        assert.equal(first.status, 201, first.raw);
        assert.equal(second.status, 201, second.raw);
        assert.notEqual(first.body.data.user.name, second.body.data.user.name);
        assert.notEqual(first.body.data.user.email, second.body.data.user.email);
    });

    it("resolves to the existing account when a valid session is presented", async () => {
        const created = await createQuick("01733334444");
        assert.equal(created.status, 201, created.raw);

        const resolved = await createQuick("01733334444", created.body.data.token);
        assert.equal(resolved.status, 201, resolved.raw);
        assert.equal(resolved.body.data.user.id, created.body.data.user.id, "no duplicate account is created");
        assert.notEqual(resolved.body.data.token, created.body.data.token, "a fresh session is issued");
    });

    it("rejects a missing phone with one 422 field error", async () => {
        const response = await api("POST", "/auth/quick-account", { body: {} });

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.ok, false);
        assert.equal(response.body.error.code, "validation_failed");
        const field = response.body.error.fields.find((entry) => entry.field === "phone");
        assert.ok(field, "a phone field error is present");
    });

    it("rejects a malformed phone", async () => {
        const response = await createQuick("abc");

        assert.equal(response.status, 422, response.raw);
        assert.equal(response.body.error.code, "validation_failed");
        assert.ok(response.body.error.fields.some((entry) => entry.field === "phone"));
    });

    it("rejects server-only fields instead of silently ignoring them", async () => {
        const response = await api("POST", "/auth/quick-account", {
            body: { phone: "01755556666", roles: ["seller"] }
        });

        assert.equal(response.status, 422, response.raw);
        const field = response.body.error.fields.find((entry) => entry.field === "roles");
        assert.ok(field, "a roles field error is present");
    });
});

/**
 * First password on a quick account (M14).
 *
 * A quick account is created with a random password nobody saw, so the owner
 * has to be able to choose one once, without a current password, and then sign
 * back in — by phone, because the placeholder email is untypeable. These
 * assertions pin the security edges: the no-password path works exactly once,
 * a normal account can never use it, a phone number alone is never a
 * credential, and afterwards the ordinary current-password rule applies.
 */
describe("quick account password", () => {
    it("starts with no password of its own", async () => {
        const created = await createQuick("01770001111");

        assert.equal(created.status, 201, created.raw);
        assert.equal(created.body.data.user.hasPassword, false, "the minted password is not the owner's");
    });

    it("sets a first password once and then signs in by phone plus password", async () => {
        const created = await createQuick("01766667777");
        const { token, user } = created.body.data;

        const set = await api("POST", "/auth/me/password/initial", {
            token,
            body: { newPassword: "Sup3rSecret!" }
        });
        assert.equal(set.status, 200, set.raw);
        assert.equal(set.body.data.changed, true);

        const me = await api("GET", "/auth/me", { token });
        assert.equal(me.body.data.user.hasPassword, true, "the flag flips with the password");

        const byPhone = await api("POST", "/auth/login", {
            body: { email: user.phone, password: "Sup3rSecret!" }
        });
        assert.equal(byPhone.status, 200, byPhone.raw);
        assert.equal(byPhone.body.data.user.id, user.id, "the phone resolves to the account whose password matched");

        const wrong = await api("POST", "/auth/login", {
            body: { email: user.phone, password: "definitely-not-it" }
        });
        assert.equal(wrong.status, 401);
    });

    it("refuses a second use of the one-time path", async () => {
        const created = await createQuick("01766667777");
        const { token } = created.body.data;

        await api("POST", "/auth/me/password/initial", { token, body: { newPassword: "Sup3rSecret!" } });

        const again = await api("POST", "/auth/me/password/initial", {
            token,
            body: { newPassword: "EvenM0reSecret!" }
        });
        assert.equal(again.status, 409, again.raw);
        assert.equal(again.body.error.code, "conflict");
    });

    it("does not let a normal account skip its current password", async () => {
        const registered = await api("POST", "/auth/register", {
            body: {
                name: "Ada Lovelace",
                email: `qap-normal-${Date.now()}@example.com`,
                phone: "01912345678",
                password: "Sup3rSecret!"
            }
        });
        assert.equal(registered.status, 201, registered.raw);
        const { token } = registered.body.data;

        const bypass = await api("POST", "/auth/me/password/initial", {
            token,
            body: { newPassword: "EvenM0reSecret!" }
        });
        assert.equal(bypass.status, 409, bypass.raw);
        assert.equal(bypass.body.error.code, "conflict");
    });

    it("never signs in on a phone number alone", async () => {
        const created = await createQuick("01788889999");
        const phone = created.body.data.user.phone;

        const noPassword = await api("POST", "/auth/login", { body: { email: phone } });
        assert.equal(noPassword.status, 422, noPassword.raw);
        assert.equal(noPassword.body.error.code, "validation_failed");
    });

    it("still requires the current password to change it afterwards", async () => {
        const created = await createQuick("01777770000");
        const { token } = created.body.data;
        await api("POST", "/auth/me/password/initial", { token, body: { newPassword: "Sup3rSecret!" } });

        const wrongCurrent = await api("POST", "/auth/me/password", {
            token,
            body: { currentPassword: "not-the-one", newPassword: "EvenM0reSecret!" }
        });
        assert.equal(wrongCurrent.status, 422, wrongCurrent.raw);
        assert.equal(wrongCurrent.body.error.fields[0].field, "currentPassword");

        const goodCurrent = await api("POST", "/auth/me/password", {
            token,
            body: { currentPassword: "Sup3rSecret!", newPassword: "EvenM0reSecret!" }
        });
        assert.equal(goodCurrent.status, 200, goodCurrent.raw);
    });
});

