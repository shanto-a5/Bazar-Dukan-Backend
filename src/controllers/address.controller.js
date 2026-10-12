import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { validateCreateAddress, validatePatchAddress } from "../validators/address.validator.js";
import { list, get, add, update, remove, setDefault } from "../services/address.service.js";

/**
 * Vanta address book endpoints, all mounted under `/api/v1/addresses` and all
 * authenticated.
 *
 * The controller only shapes HTTP: input is validated, the address service is
 * called with `req.user.id` and the envelope wraps the result. A row that is
 * not the caller's own is "Address not found." — owner scoping lives in the
 * service, so a foreign id is never reachable through this file.
 */
const notFound = () => new ApiError(404, "Address not found.", [], "", "not_found");

// GET /addresses — the caller's book in insertion order.
const listAddresses = asyncHandlers(async (req, res) => {
    const addresses = await list(req.user.id);
    return res.status(200).json(new ApiResponse(200, { addresses }, "Addresses loaded."));
});

// GET /addresses/:id — one of the caller's own addresses.
const getAddress = asyncHandlers(async (req, res) => {
    const address = await get(req.user.id, req.params.id);
    if (!address) throw notFound();
    return res.status(200).json(new ApiResponse(200, { address }, "Address loaded."));
});

// POST /addresses — create; the first address auto-becomes default.
const createAddress = asyncHandlers(async (req, res) => {
    const input = validateCreateAddress(req.body);
    const address = await add(req.user.id, input);
    return res.status(201).json(new ApiResponse(201, { address }, "Address saved."));
});

// PATCH /addresses/:id — merge the provided AddressInput fields.
const updateAddress = asyncHandlers(async (req, res) => {
    const patch = validatePatchAddress(req.body);
    const address = await update(req.user.id, req.params.id, patch);
    return res.status(200).json(new ApiResponse(200, { address }, "Address updated."));
});

// DELETE /addresses/:id — remove; the remaining list returns with the flag.
const removeAddress = asyncHandlers(async (req, res) => {
    await remove(req.user.id, req.params.id);
    const addresses = await list(req.user.id);
    return res.status(200).json(new ApiResponse(200, { deleted: true, addresses }, "Address removed."));
});

// POST /addresses/:id/default — promote one address to the single default.
const setDefaultAddress = asyncHandlers(async (req, res) => {
    await setDefault(req.user.id, req.params.id);
    const address = await get(req.user.id, req.params.id);
    if (!address) throw notFound();
    return res.status(200).json(new ApiResponse(200, { address }, "Default address updated."));
});

export { listAddresses, getAddress, createAddress, updateAddress, removeAddress, setDefaultAddress };