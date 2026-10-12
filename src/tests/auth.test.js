/**
 * Authentication foundation suite.
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_test` database on the configured MongoDB, so every assertion below is
 * about what a client would actually observe: status, envelope, error code,
 * field errors and the `x-request-id` correlation — not about internal calls.
 *
 * Run: npm test  (node --test src/tests/)
 *
 * The suite drops `vanta_test` when it finishes; it never touches the
 * application database.
 */
import "dotenv/config";
import express from "express";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import { createRateLimit } from "../middlewares/rateLimit.middleware.js";
import { errorHandler } from "../middlewares/error.middleware.js";
import { Session } from "../models/session.model.js";
import { PasswordReset } from "../models/password-reset.model.js";
import { getOutbox, clearOutbox } from "../services/mailer.js";

const PASSWORD = "Sup3rSecret!";
const OTHER_PASSWORD = "EvenM0reSecret!";

let server;
let origin;
let sequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `auth-${label}-${++sequence}-${Date.now()}@example.com`;

const api = async (method, path, { body, token, cookie, requestId } = {}) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (cookie) headers.cookie = cookie;
    if (requestId) headers["x-request-id"] = requestId;

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

    return {
        status: response.status,
        body: json,
        raw,
        requestId: response.headers.get("x-request-id"),
        setCookie: typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : []
    };
};

/** The auth cookie exactly as it would travel back to a client's cookie jar. */
const authCookieFrom = (response) => {
    const headers = response.setCookie.join("\n");
    const match = /(?:^|\n)accessToken=([^;]*)/.exec(headers);
    assert.ok(match, `expected an accessToken cookie, got: ${headers || "(none)"}`);
    return `accessToken=${match[1]}`;
};

const registerUser = async (label = "user", overrides = {}) => {
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

const login = async (email, password) => {
    const response = await api("POST", "/auth/login", { body: { email, password } });
    return { response, token: response.body?.data?.token };
};

/** Pulls the token out of the message the console transport "sent". */
const lastResetToken = () => {
    const outbox = getOutbox();
    assert.ok(outbox.length > 0, "expected a reset mail in the outbox");
    const match = /token=([0-9a-f]{64})/.exec(outbox[outbox.length - 1].text);
    assert.ok(match, "expected a 64-char hex token in the reset mail");
    return match[1];
};

/** Compares two responses ignoring the request id, which is unique per call. */
const assertSameAnswer = (left, right) => {
    assert.equal(left.status, right.status, "statuses must match");
    assert.deepEqual(left.body.data, right.body.data, "payloads must match");
    assert.equal(left.body.ok, right.body.ok);
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    // Whatever `.env` says, the suite exercises the console provider and its
    // outbox — automated tests never send real mail.
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the auth suite");

    await mongoose.connect(`${base}/vanta_test`);

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
    clearOutbox();
});

// ---------------------------------------------------------------- registration

describe("registration", () => {
    it("creates an account, signs it in and never returns password material", async () => {
        const email = uniqueEmail("valid");
        const response = await api("POST", "/auth/register", {
            body: { name: "Ada Lovelace", email, phone: "01712345678", password: PASSWORD }
        });

        assert.equal(response.status, 201);
        assert.equal(response.body.ok, true);
        assert.equal(response.body.error, undefined);

        const { user, token, expiresAt } = response.body.data;
        assert.equal(user.email, email);
        assert.equal(user.name, "Ada Lovelace");
        assert.deepEqual(user.roles, ["customer"]);
        assert.equal(typeof user.id, "string");
        assert.ok(!Number.isNaN(Date.parse(expiresAt)), "expiresAt must be an instant");

        for (const key of ["password", "passwordHash", "passwordSalt"]) {
            assert.equal(user[key], undefined, `${key} must not be in the response`);
        }
        assert.ok(!response.raw.includes(PASSWORD), "the password itself must never be echoed");
        assert.ok(response.raw.includes('"token"'), "registration signs the user in");

        const me = await api("GET", "/auth/me", { token });
        assert.equal(me.status, 200);
        assert.equal(me.body.data.user.email, email);
    });

    it("rejects a duplicate email with 409 conflict", async () => {
        const { email } = await registerUser("dup");
        const response = await api("POST", "/auth/register", {
            body: { name: "Impostor", email, phone: "01712345678", password: PASSWORD }
        });

        assert.equal(response.status, 409);
        assert.equal(response.body.ok, false);
        assert.equal(response.body.error.code, "conflict");
    });

    it("rejects a malformed email with validation_failed and names the field", async () => {
        const response = await api("POST", "/auth/register", {
            body: { name: "Ada Lovelace", email: "not-an-email", phone: "01712345678", password: PASSWORD }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.deepEqual(
            response.body.error.fields.map((entry) => entry.field),
            ["email"]
        );
    });

    it("reports every missing field at once", async () => {
        const response = await api("POST", "/auth/register", { body: {} });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        const fields = response.body.error.fields.map((entry) => entry.field).sort();
        assert.deepEqual(fields, ["email", "name", "password", "phone"]);
    });

    it("refuses a client-supplied seller role", async () => {
        const response = await api("POST", "/auth/register", {
            body: {
                name: "Ada Lovelace",
                email: uniqueEmail("role-seller"),
                phone: "01712345678",
                password: PASSWORD,
                roles: ["seller"]
            }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.fields[0].field, "roles");
        assert.equal(await mongoose.model("User").countDocuments(), 0, "no account may be created");
    });

    it("refuses a client-supplied seller_approver role", async () => {
        const response = await api("POST", "/auth/register", {
            body: {
                name: "Ada Lovelace",
                email: uniqueEmail("role-approver"),
                phone: "01712345678",
                password: PASSWORD,
                roles: ["seller_approver"]
            }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.fields[0].field, "roles");
        assert.equal(await mongoose.model("User").countDocuments(), 0);
    });

    it("refuses password material supplied by the client", async () => {
        const response = await api("POST", "/auth/register", {
            body: {
                name: "Ada Lovelace",
                email: uniqueEmail("role-hash"),
                phone: "01712345678",
                password: PASSWORD,
                passwordHash: "$2b$12$whatever"
            }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.fields[0].field, "passwordHash");
    });
});

// ---------------------------------------------------------------------- login

describe("login", () => {
    it("signs in with correct credentials and creates a session", async () => {
        const { email } = await registerUser("login-ok");
        const { response, token } = await login(email, PASSWORD);

        assert.equal(response.status, 200);
        assert.equal(response.body.data.user.email, email);
        assert.ok(token);

        const sessions = await Session.find({});
        assert.equal(sessions.length, 2, "register and login each keep one live session");
        assert.ok(sessions[0].tokenHash);
        assert.ok(!JSON.stringify(sessions).includes(token), "the raw token must not be stored");
    });

    it("answers a wrong password with 401 unauthorized", async () => {
        const { email } = await registerUser("login-wrong");
        const { response } = await login(email, "definitely-not-it");

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "unauthorized");
    });

    it("answers an unknown account with exactly the same message as a wrong password", async () => {
        const { email } = await registerUser("login-known");
        const known = await login(email, "definitely-not-it");
        const unknown = await login(uniqueEmail("login-unknown"), PASSWORD);

        assert.equal(known.response.status, 401);
        assert.equal(unknown.response.status, 401);
        assert.equal(known.response.body.error.message, unknown.response.body.error.message);
        assert.equal(known.response.body.error.code, unknown.response.body.error.code);
    });

    it("rejects malformed input before touching the database", async () => {
        const response = await api("POST", "/auth/login", { body: { email: "nope", password: "" } });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        const fields = response.body.error.fields.map((entry) => entry.field).sort();
        assert.deepEqual(fields, ["email", "password"]);
    });

    it("issues a separate session per sign-in", async () => {
        const { email } = await registerUser("login-two");
        await login(email, PASSWORD);
        await login(email, PASSWORD);

        assert.equal(await Session.countDocuments(), 3);
    });
});

// ------------------------------------------------------------------- sessions

describe("sessions", () => {
    it("accepts a valid bearer token", async () => {
        const { token, email } = await registerUser("bearer-ok");
        const response = await api("GET", "/auth/me", { token });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.user.email, email);
    });

    it("rejects a missing bearer token", async () => {
        const response = await api("GET", "/auth/me");

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "unauthorized");
    });

    it("rejects malformed bearer tokens", async () => {
        await registerUser("bearer-malformed");

        for (const header of ["not-a-token", "Bearer", "Basic abc123", `Bearer ${"z".repeat(64)}`]) {
            const response = await fetch(`${origin}/api/v1/auth/me`, {
                headers: { authorization: header }
            });
            const body = await response.json();
            assert.equal(response.status, 401, `expected 401 for ${header}`);
            assert.equal(body.error.code, "unauthorized");
        }
    });

    it("rejects an expired session and forgets it", async () => {
        const { token } = await registerUser("bearer-expired");
        const [session] = await Session.find({});
        await Session.updateOne({ _id: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

        const response = await api("GET", "/auth/me", { token });

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "unauthorized");
        assert.equal(await Session.countDocuments(), 0, "the expired row is reaped on use");
    });

    it("logout invalidates the current session only", async () => {
        const { email } = await registerUser("logout-one");
        const first = await login(email, PASSWORD);
        const second = await login(email, PASSWORD);

        const logout = await api("POST", "/auth/logout", { token: first.token });
        assert.equal(logout.status, 200);
        assert.equal(logout.body.data.loggedOut, true);

        assert.equal((await api("GET", "/auth/me", { token: first.token })).status, 401);
        assert.equal((await api("GET", "/auth/me", { token: second.token })).status, 200);
    });

    it("logout-all invalidates every session of that account", async () => {
        const { email, token } = await registerUser("logout-all");
        const other = await login(email, PASSWORD);

        const response = await api("POST", "/auth/logout-all", { token });
        assert.equal(response.status, 200);
        assert.equal(response.body.data.loggedOutEverywhere, true);

        assert.equal((await api("GET", "/auth/me", { token })).status, 401);
        assert.equal((await api("GET", "/auth/me", { token: other.token })).status, 401);
        assert.equal(await Session.countDocuments(), 0);
    });

    it("logout-all never touches another account", async () => {
        const victim = await registerUser("logout-victim");
        const bystander = await registerUser("logout-bystander");
        const bystanderSecond = await login(bystander.email, PASSWORD);

        await api("POST", "/auth/logout-all", { token: victim.token });

        assert.equal((await api("GET", "/auth/me", { token: victim.token })).status, 401);
        assert.equal((await api("GET", "/auth/me", { token: bystander.token })).status, 200);
        assert.equal((await api("GET", "/auth/me", { token: bystanderSecond.token })).status, 200);
        assert.equal(await Session.countDocuments({ userId: bystander.user.id }), 2);
    });

    it("caps live sessions per account and evicts the oldest", async () => {
        const previous = process.env.SESSION_MAX_PER_USER;
        process.env.SESSION_MAX_PER_USER = "3";
        try {
            const { email, token } = await registerUser("session-cap");
            const issued = [token];
            for (let index = 0; index < 3; index += 1) {
                issued.push((await login(email, PASSWORD)).token);
            }

            const live = await Session.find({});
            assert.equal(live.length, 3, "the cap holds");

            // The oldest (registration) session is gone; the newest still works.
            assert.equal((await api("GET", "/auth/me", { token: issued[0] })).status, 401);
            assert.equal((await api("GET", "/auth/me", { token: issued[issued.length - 1] })).status, 200);
        } finally {
            if (previous === undefined) delete process.env.SESSION_MAX_PER_USER;
            else process.env.SESSION_MAX_PER_USER = previous;
        }
    });
});

// -------------------------------------------------------------------- profile

describe("profile", () => {
    it("returns the signed-in user's own profile", async () => {
        const { token, user } = await registerUser("profile-read");
        const response = await api("GET", "/auth/me", { token });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.user.id, user.id);
        for (const key of ["passwordHash", "passwordSalt", "password"]) {
            assert.equal(response.body.data.user[key], undefined);
        }
        assert.ok(!response.raw.includes("$2b$"), "no bcrypt material may leave the server");
    });

    it("updates allowed profile fields", async () => {
        const { token, user } = await registerUser("profile-update");
        const response = await api("PATCH", "/auth/me", { token, body: { name: "Augusta Ada", phone: "01811111111" } });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.user.name, "Augusta Ada");
        assert.equal(response.body.data.user.phone, "01811111111");
        assert.equal(response.body.data.user.id, user.id);
        assert.deepEqual(response.body.data.user.roles, ["customer"]);
    });

    it("refuses to change roles through a profile update", async () => {
        const { token, user } = await registerUser("profile-roles");
        const response = await api("PATCH", "/auth/me", { token, body: { roles: ["seller", "seller_approver"] } });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.fields[0].field, "roles");

        const stored = await mongoose.model("User").findById(user.id);
        assert.deepEqual(stored.roles, ["customer"], "roles must be untouched in the datastore");
    });

    it("refuses an email that already belongs to someone else", async () => {
        const owner = await registerUser("profile-owner");
        const { token } = await registerUser("profile-thief");
        const response = await api("PATCH", "/auth/me", { token, body: { email: owner.email } });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.fields[0].field, "email");
    });
});

// ------------------------------------------------------------- password change

describe("password change", () => {
    it("accepts the correct current password and signs other devices out", async () => {
        const { email, token } = await registerUser("pw-change");
        const otherDevice = await login(email, PASSWORD);

        const response = await api("POST", "/auth/me/password", {
            token,
            body: { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD }
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.changed, true);
        assert.equal(response.body.data.otherSessionsRevoked, true);

        assert.equal((await api("GET", "/auth/me", { token })).status, 200, "the caller stays signed in");
        assert.equal((await api("GET", "/auth/me", { token: otherDevice.token })).status, 401);

        const withNew = await login(email, OTHER_PASSWORD);
        assert.equal(withNew.response.status, 200);
        const withOld = await login(email, PASSWORD);
        assert.equal(withOld.response.status, 401);
    });

    it("rejects a wrong current password and leaves the account alone", async () => {
        const { email, token } = await registerUser("pw-wrong");
        const response = await api("POST", "/auth/me/password", {
            token,
            body: { currentPassword: "not-the-one", newPassword: OTHER_PASSWORD }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.code, "validation_failed");
        assert.equal(response.body.error.fields[0].field, "currentPassword");

        const unchanged = await login(email, PASSWORD);
        assert.equal(unchanged.response.status, 200, "the old password must still work");
    });

    it("refuses a new password that is too short or identical", async () => {
        const { token } = await registerUser("pw-policy");

        const short = await api("POST", "/auth/me/password", {
            token,
            body: { currentPassword: PASSWORD, newPassword: "abc" }
        });
        assert.equal(short.status, 422);
        assert.equal(short.body.error.fields[0].field, "newPassword");

        const same = await api("POST", "/auth/me/password", {
            token,
            body: { currentPassword: PASSWORD, newPassword: PASSWORD }
        });
        assert.equal(same.status, 422);
        assert.equal(same.body.error.fields[0].field, "newPassword");
    });

    it("requires an authenticated session", async () => {
        const response = await api("POST", "/auth/me/password", {
            body: { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD }
        });

        assert.equal(response.status, 401);
        assert.equal(response.body.error.code, "unauthorized");
    });
});

// ------------------------------------------------------------ password reset

describe("password reset", () => {
    it("answers a known address with an accepted response and mails one link", async () => {
        const { email } = await registerUser("reset-known");
        const response = await api("POST", "/auth/password-reset/request", { body: { email } });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.accepted, true);
        assert.equal(response.body.data.expiresInMinutes, 30);
        assert.equal(getOutbox().length, 1);
        lastResetToken();
    });

    it("gives an unknown address the identical answer and sends nothing", async () => {
        const { email } = await registerUser("reset-identical");
        const known = await api("POST", "/auth/password-reset/request", { body: { email } });
        const knownMail = getOutbox().length;
        clearOutbox();

        const unknown = await api("POST", "/auth/password-reset/request", {
            body: { email: uniqueEmail("reset-never") }
        });

        assertSameAnswer(known, unknown);
        assert.equal(getOutbox().length, 0, "no mail is produced for an unknown address");
        assert.equal(knownMail, 1);
    });

    it("stores only a digest of the token", async () => {
        const { email } = await registerUser("reset-digest");
        await api("POST", "/auth/password-reset/request", { body: { email } });
        const token = lastResetToken();

        const [record] = await PasswordReset.find({});
        assert.ok(record, "a ticket exists");
        assert.equal(record.tokenHash.length, 64);
        assert.ok(!JSON.stringify(await PasswordReset.find({})).includes(token), "no plaintext token is stored");
        assert.equal(token.length, 64);
    });

    it("accepts a valid token once and refuses the replay", async () => {
        const { email } = await registerUser("reset-single-use");
        await api("POST", "/auth/password-reset/request", { body: { email } });
        const token = lastResetToken();

        const first = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: OTHER_PASSWORD }
        });
        assert.equal(first.status, 200);
        assert.equal(first.body.data.reset, true);

        const replay = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: "Third0neSecret!" }
        });
        assert.equal(replay.status, 422);
        assert.equal(replay.body.error.code, "validation_failed");
        assert.equal(replay.body.error.fields[0].field, "token");
    });

    it("rejects an expired token", async () => {
        const { email } = await registerUser("reset-expired");
        await api("POST", "/auth/password-reset/request", { body: { email } });
        const token = lastResetToken();
        await PasswordReset.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

        const response = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: OTHER_PASSWORD }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.fields[0].field, "token");
    });

    it("rejects a tampered token and a malformed one", async () => {
        const { email } = await registerUser("reset-tampered");
        await api("POST", "/auth/password-reset/request", { body: { email } });
        const token = lastResetToken();

        const tampered = `${token.slice(0, -1)}${token.at(-1) === "0" ? "1" : "0"}`;
        const tamperedResponse = await api("POST", "/auth/password-reset/confirm", {
            body: { token: tampered, newPassword: OTHER_PASSWORD }
        });
        assert.equal(tamperedResponse.status, 422);
        assert.equal(tamperedResponse.body.error.fields[0].field, "token");

        const malformed = await api("POST", "/auth/password-reset/confirm", {
            body: { token: "definitely-not-a-token", newPassword: OTHER_PASSWORD }
        });
        assert.equal(malformed.status, 422);
        assert.equal(malformed.body.error.fields[0].field, "token");

        // Nothing was changed: the original password still works.
        const stillOriginal = await login(email, PASSWORD);
        assert.equal(stillOriginal.response.status, 200);
    });

    it("a second request invalidates the first token", async () => {
        const { email } = await registerUser("reset-second");
        await api("POST", "/auth/password-reset/request", { body: { email } });
        const firstToken = lastResetToken();

        await api("POST", "/auth/password-reset/request", { body: { email } });
        const secondToken = lastResetToken();
        assert.notEqual(firstToken, secondToken);

        const stale = await api("POST", "/auth/password-reset/confirm", {
            body: { token: firstToken, newPassword: OTHER_PASSWORD }
        });
        assert.equal(stale.status, 422);

        const fresh = await api("POST", "/auth/password-reset/confirm", {
            body: { token: secondToken, newPassword: OTHER_PASSWORD }
        });
        assert.equal(fresh.status, 200);

        const signedIn = await login(email, OTHER_PASSWORD);
        assert.equal(signedIn.response.status, 200);
    });

    it("a successful reset revokes every session and changes the password", async () => {
        const { email, token } = await registerUser("reset-revoke");
        const secondDevice = await login(email, PASSWORD);

        await api("POST", "/auth/password-reset/request", { body: { email } });
        const resetToken = lastResetToken();

        const response = await api("POST", "/auth/password-reset/confirm", {
            body: { token: resetToken, newPassword: OTHER_PASSWORD }
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.data.sessionsRevoked, 2, "both live sessions die with the reset");

        assert.equal((await api("GET", "/auth/me", { token })).status, 401);
        assert.equal((await api("GET", "/auth/me", { token: secondDevice.token })).status, 401);
        assert.equal(await Session.countDocuments(), 0);

        const oldPassword = await login(email, PASSWORD);
        assert.equal(oldPassword.response.status, 401);
        const newPassword = await login(email, OTHER_PASSWORD);
        assert.equal(newPassword.response.status, 200);
    });

    it("rejects an invalid new password without consuming the ticket", async () => {
        const { email } = await registerUser("reset-weak");
        await api("POST", "/auth/password-reset/request", { body: { email } });
        const token = lastResetToken();

        const response = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: "abc" }
        });

        assert.equal(response.status, 422);
        assert.equal(response.body.error.fields[0].field, "newPassword");

        const retry = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: OTHER_PASSWORD }
        });
        assert.equal(retry.status, 200, "a rejected password must not spend the token");
    });
});

// --------------------------------------------------------- envelope & plumbing

describe("envelope and plumbing", () => {
    it("wraps success in ok/data/meta and carries the request id", async () => {
        const { token } = await registerUser("envelope-ok");
        const response = await api("GET", "/auth/me", { token, requestId: "client-side-id" });

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(typeof response.body.data, "object");
        assert.equal(typeof response.body.meta.message, "string");
        // The client reads the trace id off the response header (api-client.ts),
        // success envelopes only promise meta.message.
        assert.equal(response.requestId, "client-side-id");
        assert.equal(response.body.meta.message, "Current user.");
    });

    it("wraps failures in ok:false/error/meta with a known code", async () => {
        const response = await api("GET", "/auth/me");

        assert.equal(response.status, 401);
        assert.equal(response.body.ok, false);
        assert.equal(response.body.error.code, "unauthorized");
        assert.equal(response.body.meta.requestId, response.requestId);
        assert.ok(response.requestId, "every response is traceable");
        assert.equal(response.body.error.stack, undefined, "stacks never leave the server");
    });

    it("answers an unknown route with a JSON not_found", async () => {
        const response = await api("GET", "/auth/does-not-exist");

        assert.equal(response.status, 404);
        assert.equal(response.body.error.code, "not_found");
    });

    it("answers malformed JSON with validation_failed rather than a parser dump", async () => {
        const response = await fetch(`${origin}/api/v1/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{not json"
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.ok, false);
        assert.equal(body.error.code, "validation_failed");
        assert.equal(body.error.message, "Request body is not valid JSON.");
        assert.ok(!body.error.stack, "no stack in the payload");
    });

    it("keeps health and readiness working", async () => {
        const health = await api("GET", "/health");
        assert.equal(health.status, 200);
        assert.equal(health.body.data.status, "ok");
        assert.equal(health.body.data.database.ok, true);
        assert.equal(health.body.data.database.driver, "mongo");

        const ready = await api("GET", "/health/ready");
        assert.equal(ready.status, 200);
        assert.equal(ready.body.data.ready, true);
    });
});

// ------------------------------------------------------ cookie authentication

describe("cookie authentication", () => {
    it("login issues the accessToken cookie with safe options", async () => {
        const { email } = await registerUser("cookie-login");
        const response = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.token.length, 64, "the bearer token is still in the body");

        const setCookie = response.setCookie.join("\n");
        const line = /accessToken=[^;\n]*/.exec(setCookie)?.[0];
        assert.ok(line, `expected an accessToken cookie, got: ${setCookie || "(none)"}`);
        assert.match(setCookie, /HttpOnly/i);
        assert.match(setCookie, /Path=\//i);
        assert.match(setCookie, /SameSite=Lax/i);
        assert.match(setCookie, /Max-Age=2592000/, "cookie life matches the 30 day session TTL");
        assert.doesNotMatch(setCookie, /; *Secure/i, "Secure is a production-only switch");
    });

    it("register issues the same cookie as login", async () => {
        const response = await api("POST", "/auth/register", {
            body: {
                name: "Ada Lovelace",
                email: uniqueEmail("cookie-register"),
                phone: "01712345678",
                password: PASSWORD
            }
        });

        assert.equal(response.status, 201);
        const cookie = authCookieFrom(response);
        assert.ok(cookie.length > "accessToken=".length);
        assert.match(response.setCookie.join("\n"), /HttpOnly/i);
    });

    it("authenticates /auth/me from the cookie alone", async () => {
        const { email } = await registerUser("cookie-only");
        const { token } = await login(email, PASSWORD);
        const cookie = authCookieFrom(await api("POST", "/auth/login", { body: { email, password: PASSWORD } }));

        const response = await api("GET", "/auth/me", { cookie });

        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.data.user.email, email);
        assert.equal(typeof token, "string");
    });

    it("authenticates /auth/me from the bearer alone", async () => {
        const { email, token } = await registerUser("bearer-only-cookie-suite");
        const { response } = await login(email, PASSWORD);
        const cookie = authCookieFrom(response);

        const withBearer = await api("GET", "/auth/me", { token });
        assert.equal(withBearer.status, 200);
        assert.equal(withBearer.body.data.user.email, email);

        const withCookie = await api("GET", "/auth/me", { cookie });
        assert.equal(withCookie.status, 200);

        const withoutAnything = await api("GET", "/auth/me");
        assert.equal(withoutAnything.status, 401);
        assert.equal(withoutAnything.body.error.code, "unauthorized");
    });

    it("rejects an invalid bearer instead of falling through to the cookie", async () => {
        const { email } = await registerUser("cookie-no-fallthrough");
        const cookie = authCookieFrom(await api("POST", "/auth/login", { body: { email, password: PASSWORD } }));

        for (const header of [`Bearer ${"a".repeat(64)}`, "Bearer", "Basic abc123"]) {
            const response = await fetch(`${origin}/api/v1/auth/me`, {
                headers: { authorization: header, cookie }
            });
            const body = await response.json();

            assert.equal(response.status, 401, `expected 401 for ${header}`);
            assert.equal(body.error.code, "unauthorized");
            assert.equal(body.data, undefined, "the cookie identity must not leak through");
        }

        // The cookie on its own still works — it was never the problem.
        assert.equal((await api("GET", "/auth/me", { cookie })).status, 200);
    });

    it("logout clears the cookie", async () => {
        const { email } = await registerUser("cookie-logout");
        const cookie = authCookieFrom(await api("POST", "/auth/login", { body: { email, password: PASSWORD } }));

        const response = await api("POST", "/auth/logout", { cookie });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.loggedOut, true);

        const cleared = response.setCookie.join("\n");
        assert.match(cleared, /accessToken=;/, "the cookie is overwritten with an empty value");
        assert.match(cleared, /Max-Age=0|Expires=Thu, 01 Jan 1970/i, "and expires immediately");
        assert.match(cleared, /Path=\//i, "same path it was issued with");

        // The jar now carries the cleared cookie: the session it pointed at is gone.
        const after = await api("GET", "/auth/me", { cookie: authCookieFrom(response) });
        assert.equal(after.status, 401);
    });

    it("logout-all clears the cookie as well", async () => {
        const { email } = await registerUser("cookie-logout-all");
        const cookie = authCookieFrom(await api("POST", "/auth/login", { body: { email, password: PASSWORD } }));

        const response = await api("POST", "/auth/logout-all", { cookie });

        assert.equal(response.status, 200);
        assert.equal(response.body.data.loggedOutEverywhere, true);
        assert.match(response.setCookie.join("\n"), /accessToken=;/);
        assert.equal((await api("GET", "/auth/me", { cookie })).status, 401);
    });
});

// ----------------------------------------------------------------- rate limiting

describe("rate limiting", () => {
    // The real `/auth/*` buckets are shared process-wide, so the limiter is
    // exercised on a throwaway app with its own bucket. The bucket is keyed by
    // client address; every request below comes from the same ephemeral port.
    let mini;
    let miniOrigin;
    let bucketSequence = 0;

    before(async () => {
        const tiny = express();
        tiny.use((req, res, next) => {
            res.locals.requestId = "test";
            return next();
        });
        const bucket = `test-bucket-${++bucketSequence}-${Date.now()}`;
        tiny.get("/allowed", createRateLimit({ bucket, windowMs: 60_000, max: 3 }), (req, res) => res.json({ ok: true }));
        tiny.get("/custom", createRateLimit({ bucket: `${bucket}-custom`, windowMs: 60_000, max: 2, message: "Hold on." }), (req, res) => res.json({ ok: true }));
        tiny.use(errorHandler);

        mini = await new Promise((resolve) => {
            const instance = tiny.listen(0, "127.0.0.1", () => resolve(instance));
        });
        miniOrigin = `http://127.0.0.1:${mini.address().port}`;
    });

    after(async () => {
        await new Promise((resolve) => mini.close(resolve));
    });

    it("answers 429 with the rate_limited code past the window cap", async () => {
        const responses = [];
        for (let attempt = 1; attempt <= 4; attempt += 1) {
            responses.push(await fetch(`${miniOrigin}/allowed`));
        }

        for (const response of responses.slice(0, 3)) {
            assert.equal(response.status, 200);
        }
        const slammed = responses[3];
        assert.equal(slammed.status, 429);

        const body = await slammed.json();
        assert.equal(body.ok, false);
        assert.equal(body.error.code, "rate_limited");
        assert.equal(body.error.message, "Too many requests. Please try again later.");
        assert.ok(body.meta.requestId);
    });

    it("honours a custom message", async () => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            assert.equal((await fetch(`${miniOrigin}/custom`)).status, 200);
        }
        const slammed = await fetch(`${miniOrigin}/custom`);
        assert.equal(slammed.status, 429);
        assert.equal((await slammed.json()).error.message, "Hold on.");
    });
});