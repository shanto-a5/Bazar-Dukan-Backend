import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { ApiError } from "../utils/ApiError.js";
import { uploadMedia, deleteMedia } from "../services/media.service.js";
import { validateDeleteMediaInput } from "../validators/media.validator.js";

/**
 * The seller media surface: two endpoints, no datastore of its own.
 *
 * POST answers `201 {media: {url, publicId, format, resourceType}}` and edits
 * nothing — the client turns around and PATCHes that URL onto a product or a
 * store through the M12 routes, which already verify the target document
 * belongs to the caller. DELETE answers `200 {deleted: true}` once the asset
 * inside the caller's namespace is gone.
 *
 * Identity is `req.sellerProfile._id`, resolved from the session by
 * `requireSeller` — never anything the body or the multipart parts could name.
 * Multer's own failures (size, type) are mapped to 422s in the route, before
 * this file is reached; what is left here is the empty-`req.file` case, which
 * a multipart body without a `file` part produces.
 */

const uploadSellerMedia = asyncHandlers(async (req, res) => {
    if (!req.file) {
        throw new ApiError(422, "No file was uploaded.", [{ field: "file", message: "Choose a file to upload." }], "", "validation_failed");
    }

    const media = await uploadMedia(req.file, { sellerId: String(req.sellerProfile._id) });

    return res.status(201).json(new ApiResponse(201, { media }, "Media uploaded."));
});

const deleteSellerMedia = asyncHandlers(async (req, res) => {
    const url = validateDeleteMediaInput(req.body);
    const result = await deleteMedia(url, { sellerId: String(req.sellerProfile._id) });

    return res.status(200).json(new ApiResponse(200, result, "Media deleted."));
});

export { uploadSellerMedia, deleteSellerMedia };
