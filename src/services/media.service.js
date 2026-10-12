import fs from "fs";
import { ApiError } from "../utils/ApiError.js";
import { uploadOnCloudinary, deleteFileOnCloudinary } from "../utils/cloudinary.js";

/**
 * Seller-owned product/store media: upload to Cloudinary, delete from it.
 *
 * The slice deliberately reuses the two functions `utils/cloudinary.js` has
 * always exposed — there is no second storage abstraction, and no media row is
 * written anywhere. A media URL IS the record: it is handed back to the
 * client, which PATCHes it onto a product or a store through the existing M12
 * routes, and those routes already enforce that the target document belongs to
 * the caller. The upload endpoint itself never touches a product or store.
 *
 * Ownership is expressed as a NAMESPACE, not as a database lookup: every
 * upload lands in `vanta/sellers/<sellerId>/`, and a delete is only honoured
 * when the URL's public id sits inside the caller's own namespace. That gives
 * the same 404 for "another seller's asset" and "no such asset" — there is no
 * IDOR oracle telling one seller what another has stored.
 *
 * Idempotency: Cloudinary answers `{result: "not found"}` for an asset that is
 * already gone, which counts as a successful delete. Only an API failure
 * (null) is a 500.
 */

/** Delivery URLs live on `*.res.cloudinary.com`; nothing else is managed. */
const CLOUDINARY_DELIVERY_HOST = "res.cloudinary.com";

/** Marks the half of a Cloudinary path that carries the public id. */
const UPLOAD_MARKER = "/upload/";

/** Resource-type segments Cloudinary may place around `/upload/`. */
const RESOURCE_TYPES = ["image", "video", "raw"];

/** The `v1234567890` version segment that prefixes a public id in a URL. */
const VERSION_PATTERN = /^v\d+$/;

/** Every upload is namespaced under the seller that performed it. */
const SELLER_FOLDER = "vanta/sellers/";

const isResourceType = (segment) => RESOURCE_TYPES.includes(segment);

const decodeSegment = (segment) => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
};

/**
 * Reads a Cloudinary delivery URL back into `{publicId, resourceType}`.
 *
 * Only `*.res.cloudinary.com` URLs whose path contains `/upload/` qualify.
 * Everything else — local `p:…` placeholders, foreign CDNs, relative paths,
 * garbage — answers `null`, which the caller turns into a 422. The query
 * string is dropped with `URL`, a leading `v<digits>/` version segment and the
 * trailing extension are stripped from the public id, and the resource type is
 * taken from the `/image/`, `/video/` or `/raw/` segment (default `image`,
 * which is what a URL without that segment — `/upload/v1/…` — means).
 *
 * @param {unknown} url the URL a client wants to act on
 * @returns {{publicId: string, resourceType: string} | null}
 */
const parseManagedUrl = (url) => {
    if (typeof url !== "string" || url.trim() === "") return null;

    let parsed;
    try {
        parsed = new URL(url.trim());
    } catch {
        return null;
    }

    if (!parsed.hostname.endsWith(CLOUDINARY_DELIVERY_HOST)) return null;

    const pathname = parsed.pathname;
    const markerIndex = pathname.indexOf(UPLOAD_MARKER);
    if (markerIndex === -1) return null;

    const beforeMarker = pathname.slice(0, markerIndex).split("/").filter(Boolean);
    const markerSegment = beforeMarker[beforeMarker.length - 1];
    let resourceType = isResourceType(markerSegment) ? markerSegment : null;

    const segments = pathname.slice(markerIndex + UPLOAD_MARKER.length).split("/").filter(Boolean);
    if (segments.length === 0) return null;

    if (VERSION_PATTERN.test(segments[0])) segments.shift();
    if (segments.length === 0) return null;

    if (!resourceType && isResourceType(segments[0])) {
        resourceType = segments.shift();
        if (segments.length === 0) return null;
    }

    const last = segments[segments.length - 1];
    const dotIndex = last.lastIndexOf(".");
    segments[segments.length - 1] = dotIndex > 0 ? last.slice(0, dotIndex) : last;

    const publicId = segments.map(decodeSegment).join("/");
    if (!publicId) return null;

    return { publicId, resourceType: resourceType ?? "image" };
};

/**
 * Uploads one freshly received temp file into the seller's folder.
 *
 * `utils/cloudinary.js` unlinks the temp file on both the success and the
 * failure path; the defensive unlink below only fires when the util returned
 * `null` without a file left to remove, so no path can leave bytes behind.
 * A failed upload is a 500 in the Vanta envelope, never a partial success.
 *
 * @param {{path: string}} file the multer file record
 * @param {{sellerId: string}} owner identity from `req.sellerProfile._id`
 * @returns {Promise<{url: string, publicId: string, format: string, resourceType: string}>}
 */
const uploadMedia = async (file, { sellerId } = {}) => {
    const localPath = file?.path;
    const response = await uploadOnCloudinary(localPath, `${SELLER_FOLDER}${sellerId}`);

    if (!response) {
        if (localPath) {
            try {
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
            } catch {
                // the temp file is already gone — nothing left to clean up
            }
        }
        throw new ApiError(500, "The file could not be uploaded. Please try again.", [], "", "internal_error");
    }

    return {
        url: response.secure_url,
        publicId: response.public_id,
        format: response.format,
        resourceType: response.resource_type
    };
};

/**
 * Deletes the asset a Cloudinary URL names, but only inside the caller's
 * namespace. `storeId` is accepted for symmetry with the rest of the slice and
 * is not part of the rule — the seller folder is the whole ownership check.
 *
 * @param {string} url the media URL the client wants gone
 * @param {{sellerId: string, storeId?: string}} owner identity from `req.sellerProfile._id`
 * @returns {Promise<{deleted: true}>}
 */
const deleteMedia = async (url, { sellerId, storeId } = {}) => {
    const managed = parseManagedUrl(url);
    if (!managed) {
        throw new ApiError(422, "That media URL is not managed by Vanta.", [], "", "validation_failed");
    }

    const namespace = `${SELLER_FOLDER}${sellerId}/`;
    if (!managed.publicId.startsWith(namespace)) {
        throw new ApiError(404, "Media not found.", [], "", "not_found");
    }

    let response;
    try {
        response = await deleteFileOnCloudinary(managed.publicId);
    } catch {
        response = null;
    }

    // `{result: "not found"}` is a success: the asset is gone either way.
    if (!response || typeof response !== "object") {
        throw new ApiError(500, "The file could not be deleted. Please try again.", [], "", "internal_error");
    }

    return { deleted: true };
};

export { parseManagedUrl, uploadMedia, deleteMedia };
