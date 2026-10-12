/**
 * Notification suite (M12 — vouchers + notifications slice).
 *
 * Runs the real Express app on an ephemeral port against a dedicated
 * `vanta_notification_test` database, so every assertion below is about what a
 * client would actually observe: status, envelope, error code, inbox ordering,
 * the unread badge and — above all — that one user can never see, read or
 * delete another user's rows.
 *
 * Rows are written through the STABLE notification service (`create`, `list`,
 * `markRead`, …) because that is how the rest of the backend emits them; the
 * HTTP surface is exercised through the mounted router.
 *
 * Run: node --test src/tests/notification.test.js
 *
 * The suite drops `vanta_notification_test` when it finishes; it never touches
 * the application database.
 */
import "dotenv/config";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { app } from "../app.js";
import notificationRouter from "../routes/notification.route.js";
import { Notification } from "../models/notification.model.js";
import * as notificationService from "../services/notification.service.js";

const PASSWORD = "Sup3rSecret!";

let server;
let origin;
let sequence = 0;

// --------------------------------------------------------------------- utils

const uniqueEmail = (label) => `notif-${label}-${++sequence}-${Date.now()}@example.com`;

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

/** Emits a notification the way the rest of the backend does. */
const notify = async (userId, overrides = {}) =>
    notificationService.create({
        userId,
        type: "system",
        title: "A notification",
        body: "Something happened.",
        ...overrides
    });

// ------------------------------------------------------------------ lifecycle

before(async () => {
    process.env.MAIL_PROVIDER = "console";

    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the notification suite");

    // app.js does not mount the notification router yet (the coordinator adds
    // `app.use("/api/v1", notificationRouter);`). For this suite the router is
    // mounted the same way, inserted directly before the not-found handler so
    // every other route keeps behaving exactly as before.
    app.use("/api/v1", notificationRouter);
    const stack = app.router.stack;
    const layer = stack.pop();
    stack.splice(stack.length - 2, 0, layer);

    await mongoose.connect(`${base}/vanta_notification_test`);

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

// ---------------------------------------------------------------- create/list

describe("inbox", () => {
    it("1. creates a notification and lists the inbox newest first with the unread badge", async () => {
        const { token, userId } = await registerUser("inbox");

        const first = await notify(userId, { type: "order_shipped", title: "Order shipped", body: "It is on the way", data: { orderId: "ord_1" } });
        const second = await notify(userId, { type: "order_delivered", title: "Order delivered" });
        const third = await notify(userId, { type: "system", title: "Welcome to Vanta" });

        assert.equal(typeof first.id, "string");
        assert.equal(first._id, undefined, "the service hands back the public DTO");
        assert.equal(first.read, false);
        assert.equal(first.userId, userId);

        // Pin the timestamps so the ordering assertion is deterministic.
        await Notification.updateOne({ _id: first.id }, { $set: { createdAt: new Date(Date.now() - 120000) } });
        await Notification.updateOne({ _id: second.id }, { $set: { createdAt: new Date(Date.now() - 60000) } });
        await Notification.updateOne({ _id: third.id }, { $set: { createdAt: new Date(Date.now()) } });

        const response = await api("GET", "/notifications", { token });
        assert.equal(response.status, 200, response.raw);
        assert.equal(response.body.ok, true);

        const { notifications, unreadCount } = response.body.data;
        assert.equal(unreadCount, 3);
        assert.deepEqual(notifications.map((row) => row.title), ["Welcome to Vanta", "Order delivered", "Order shipped"]);
        assert.deepEqual(notifications.map((row) => row.id), [third.id, second.id, first.id]);

        for (const row of notifications) {
            assert.equal(typeof row.id, "string");
            assert.equal(row._id, undefined, "the DTO never exposes _id");
            assert.equal(row.__v, undefined, "the DTO never exposes __v");
            assert.equal(row.read, false);
        }
        assert.equal(notifications[2].body, "It is on the way");
        assert.deepEqual(notifications[2].data, { orderId: "ord_1" });
    });

    it("2. rejects an unknown notification type with 422 naming the type field", async () => {
        const { userId } = await registerUser("bad-type");

        let caught = null;
        try {
            await notificationService.create({ userId, type: "order_teleport", title: "Nope" });
        } catch (error) {
            caught = error;
        }

        assert.ok(caught, "an unknown type must be refused");
        assert.equal(caught.statusCode, 422);
        assert.equal(caught.code, "validation_failed");
        assert.deepEqual(caught.errors.map((entry) => entry.field), ["type"]);
        assert.equal(await Notification.countDocuments(), 0, "nothing may be written");
    });

    it("3. reports the unread count and keeps it in step with reads", async () => {
        const { token, userId } = await registerUser("badge");
        const first = await notify(userId, { title: "First" });
        await notify(userId, { title: "Second" });

        const two = await api("GET", "/notifications/unread-count", { token });
        assert.equal(two.status, 200, two.raw);
        assert.deepEqual(two.body.data, { unreadCount: 2 });

        await notificationService.markRead(userId, first.id);

        const one = await api("GET", "/notifications/unread-count", { token });
        assert.deepEqual(one.body.data, { unreadCount: 1 });
    });

    it("4. filters to unread rows without changing the badge", async () => {
        const { token, userId } = await registerUser("filter");
        const first = await notify(userId, { title: "Read me" });
        await notify(userId, { title: "Unread one" });
        await notify(userId, { title: "Unread two" });
        await notificationService.markRead(userId, first.id);

        const unreadOnly = await api("GET", "/notifications?unread=true", { token });
        assert.equal(unreadOnly.status, 200, unreadOnly.raw);
        assert.equal(unreadOnly.body.data.notifications.length, 2);
        assert.equal(unreadOnly.body.data.unreadCount, 2);
        for (const row of unreadOnly.body.data.notifications) {
            assert.equal(row.read, false);
            assert.notEqual(row.id, first.id);
        }

        const all = await api("GET", "/notifications?unread=false", { token });
        assert.equal(all.body.data.notifications.length, 3);
        assert.equal(all.body.data.unreadCount, 2, "the badge counts the whole inbox");
    });

    it("5. pages with limit and clamps it to 100", async () => {
        const { token, userId } = await registerUser("limit");
        await notify(userId, { title: "Oldest" });
        await notify(userId, { title: "Middle" });
        await notify(userId, { title: "Newest" });

        const one = await api("GET", "/notifications?limit=1", { token });
        assert.equal(one.status, 200, one.raw);
        assert.equal(one.body.data.notifications.length, 1);
        assert.equal(one.body.data.notifications[0].title, "Newest");
        assert.equal(one.body.data.unreadCount, 3, "the badge is independent of the page");

        const rows = Array.from({ length: 120 }, (_, index) => ({
            userId,
            type: "system",
            title: `Bulk ${index}`,
            body: "",
            read: false,
            createdAt: new Date(Date.now() - index * 1000)
        }));
        await Notification.insertMany(rows);

        const clamped = await api("GET", "/notifications?limit=500", { token });
        assert.equal(clamped.status, 200, clamped.raw);
        assert.equal(clamped.body.data.notifications.length, 100, "limit is clamped to 100");
        assert.equal(clamped.body.data.unreadCount, 123);
        assert.equal(clamped.body.data.notifications[0].title, "Bulk 0");
    });
});

// ------------------------------------------------------- read/delete ownership

describe("ownership", () => {
    it("6. marks one of my notifications read and 404s on somebody else's", async () => {
        const mine = await registerUser("mine");
        const theirs = await registerUser("theirs");
        const own = await notify(mine.userId, { title: "Mine" });
        const foreign = await notify(theirs.userId, { title: "Theirs" });

        const read = await api("PATCH", `/notifications/${own.id}/read`, { token: mine.token });
        assert.equal(read.status, 200, read.raw);
        assert.equal(read.body.data.notification.read, true);
        assert.equal(read.body.data.notification.id, own.id);
        assert.equal(read.body.data.notification._id, undefined);

        const denied = await api("PATCH", `/notifications/${foreign.id}/read`, { token: mine.token });
        assert.equal(denied.status, 404);
        assert.equal(denied.body.error.code, "not_found");
        assert.equal(denied.body.error.message, "Notification not found.");
        assert.equal(await notificationService.unreadCount(theirs.userId), 1, "the foreign row is untouched");

        const inbox = await api("GET", "/notifications", { token: mine.token });
        assert.equal(inbox.body.data.notifications.length, 1, "only my own rows are ever listed");
        assert.equal(inbox.body.data.notifications[0].id, own.id);
        assert.equal(inbox.body.data.unreadCount, 0);
    });

    it("7. sweeps only my inbox with read-all", async () => {
        const mine = await registerUser("sweep-mine");
        const theirs = await registerUser("sweep-theirs");
        await notify(mine.userId, { title: "One" });
        await notify(mine.userId, { title: "Two" });
        await notify(mine.userId, { title: "Three" });
        await notify(theirs.userId, { title: "Foreign" });

        const response = await api("POST", "/notifications/read-all", { token: mine.token });
        assert.equal(response.status, 200, response.raw);
        assert.deepEqual(response.body.data, { updated: 3 });

        assert.equal(await notificationService.unreadCount(mine.userId), 0);
        assert.equal(await notificationService.unreadCount(theirs.userId), 1, "somebody else's inbox stays unread");

        const again = await api("POST", "/notifications/read-all", { token: mine.token });
        assert.deepEqual(again.body.data, { updated: 0 }, "a second sweep changes nothing");
    });

    it("8. deletes my own row and 404s on somebody else's", async () => {
        const mine = await registerUser("delete-mine");
        const theirs = await registerUser("delete-theirs");
        const own = await notify(mine.userId, { title: "Mine" });
        const foreign = await notify(theirs.userId, { title: "Theirs" });

        const denied = await api("DELETE", `/notifications/${foreign.id}`, { token: mine.token });
        assert.equal(denied.status, 404);
        assert.equal(denied.body.error.code, "not_found");
        assert.equal(await Notification.countDocuments({ _id: foreign.id }), 1, "the foreign row survives");

        const removed = await api("DELETE", `/notifications/${own.id}`, { token: mine.token });
        assert.equal(removed.status, 200, removed.raw);
        assert.deepEqual(removed.body.data, { deleted: true });
        assert.equal(await Notification.countDocuments({ _id: own.id }), 0);

        const again = await api("DELETE", `/notifications/${own.id}`, { token: mine.token });
        assert.equal(again.status, 404, "a deleted row is simply not found");
    });

    it("9. requires a session for every notification route", async () => {
        for (const [method, path] of [
            ["GET", "/notifications"],
            ["GET", "/notifications/unread-count"],
            ["POST", "/notifications/read-all"],
            ["PATCH", "/notifications/64b000000000000000000000/read"],
            ["DELETE", "/notifications/64b000000000000000000000"]
        ]) {
            const response = await api(method, path);
            assert.equal(response.status, 401, `${method} ${path} must need a session`);
            assert.equal(response.body.error.code, "unauthorized");
        }
    });
});
