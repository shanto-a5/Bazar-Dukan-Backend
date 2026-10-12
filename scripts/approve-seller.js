#!/usr/bin/env node
// Development-only operator CLI: `npm run api:approve-seller -- --email=<addr>`
// (or `--profile-id=<id>`). It runs the SAME authoritative approval service the
// approver queue endpoint uses - `approveApplication` in
// src/services/seller.service.js, the implementation behind
// POST /api/v1/approvals/sellers/:id/approve - so there is exactly one
// approval code path. It is a local process, not an HTTP route: no backdoor,
// no auth weakening, and it refuses to run when NODE_ENV=production.

import "dotenv/config";

if (process.env.NODE_ENV === "production") {
    console.error(
        "api:approve-seller: refusing to run with NODE_ENV=production. " +
        "This CLI is a development-only operator tool."
    );
    process.exit(1);
}

const args = process.argv.slice(2);

const readFlag = (name) => {
    const prefix = `--${name}`;
    const inline = args.find((arg) => arg.startsWith(`${prefix}=`));
    if (inline) return inline.slice(prefix.length + 1);
    const index = args.indexOf(prefix);
    if (index === -1) return null;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) return "";
    return next;
};

const fail = (message) => {
    console.error(`api:approve-seller: ${message}`);
    process.exitCode = 1;
};

const email = readFlag("email");
const profileId = readFlag("profile-id");

if ((email && profileId) || (!email && !profileId)) {
    console.error(
        "usage: npm run api:approve-seller -- --email=<addr> | --profile-id=<id>"
    );
    process.exit(1);
}

const mongoose = (await import("mongoose")).default;
const { ConnectDB, DisconnectDB } = await import("../src/db/index.js");
const { approveApplication } = await import("../src/services/seller.service.js");
const userRepo = await import("../src/repositories/user.repository.js");
const profileRepo = await import("../src/repositories/seller-profile.repository.js");
const storeRepo = await import("../src/repositories/store.repository.js");

const describe = (label, { profile, user, store }) => {
    console.log(`${label}:`);
    console.log(`  application: id=${profile._id} status=${profile.status} appliedAt=${profile.appliedAt ?? "-"} decidedAt=${profile.decidedAt ?? "-"}`);
    console.log(`  user:        id=${user._id} email=${user.email} roles=[${(user.roles ?? []).join(", ")}]`);
    console.log(`  store:       ${store ? `id=${store._id} status=${store.status} name=${store.name}` : "MISSING"}`);
};

await ConnectDB();

try {
    let profile = null;
    let owner = null;

    if (email) {
        const normalized = String(email).trim().toLowerCase();
        owner = await userRepo.findByEmail(normalized);
        if (!owner) {
            fail(`no user found for email "${normalized}"`);
        } else {
            profile = await profileRepo.findByUserId(owner._id);
            if (!profile) {
                fail(`user "${normalized}" has no seller application (apply from the app first)`);
            }
        }
    } else {
        const id = String(profileId).trim();
        if (!mongoose.isValidObjectId(id)) {
            fail(`"--profile-id" is not a valid id: "${id}"`);
        } else {
            profile = await profileRepo.findById(id);
            if (!profile) fail(`seller application not found: ${id}`);
        }
    }

    if (profile) {
        owner = owner ?? (await userRepo.findById(profile.userId));
        if (!owner) {
            fail(`application ${profile._id} has no user record (userId=${profile.userId})`);
            profile = null;
        }
    }

    if (profile) {
        const store = await storeRepo.findBySellerId(profile._id);
        describe("before", { profile, user: owner, store });

        // The one authoritative approval path - identical to what the
        // approver queue endpoint calls in seller.controller.js#approveSeller.
        // A profile that is already active is refused with a 409 conflict
        // (caught below and reported as a failure), and every approval appends
        // one entry to the profile's decision history.
        await approveApplication(String(profile._id), { id: "dev-cli", label: "api:approve-seller CLI" });

        const approvedProfile = await profileRepo.findById(profile._id);
        const approvedUser = await userRepo.findById(owner._id);
        const approvedStore = await storeRepo.findBySellerId(profile._id);
        describe("after", { profile: approvedProfile, user: approvedUser, store: approvedStore });

        const problems = [];
        if (approvedProfile?.status !== "active") problems.push("profile status is not active");
        if (!approvedProfile?.decidedAt) problems.push("decidedAt was not recorded");
        if (!(approvedUser?.roles ?? []).includes("seller")) problems.push("user is missing the seller role");
        if (!approvedStore) problems.push("store record is missing");
        else if (approvedStore.status !== "active") problems.push(`store status is ${approvedStore.status}, expected active`);
        const history = approvedProfile?.decisionHistory ?? [];
        if (history.length < 1) problems.push("decision history entry missing");
        else if (history[history.length - 1].decision !== "approved") problems.push("latest history entry is not an approval");

        if (problems.length > 0) {
            fail(`approval did not reach the expected state: ${problems.join("; ")}`);
        } else {
            console.log("ok: seller approved through approveApplication (same service as the approver queue endpoint)");
        }
    }
} catch (error) {
    fail(error?.message ?? String(error));
} finally {
    await DisconnectDB();
}

process.exit(process.exitCode ?? 0);
