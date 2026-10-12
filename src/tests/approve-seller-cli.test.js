/**
 * Development CLI suite: `npm run api:approve-seller -- --email=<addr>`.
 *
 * Spawns the REAL script as a child process — the same entry point an operator
 * runs — and asserts its exit code, its output and the state it leaves behind
 * in `vanta_approver_cli_test`.
 *
 * `MONGODB_URI` is overridden in the child's environment so the CLI connects
 * to the test database; `dotenv` never overrides a variable that is already
 * set, so the application database is never touched. The CLI's `ConnectDB`
 * (src/db/index.js) appends `/${DB_Name}` (`UP`) to `MONGODB_URI`, so the
 * child's URI carries a trailing `#` that turns that suffix into an ignored
 * URL fragment — this is how the child lands on `vanta_approver_cli_test`
 * instead of the application database. The production refusal is exercised by
 * setting `NODE_ENV=production` the same way.
 *
 * Run JUST this file:
 *
 *     node --test src/tests/approve-seller-cli.test.js
 */
import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { User } from "../models/user.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Store } from "../models/store.model.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEW_BACKEND_ROOT = path.resolve(HERE, "..", "..");
const CLI = path.join(NEW_BACKEND_ROOT, "scripts", "approve-seller.js");

const AGREEMENT = {
    marketplaceTerms: true,
    sellerPolicies: true,
    productAuthenticity: true,
    fulfillmentResponsibility: true
};

let testUri;
let childUri;
let sequence = 0;

const runCli = (args, extraEnv = {}) =>
    spawnSync("node", [CLI, ...args], {
        cwd: NEW_BACKEND_ROOT,
        encoding: "utf8",
        timeout: 90000,
        env: { ...process.env, MONGODB_URI: childUri, ...extraEnv }
    });

/** A pending application, created the way `POST /seller/register` leaves it. */
const createPendingApplication = async (label) => {
    const email = `cli-${label}-${++sequence}-${Date.now()}@example.com`;
    const user = await User.create({
        name: "CLI Fixture",
        email,
        phone: "01712345678",
        passwordHash: "not-a-real-hash",
        passwordSalt: "not-a-real-salt",
        roles: ["customer"]
    });

    const profile = await SellerProfile.create({
        userId: user._id,
        fullName: "CLI Fixture",
        phone: "01712345678",
        email,
        nationalId: "1990123456789",
        sellerType: "individual",
        storeName: `CLI Store ${sequence}`,
        storeDescription: "A pending application created for the CLI suite.",
        bank: { bankName: "BRAC Bank", accountName: "CLI Fixture", accountNumber: "12345678901", branch: "Dhanmondi" },
        agreement: { ...AGREEMENT }
    });

    const store = await Store.create({
        sellerId: profile._id,
        name: `CLI Store ${sequence}`,
        description: "A pending application created for the CLI suite.",
        location: "Dhaka, Dhaka"
    });

    return { user, profile, store, email };
};

before(async () => {
    const base = (process.env.MONGODB_URI ?? "").trim().replace(/\/+$/, "");
    assert.ok(base, "MONGODB_URI is required to run the CLI suite");
    testUri = `${base}/vanta_approver_cli_test`;
    // ConnectDB appends `/UP`; the trailing `#` swallows that suffix as a URL
    // fragment so the child opens `vanta_approver_cli_test`, not `UP`.
    childUri = `${testUri}#`;

    await mongoose.connect(testUri);
});

after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
});

describe("api:approve-seller CLI", () => {
    it("first approval succeeds: exit 0, pending -> active, role, store and history", async () => {
        const fixture = await createPendingApplication("first");

        const result = runCli([`--email=${fixture.email}`]);

        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.match(result.stdout, /ok: seller approved/);

        const profile = await SellerProfile.findById(fixture.profile._id);
        assert.equal(profile.status, "active", "pending -> active");
        assert.ok(profile.decidedAt, "the decision is timestamped");

        const user = await User.findById(fixture.user._id);
        assert.deepEqual(user.roles, ["customer", "seller"], "exactly one seller role grant");

        const store = await Store.findOne({ sellerId: profile._id });
        assert.ok(store, "the store record survives");
        assert.equal(store.status, "active");

        assert.equal(profile.decisionHistory.length, 1, "one approval, one history entry");
        const entry = profile.decisionHistory[0];
        assert.equal(entry.decision, "approved");
        assert.equal(entry.actorId, "dev-cli", "the trail records the tool that decided");
        assert.ok(entry.at instanceof Date && !Number.isNaN(entry.at.getTime()), "the entry is timestamped");
    });

    it("repeated approval fails with a conflict and changes nothing", async () => {
        const fixture = await createPendingApplication("repeat");

        const first = runCli([`--email=${fixture.email}`]);
        assert.equal(first.status, 0, first.stderr);

        const before = await SellerProfile.findById(fixture.profile._id);
        const beforeRoles = [...(await User.findById(fixture.user._id)).roles].sort();

        const second = runCli([`--email=${fixture.email}`]);

        assert.notEqual(second.status, 0, "a refused decision must fail the CLI");
        assert.match(second.stderr, /already active/, `stderr was:\n${second.stderr}`);

        const after = await SellerProfile.findById(fixture.profile._id);
        assert.equal(after.status, "active");
        assert.equal(String(after.decidedAt), String(before.decidedAt), "the timestamp is untouched");
        assert.equal(after.decisionHistory.length, 1, "no second history record");

        const afterRoles = [...(await User.findById(fixture.user._id)).roles].sort();
        assert.deepEqual(afterRoles, beforeRoles, "the seller role is not duplicated");
    });

    it("refuses to run with NODE_ENV=production", () => {
        const result = runCli([], { NODE_ENV: "production" });

        assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.match(result.stderr, /refusing to run with NODE_ENV=production/);
    });
});
