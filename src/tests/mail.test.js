/**
 * Mail transport suite: provider selection, configuration failures, and the
 * password-reset delivery path through the mailer abstraction.
 *
 * Runs the real Express app against its own `vanta_mail_test` database so the
 * outward contract (status, envelope, identical known/unknown answers) is what
 * gets asserted, and installs a stub Resend client so `npm test` never sends a
 * real email. The console provider stays covered end to end through its
 * outbox.
 *
 * Run: npm test  (node --test src/tests/)
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import { sendMail, assertMailConfig, getOutbox, clearOutbox } from "../services/mailer.js";
import { setClient as setResendClient } from "../services/mail/resend.provider.js";
import { Session } from "../models/session.model.js";
import { PasswordReset } from "../models/password-reset.model.js";

const PASSWORD = "Sup3rSecret!";
const RESET_SUBJECT = "Reset your Vanta password";

let server;
let origin;
let sequence = 0;

const ENV_KEYS = ["MAIL_PROVIDER", "RESEND_API_KEY", "MAIL_FROM", "NODE_ENV"];
const originalEnv = {};

/** Records the environment once so every test can start from a known state. */
const snapshotEnv = () => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
};

const setEnv = (patch) => {
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
};

const restoreEnv = () => setEnv(Object.fromEntries(ENV_KEYS.map((key) => [key, originalEnv[key]])));

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `mail-${label}-${++sequence}-${Date.now()}@example.com`;

const api = async (method, path, { body, token, requestId } = {}) => {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
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

    return { status: response.status, body: json, raw, requestId: response.headers.get("x-request-id") };
};

const registerUser = async (label) => {
    const email = uniqueEmail(label);
    const response = await api("POST", "/auth/register", {
        body: { name: "Ada Lovelace", email, phone: "01712345678", password: PASSWORD }
    });
    assert.equal(response.status, 201, response.raw);
    return { email, token: response.body.data.token };
};

const requestReset = (email) => api("POST", "/auth/password-reset/request", { body: { email } });

/** A recording stand-in for `resend.emails.send` — no network, ever. */
const stubResend = (behaviour = () => undefined) => {
    const calls = [];
    return {
        calls,
        emails: {
            send: async (payload) => {
                calls.push(payload);
                return behaviour(payload) ?? { data: { id: "stub-email-id" }, error: null };
            }
        }
    };
};

const tokenIn = (text) => {
    const match = /token=([0-9a-f]{64})/.exec(text);
    assert.ok(match, `expected a reset token in: ${text}`);
    return match[1];
};

/** Captures what the server logs so failures can be asserted, not guessed. */
const captureLogs = async (run) => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => lines.push(args.join(" "));
    try {
        await run();
    } finally {
        console.error = original;
    }
    return lines;
};

// ------------------------------------------------------------------ lifecycle

before(async () => {
    snapshotEnv();
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the mail suite");

    await mongoose.connect(`${base}/vanta_mail_test`);

    server = await new Promise((resolve) => {
        const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    setResendClient(null);
    restoreEnv();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.models).map((model) => model.deleteMany({})));
    clearOutbox();
    setResendClient(null);
    restoreEnv();
    process.env.MAIL_PROVIDER = "console";
});

// ------------------------------------------------------------- configuration

describe("mail configuration", () => {
    it("accepts the console provider outside production", () => {
        setEnv({ MAIL_PROVIDER: "console", NODE_ENV: "development" });

        assert.equal(assertMailConfig(), "console");
    });

    it("refuses the console provider in production", () => {
        setEnv({ MAIL_PROVIDER: "console", NODE_ENV: "production" });

        assert.throws(() => assertMailConfig(), /console.*production/i);
    });

    it("refuses resend without an API key, naming the variable", () => {
        setEnv({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "", NODE_ENV: "development" });

        assert.throws(() => assertMailConfig(), /RESEND_API_KEY/);
    });

    it("initializes the resend provider when the key is present", () => {
        setEnv({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "test-key-not-a-secret", NODE_ENV: "development" });

        assert.equal(assertMailConfig(), "resend");
    });

    it("refuses an unknown provider instead of falling back", () => {
        setEnv({ MAIL_PROVIDER: "smtp", NODE_ENV: "development" });

        assert.throws(() => assertMailConfig(), /not supported/i);
    });

    it("never falls back to console when resend is misconfigured", async () => {
        setEnv({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "", NODE_ENV: "development" });

        await assert.rejects(
            sendMail({ to: "nobody@example.com", subject: "x", text: "y" }),
            /RESEND_API_KEY/
        );
        assert.equal(getOutbox().length, 0, "nothing may be delivered by the wrong provider");
    });

    it("keeps the API key out of every error it produces", async () => {
        const apiKey = "sk_this_must_not_appear";
        setEnv({ MAIL_PROVIDER: "resend", RESEND_API_KEY: apiKey, NODE_ENV: "development" });
        setResendClient(
            stubResend(() => ({ data: null, error: { name: "validation_error", message: "The _from property is invalid." } }))
        );

        await assert.rejects(
            sendMail({ to: "nobody@example.com", subject: RESET_SUBJECT, text: "reset" }),
            (error) => {
                assert.match(error.message, /Resend send failed/);
                assert.ok(!error.message.includes(apiKey), "the key never reaches an error message");
                return true;
            }
        );
    });
});

// ------------------------------------------------- console provider (dev path)

describe("console provider", () => {
    it("delivers the reset message to the outbox with the full reset link", async () => {
        const { email } = await registerUser("console-outbox");

        const response = await requestReset(email);

        assert.equal(response.status, 200);
        assert.equal(response.body.data.accepted, true);

        const outbox = getOutbox();
        assert.equal(outbox.length, 1);
        assert.equal(outbox[0].to, email);
        assert.equal(outbox[0].subject, RESET_SUBJECT);

        const link = /https?:\/\/\S+/.exec(outbox[0].text);
        assert.ok(link, "the message contains the reset link");
        assert.ok(outbox[0].text.startsWith("Hello Ada Lovelace,"), "the message reads like the auth service built it");
        tokenIn(outbox[0].text);
    });

    it("gives known and unknown addresses the identical outward answer", async () => {
        const { email } = await registerUser("console-identical");

        const known = await requestReset(email);
        const unknown = await requestReset(uniqueEmail("console-never"));

        assert.equal(known.status, unknown.status);
        assert.deepEqual(known.body.data, unknown.body.data);
        assert.equal(getOutbox().length, 1, "only the known address produced a message");
    });
});

// ------------------------------------------------------ resend provider (stub)

describe("resend provider", () => {
    it("sends from the configured sender to the requested recipient", async () => {
        const { email } = await registerUser("resend-send");
        const stub = stubResend();
        setResendClient(stub);
        setEnv({
            MAIL_PROVIDER: "resend",
            RESEND_API_KEY: "test-key-not-a-secret",
            MAIL_FROM: "no-reply@vanta.test",
            NODE_ENV: "development"
        });

        const response = await requestReset(email);

        assert.equal(response.status, 200);
        assert.equal(response.body.data.accepted, true);
        assert.equal(stub.calls.length, 1);

        const message = stub.calls[0];
        assert.equal(message.from, "no-reply@vanta.test", "sender comes from configuration");
        assert.equal(message.to, email, "recipient is the account address");
        assert.equal(message.subject, RESET_SUBJECT);
        assert.ok(typeof message.html === "string" && message.html.length > 0, "HTML content is supplied");
        assert.ok(!message.html.includes("<script"), "no raw markup from the message body");

        const token = tokenIn(message.html);
        assert.equal(token.length, 64);
        assert.ok(message.html.includes(`token=${token}`), "the reset URL is carried intact");

        // the message it delivered really does work
        const confirm = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: "Third0neSecret!" }
        });
        assert.equal(confirm.status, 200, confirm.raw);
        assert.equal(confirm.body.data.reset, true);
    });

    it("keeps the outward contract and drops the ticket when delivery fails", async () => {
        const { email, token: sessionToken } = await registerUser("resend-fail");
        setResendClient(
            stubResend(() => ({
                data: null,
                error: { name: "validation_error", message: "The _from property is invalid." }
            }))
        );
        setEnv({
            MAIL_PROVIDER: "resend",
            RESEND_API_KEY: "test-key-not-a-secret",
            MAIL_FROM: "not-a-sender",
            NODE_ENV: "development"
        });

        const logs = await captureLogs(async () => {
            const known = await requestReset(email);
            const unknown = await requestReset(uniqueEmail("resend-never"));

            // identical outward answer: no enumeration, no provider detail
            assert.equal(known.status, 200);
            assert.equal(unknown.status, 200);
            assert.deepEqual(known.body.data, unknown.body.data);
            assert.ok(!known.raw.includes("validation_error"), "provider errors stay server-side");
            assert.ok(!known.raw.includes("test-key-not-a-secret"), "the API key never leaves the process");
        });

        assert.equal(logs.length, 1, "the failure is recorded server-side");
        assert.match(logs[0], /\[password-reset\] mail transport failed/);
        assert.match(logs[0], /_from property is invalid/);
        assert.ok(!logs[0].includes("test-key-not-a-secret"), "the API key is never logged");

        // the link nobody received is no longer usable
        assert.equal(await PasswordReset.countDocuments(), 0, "the ticket was dropped");
        const replay = await api("POST", "/auth/password-reset/confirm", {
            body: { token: "f".repeat(64), newPassword: "Third0neSecret!" }
        });
        assert.equal(replay.status, 422);

        // and the account itself is untouched
        const stillOld = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
        assert.equal(stillOld.status, 200, "the password did not change");
        assert.equal((await api("GET", "/auth/me", { token: sessionToken })).status, 200, "sessions survive a failed send");
    });

    it("propagates a transport-level failure as an ordinary error", async () => {
        setEnv({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "test-key-not-a-secret", NODE_ENV: "development" });
        setResendClient({
            emails: {
                send: async () => {
                    throw new Error("getaddrinfo ENOTFOUND api.resend.com");
                }
            }
        });

        await assert.rejects(
            sendMail({ to: "nobody@example.com", subject: RESET_SUBJECT, text: "reset" }),
            /Resend send failed: getaddrinfo ENOTFOUND/
        );
    });

    it("leaves the reset contract exactly as it was", async () => {
        const { email, token: sessionToken } = await registerUser("resend-contract");
        const stub = stubResend();
        setResendClient(stub);
        setEnv({
            MAIL_PROVIDER: "resend",
            RESEND_API_KEY: "test-key-not-a-secret",
            MAIL_FROM: "no-reply@vanta.test",
            NODE_ENV: "development"
        });

        const request = await requestReset(email);
        assert.equal(request.status, 200);
        assert.equal(request.body.data.expiresInMinutes, 30);
        assert.equal(request.body.ok, true);
        assert.equal(typeof request.body.meta.message, "string");

        const token = tokenIn(stub.calls[0].html);

        const confirm = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: "Third0neSecret!" }
        });
        assert.equal(confirm.status, 200);
        assert.equal(confirm.body.data.reset, true);
        assert.equal(confirm.body.data.sessionsRevoked, 1, "register's session dies with the reset");

        assert.equal((await api("GET", "/auth/me", { token: sessionToken })).status, 401);
        const oldPassword = await api("POST", "/auth/login", { body: { email, password: PASSWORD } });
        assert.equal(oldPassword.status, 401);
        const newPassword = await api("POST", "/auth/login", { body: { email, password: "Third0neSecret!" } });
        assert.equal(newPassword.status, 200);
        assert.equal(await Session.countDocuments({}), 1, "exactly the session the new login created");

        // single use still holds
        const replay = await api("POST", "/auth/password-reset/confirm", {
            body: { token, newPassword: "Fourth0neSecret!" }
        });
        assert.equal(replay.status, 422);
    });
});
