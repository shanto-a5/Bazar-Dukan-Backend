import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import {
    validateBecomeSeller,
    validateStorePatch,
    validateStoreStatus,
    validateDecisionNote
} from "../validators/seller.validator.js";
import {
    becomeSeller,
    applicationFor,
    profileFor,
    listPendingApplications,
    approveApplication,
    rejectApplication,
    approvalHistory,
    getStore as getStoreForSeller,
    updateStore,
    setStoreStatus,
    sellerDashboard
} from "../services/seller.service.js";

/**
 * Seller HTTP surface: onboarding, the approver queue and store settings.
 *
 * The controller only shapes HTTP — validate in, call the service, put the
 * result in the envelope — and it reads identity from `req.user.id` /
 * `req.sellerProfile` (set by `authenticate` and `requireSeller`), never from
 * the body or the params, so a request cannot act as somebody else's seller.
 *
 * Role failures never reach here: `requireApprover` / `requireSeller` answer
 * 403 first, and a route that needs a session answers 401 before any handler.
 */

// POST /seller/register — the application is submitted and reviewed, so 201.
const registerSeller = asyncHandlers(async (req, res) => {
    const input = validateBecomeSeller(req.body);
    const result = await becomeSeller(req.user.id, input);

    return res.status(201).json(new ApiResponse(201, result, "Your seller application has been submitted."));
});

// GET /seller/application — nulls and `canUseSellerArea: false` for a user who
// never applied; the screen reads this to decide between form and status.
const getApplication = asyncHandlers(async (req, res) => {
    const application = await applicationFor(req.user.id);

    return res.status(200).json(new ApiResponse(200, application, "Seller application."));
});

// GET /seller/profile — the same read without the capability flag; never 404.
const getSellerProfile = asyncHandlers(async (req, res) => {
    const result = await profileFor(req.user.id);

    return res.status(200).json(new ApiResponse(200, result, "Seller profile."));
});

// GET /approvals/sellers — pending applications, newest first.
const listApprovals = asyncHandlers(async (req, res) => {
    const result = await listPendingApplications();

    return res.status(200).json(new ApiResponse(200, result, "Pending seller applications."));
});

// POST /approvals/sellers/:id/approve — activates the profile and grants the role.
// The acting operator is `req.user`, so the decision history records who approved.
const approveSeller = asyncHandlers(async (req, res) => {
    const result = await approveApplication(req.params.id, { id: req.user.id, label: req.user.email });

    return res.status(200).json(new ApiResponse(200, result, "Seller application approved."));
});

// POST /approvals/sellers/:id/reject — optional note, kept as the decision record.
const rejectSeller = asyncHandlers(async (req, res) => {
    const { note } = validateDecisionNote(req.body);
    const result = await rejectApplication(req.params.id, note, { id: req.user.id, label: req.user.email });

    return res.status(200).json(new ApiResponse(200, result, "Seller application rejected."));
});

// GET /approvals/sellers/:id/history — the append-only decision trail, approvers only.
const getApprovalHistory = asyncHandlers(async (req, res) => {
    const result = await approvalHistory(req.params.id);

    return res.status(200).json(new ApiResponse(200, result, "Approval history."));
});

// GET /seller/store — the store of the authenticated seller only.
const getStore = asyncHandlers(async (req, res) => {
    const result = await getStoreForSeller(req.sellerProfile);

    return res.status(200).json(new ApiResponse(200, result, "Store."));
});

// PATCH /seller/store — editable settings only; unknown keys are 422 by name.
const patchStore = asyncHandlers(async (req, res) => {
    const patch = validateStorePatch(req.body);
    const result = await updateStore(req.sellerProfile, patch);

    return res.status(200).json(new ApiResponse(200, result, "Store updated."));
});

// POST /seller/store/status — active or paused.
const toggleStoreStatus = asyncHandlers(async (req, res) => {
    const { status } = validateStoreStatus(req.body);
    const result = await setStoreStatus(req.sellerProfile, status);

    return res.status(200).json(new ApiResponse(200, result, "Store status updated."));
});

// GET /seller/dashboard — the seller's own overview counters.
const getDashboard = asyncHandlers(async (req, res) => {
    const result = await sellerDashboard(req.sellerProfile);

    return res.status(200).json(new ApiResponse(200, result, "Seller dashboard."));
});

export {
    registerSeller,
    getApplication,
    getSellerProfile,
    listApprovals,
    approveSeller,
    rejectSeller,
    getApprovalHistory,
    getStore,
    patchStore,
    toggleStoreStatus,
    getDashboard
};
