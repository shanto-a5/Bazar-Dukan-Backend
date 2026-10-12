import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireSeller } from "../middlewares/authz.middleware.js";
import { upload, UNSUPPORTED_FILE_TYPE_CODE } from "../middlewares/multer.middleware.js";
import { ApiError } from "../utils/ApiError.js";
import { uploadSellerMedia, deleteSellerMedia } from "../controllers/media.controller.js";

/**
 * Seller media routes. The paths are the FULL ones (`/seller/media`), so the
 * router mounts straight onto the API prefix (`app.use("/api/v1",
 * sellerMediaRouter)`) without a hidden segment — exactly like
 * `seller-product.route.js` and `seller.route.js`.
 *
 * Order on POST matters: `authenticate` reads the session, `requireSeller`
 * resolves it to an active `SellerProfile`, and only then does multer touch
 * the body. A stranger therefore gets a 401/403 before a single byte is
 * staged, and the upload folder never fills up on behalf of anonymous
 * callers. The seller identity the controller uses is `req.sellerProfile._id`
 * — the multipart parts cannot name one.
 *
 * `receiveFile` wraps `upload.single("file")` purely to translate multer's
 * failures into the messages the seller UI shows: the size ceiling, the
 * rejected content type (the fileFilter's own error), and — for anything else
 * multer raises — its message, all as `422 / validation_failed`.
 */
const validationError = (message, fieldMessage) =>
    new ApiError(422, message, [{ field: "file", message: fieldMessage }], "", "validation_failed");

const receiveFile = (req, res, next) => {
    upload.single("file")(req, res, (error) => {
        if (!error) return next();

        if (error.code === "LIMIT_FILE_SIZE") {
            return next(validationError("That file is too large. The maximum size is 10 MB.", "Choose a file under 10 MB."));
        }
        if (error.code === UNSUPPORTED_FILE_TYPE_CODE) {
            return next(validationError("That file type is not supported.", "Choose an image or a video file."));
        }
        const message = typeof error.message === "string" && error.message !== "" ? error.message : "The file could not be processed.";
        return next(validationError(message, message));
    });
};

const router = Router();

// upload first, delete beside it: one resource, two verbs
router
    .route("/seller/media")
    .post(authenticate, requireSeller, receiveFile, uploadSellerMedia)
    .delete(authenticate, requireSeller, deleteSellerMedia);

export default router;
