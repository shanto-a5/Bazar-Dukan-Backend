import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { roundMoney } from "../core/money.js";
import { SellerOrder } from "../models/seller-order.model.js";
import * as sellerProfileRepo from "../repositories/seller-profile.repository.js";
import * as storeRepo from "../repositories/store.repository.js";
import * as userRepo from "../repositories/user.repository.js";
import * as productRepo from "../repositories/product.repository.js";

/**
 * Seller onboarding, approvals and store settings.
 *
 * The rules mirror the simulator's `src/services/seller-service.ts` — the same
 * application shape, the same store defaults (fee 60, free over 999, 2–4 days,
 * response rate 100, verified, store active), the same "You already have a
 * seller account." conflict, and `canUseSellerArea` meaning exactly
 * `profile?.status === 'active'` — with one deliberate divergence:
 *
 *   The local simulator self-activates a new seller (`status: 'active'`, role
 *   granted immediately) because a device build has no operator to review it.
 *   This backend is the *remote* mode the simulator already describes: the
 *   application is created `pending`, no `seller` role is granted here, and an
 *   approver flips it to `active` (granting the role) via
 *   `POST /approvals/sellers/:id/approve`. Products stay invisible in the
 *   meantime anyway — `customerVisibility` in core/catalog-rules.js requires an
 *   active seller — so an auto-activated profile would change nothing a buyer
 *   can see, only who is allowed to trade.
 *
 * Identity never comes from a request: every function takes `req.user.id` or
 * the `req.sellerProfile` the middleware resolved from it, so a client cannot
 * name a seller it does not own (and a store that is not yours is simply not
 * reachable — the read path is "my profile -> my store").
 */
const conflict = (message) => new ApiError(409, message, [], "", "conflict");
const notFound = (message) => new ApiError(404, message, [], "", "not_found");
const validation = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The wire shape of a `SellerProfile`: camelCase, `id` as a string, no `_id`
 * and no `__v`. The nested `bank` / `agreement` objects are copied key by key
 * for the same reason the validators build input key by key — nothing implicit
 * can ride along. `storeId` comes from the caller's store (the domain type
 * requires it); without a store yet it is null.
 */
const toProfileDto = (profile, store = null) => ({
    id: String(profile._id),
    userId: String(profile.userId),
    storeId: store ? String(store._id) : null,
    status: profile.status,
    sellerType: profile.sellerType,
    fullName: profile.fullName,
    phone: profile.phone,
    email: profile.email,
    nationalId: profile.nationalId,
    entityName: profile.entityName ?? "",
    storeName: profile.storeName,
    storeDescription: profile.storeDescription ?? "",
    logo: profile.logo ?? "",
    banner: profile.banner ?? "",
    pickupDivision: profile.pickupDivision ?? "",
    pickupDistrict: profile.pickupDistrict ?? "",
    pickupArea: profile.pickupArea ?? "",
    pickupAddressLine: profile.pickupAddressLine ?? "",
    returnDivision: profile.returnDivision ?? "",
    returnDistrict: profile.returnDistrict ?? "",
    returnArea: profile.returnArea ?? "",
    returnAddressLine: profile.returnAddressLine ?? "",
    bank: {
        bankName: profile.bank?.bankName ?? "",
        accountName: profile.bank?.accountName ?? "",
        accountNumber: profile.bank?.accountNumber ?? "",
        branch: profile.bank?.branch ?? ""
    },
    agreement: {
        marketplaceTerms: profile.agreement?.marketplaceTerms === true,
        sellerPolicies: profile.agreement?.sellerPolicies === true,
        productAuthenticity: profile.agreement?.productAuthenticity === true,
        fulfillmentResponsibility: profile.agreement?.fulfillmentResponsibility === true
    },
    appliedAt: iso(profile.appliedAt),
    decidedAt: iso(profile.decidedAt),
    decisionNote: profile.decisionNote ?? "",
    createdAt: iso(profile.createdAt),
    updatedAt: iso(profile.updatedAt)
});

/** The wire shape of a `Store`, mirroring the simulator's `Store` domain type. */
const toStoreDto = (store) => ({
    id: String(store._id),
    sellerId: String(store.sellerId),
    name: store.name,
    description: store.description ?? "",
    logo: store.logo ?? "",
    banner: store.banner ?? "",
    status: store.status,
    ratingAvg: store.ratingAvg,
    ratingCount: store.ratingCount,
    responseRate: store.responseRate,
    responseTimeMinutes: store.responseTimeMinutes,
    productCount: store.productCount,
    followerCount: store.followerCount,
    shippingFee: roundMoney(store.shippingFee),
    freeShippingThreshold: roundMoney(store.freeShippingThreshold),
    deliveryEstimateDays: {
        min: store.deliveryEstimateDays?.min ?? 2,
        max: store.deliveryEstimateDays?.max ?? 4
    },
    location: store.location ?? "",
    verified: store.verified === true,
    createdAt: iso(store.createdAt),
    updatedAt: iso(store.updatedAt)
});

/**
 * Store defaults exactly as `seller-service.ts` writes them on creation:
 * shipping policy 60 / 999 / 2–4 days, response rate 100, verified true, and
 * the store itself `active` — products still stay hidden until the seller
 * profile is approved, because visibility requires an active seller.
 */
const storeForApplication = (input, sellerId) => ({
    sellerId,
    name: input.storeName,
    description: input.storeDescription,
    // Same placeholder scheme the simulator falls back to when no image is given.
    logo: input.storeLogo || `p:\u{1F3EA}:${input.storeName}`,
    banner: input.storeBanner || `p:\u{1F6D2}:${input.storeName}`,
    status: "active",
    ratingAvg: 0,
    ratingCount: 0,
    responseRate: 100,
    responseTimeMinutes: Math.floor(Math.random() * 240) + 30,
    productCount: 0,
    followerCount: 0,
    shippingFee: 60,
    freeShippingThreshold: 999,
    deliveryEstimateDays: { min: 2, max: 4 },
    location:
        input.pickupDistrict || input.pickupDivision
            ? `${input.pickupDistrict}, ${input.pickupDivision}`
            : "",
    verified: true
});

/**
 * POST /seller/register.
 *
 * One profile per user, enforced by the unique index and reported as the
 * simulator's own conflict message. The profile is created `pending` and the
 * store is created alongside it (see the divergence note at the top of this
 * file); the `seller` role is deliberately *not* granted here — approval does
 * that.
 */
const becomeSeller = async (userId, input) => {
    const existing = await sellerProfileRepo.findByUserId(userId);
    if (existing) throw conflict("You already have a seller account.");

    let profile;
    try {
        profile = await sellerProfileRepo.insert({
            userId,
            fullName: input.fullName,
            phone: input.phone,
            email: input.email,
            nationalId: input.nationalId,
            sellerType: input.sellerType,
            entityName: input.sellerType === "business" ? input.entityName : "",
            storeName: input.storeName,
            storeDescription: input.storeDescription,
            logo: input.storeLogo || `p:\u{1F3EA}:${input.storeName}`,
            banner: input.storeBanner || `p:\u{1F6D2}:${input.storeName}`,
            pickupDivision: input.pickupDivision,
            pickupDistrict: input.pickupDistrict,
            pickupArea: input.pickupArea,
            pickupAddressLine: input.pickupAddressLine,
            returnDivision: input.returnDivision,
            returnDistrict: input.returnDistrict,
            returnArea: input.returnArea,
            returnAddressLine: input.returnAddressLine,
            bank: input.bank,
            agreement: input.agreement,
            status: "pending",
            appliedAt: new Date(),
            decidedAt: null,
            decisionNote: ""
        });
    } catch (error) {
        // Unique-index race: a second submit landed between the check and here.
        if (error?.code === 11000) throw conflict("You already have a seller account.");
        throw error;
    }

    const store = await storeRepo.insert(storeForApplication(input, profile._id));

    return {
        profile: toProfileDto(profile, store),
        store: toStoreDto(store),
        canUseSellerArea: false
    };
};

const profileFor = async (userId) => {
    const profile = await sellerProfileRepo.findByUserId(userId);
    if (!profile) return { profile: null, store: null };

    const store = await storeRepo.findBySellerId(profile._id);
    return { profile: toProfileDto(profile, store), store: store ? toStoreDto(store) : null };
};

/**
 * GET /seller/application — asymmetric on purpose, exactly like the
 * simulator's `applicationFor`: `canUseSellerArea` is not "has a profile", it
 * is `status === 'active'`, because a pending or rejected applicant has a
 * profile and still must not reach the seller routes.
 */
const applicationFor = async (userId) => {
    const { profile, store } = await profileFor(userId);
    return {
        profile,
        store,
        canUseSellerArea: profile?.status === "active"
    };
};

/** GET /approvals/sellers — the pending queue, newest first, each with its store. */
const listPendingApplications = async () => {
    const profiles = await sellerProfileRepo.listByStatus("pending");

    const sellers = await Promise.all(
        profiles.map(async (profile) => {
            const store = await storeRepo.findBySellerId(profile._id);
            return { profile: toProfileDto(profile, store), store: store ? toStoreDto(store) : null };
        })
    );

    return { sellers };
};

/**
 * An approver acts on a named application, so the id comes from the path — but
 * a garbage or unknown id is the same 404, never a cast error and never a
 * different answer that would tell a caller which ids exist.
 */
const requireApplication = async (profileId) => {
    if (!mongoose.isValidObjectId(profileId)) throw notFound("Seller application not found.");
    const profile = await sellerProfileRepo.findById(profileId);
    if (!profile) throw notFound("Seller application not found.");
    return profile;
};

/**
 * POST /approvals/sellers/:id/approve — activates the profile and grants the
 * `seller` role on its user if that user does not have it yet. The role is
 * additive (`$addToSet`-style check) so approving twice never duplicates it.
 *
 * A decision that changes nothing is a `409 conflict`, never a silent 200
 * (contract C3.7): approving an already-active application is refused before
 * anything is written. Every successful decision appends exactly one entry to
 * the profile's `decisionHistory`, stamped with the acting operator — the
 * approver's identity over HTTP, `dev-cli` for the development CLI, which
 * calls this same function.
 */
const approveApplication = async (profileId, actor) => {
    const profile = await requireApplication(profileId);

    if (profile.status === "active") {
        throw conflict("This application is already active.");
    }

    const decidedAt = new Date();
    const updated = await sellerProfileRepo.applyDecision(
        profile._id,
        { status: "active", decidedAt },
        {
            decision: "approved",
            actorId: String(actor.id),
            actorLabel: actor.label ?? "",
            at: decidedAt,
            note: ""
        }
    );

    const user = await userRepo.findById(profile.userId);
    if (user && !(user.roles ?? []).includes("seller")) {
        await userRepo.patch(profile.userId, { roles: [...(user.roles ?? []), "seller"] });
    }

    const store = await storeRepo.findBySellerId(profile._id);
    return { profile: toProfileDto(updated ?? profile, store) };
};

/**
 * POST /approvals/sellers/:id/reject — turns the application down with a note.
 * Same contract as the approval: a rejection of an already-rejected
 * application is a `409`, and a successful rejection appends one history
 * entry carrying the reason.
 */
const rejectApplication = async (profileId, note, actor) => {
    const profile = await requireApplication(profileId);

    if (profile.status === "rejected") {
        throw conflict("This application is already rejected.");
    }

    const decidedAt = new Date();
    const updated = await sellerProfileRepo.applyDecision(
        profile._id,
        { status: "rejected", decisionNote: note ?? "", decidedAt },
        {
            decision: "rejected",
            actorId: String(actor.id),
            actorLabel: actor.label ?? "",
            at: decidedAt,
            note: note ?? ""
        }
    );

    const store = await storeRepo.findBySellerId(profile._id);
    return { profile: toProfileDto(updated ?? profile, store) };
};

/** The wire shape of one `decisionHistory` entry: camelCase, no Mongo internals. */
const toHistoryDto = (entry) => ({
    decision: entry.decision,
    actorId: entry.actorId,
    actorLabel: entry.actorLabel ?? "",
    at: iso(entry.at),
    note: entry.note ?? ""
});

/**
 * GET /approvals/sellers/:id/history — the append-only decision trail for one
 * seller application, oldest first. An application that has never been decided
 * answers 200 with an empty history; an unknown id keeps the same safe 404 the
 * decision endpoints use.
 */
const approvalHistory = async (profileId) => {
    const profile = await requireApplication(profileId);

    return { history: (profile.decisionHistory ?? []).map(toHistoryDto) };
};

/** Resolves the caller's own store; a missing one is a 404, not a 500. */
const requireStore = async (sellerProfile) => {
    const store = await storeRepo.findBySellerId(sellerProfile._id);
    if (!store) throw notFound("Store not found.");
    return store;
};

const getStore = async (sellerProfile) => ({ store: toStoreDto(await requireStore(sellerProfile)) });

/**
 * PATCH /seller/store — applies a validator-approved patch to the caller's own
 * store only. A Mongoose validation failure (a value the schema itself refuses,
 * e.g. below its minimum) is reported as the same 422 field list rather than
 * falling through as a 500.
 */
const updateStore = async (sellerProfile, patch) => {
    const store = await requireStore(sellerProfile);

    let updated;
    try {
        updated = await storeRepo.patchById(store._id, patch);
    } catch (error) {
        if (error?.name !== "ValidationError" || typeof error.errors !== "object") throw error;
        const fields = Object.values(error.errors).map((entry) => ({
            field: entry.path,
            message: entry.message
        }));
        throw validation("Please fix the highlighted fields.", fields);
    }

    return { store: toStoreDto(updated ?? store) };
};

/** POST /seller/store/status — active or paused, on the caller's own store. */
const setStoreStatus = async (sellerProfile, status) => updateStore(sellerProfile, { status });

/**
 * GET /seller/dashboard — the seller's overview counters, mirroring the
 * reference backend's `dashboard()`:
 *   - productCount: ALL the seller's listings (no status filter, no cap);
 *   - orderCount: every seller order ever split to this seller;
 *   - pendingFulfilment: splits still awaiting fulfilment (new, confirmed,
 *     processing, packed, ready_to_ship);
 *   - revenue: the sum of `total` over DELIVERED splits only.
 */
const sellerDashboard = async (sellerProfile) => {
    const store = await storeRepo.findBySellerId(sellerProfile._id);
    const [products, sellerOrders] = await Promise.all([
        productRepo.findBySeller(sellerProfile._id),
        SellerOrder.find({ sellerId: sellerProfile._id })
    ]);

    const pendingStatuses = new Set(["new", "confirmed", "processing", "packed", "ready_to_ship"]);
    const revenue = sellerOrders
        .filter((row) => row.status === "delivered")
        .reduce((sum, row) => sum + (row.total ?? 0), 0);

    return {
        seller: toProfileDto(sellerProfile, store),
        store: store ? toStoreDto(store) : null,
        productCount: products.length,
        orderCount: sellerOrders.length,
        pendingFulfilment: sellerOrders.filter((row) => pendingStatuses.has(row.status)).length,
        revenue: roundMoney(revenue)
    };
};

export {
    becomeSeller,
    profileFor,
    applicationFor,
    listPendingApplications,
    approveApplication,
    rejectApplication,
    approvalHistory,
    getStore,
    updateStore,
    setStoreStatus,
    sellerDashboard,
    toProfileDto,
    toStoreDto
};
