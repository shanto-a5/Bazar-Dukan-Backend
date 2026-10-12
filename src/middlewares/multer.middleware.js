import multer from "multer";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

/**
 * The one multipart intake Vanta has (multer disk storage into `./public/temp`).
 *
 * `upload` keeps its original export name and its staging folder, so the module
 * stays drop-in compatible: it was exported before the media slice and nothing
 * else imports it today (verified by grep — the only reference is this file).
 *
 * What the media slice added, and why:
 *
 *   destination — the folder is created on demand (`recursive: true`) and once
 *   at module load, because multer errors out when the directory is missing.
 *   filename    — `${Date.now()}-${randomBytes(8)}.${ext}`. Two concurrent
 *   uploads can no longer overwrite each other, and only
 *   `path.extname(path.basename(originalname))` survives, so a crafted name
 *   like `../../x.php` cannot escape the staging folder (traversal-safe, and
 *   collision-safe by construction).
 *   limits      — 10 MB, the ceiling `POST /seller/media` advertises. Multer
 *   removes the partial file itself when the limit trips.
 *   fileFilter  — only the image types the catalog stores plus `video/mp4`
 *   (`Product.video`). Anything else is refused before a byte is written, with
 *   an error carrying `UNSUPPORTED_FILE_TYPE_CODE` so the route can translate
 *   it into the user-facing 422 instead of a generic multer message.
 */

/** Where multipart bytes are staged until Cloudinary has seen them. */
const TEMP_DIR = "./public/temp";

/** The upload ceiling, advertised by the upload endpoint's 422 message. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Content types the upload surface accepts: images + the product preview video. */
const ACCEPTED_MIME_TYPES = [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/heic",
    "video/mp4"
];

/** Error code raised by the fileFilter below; the route maps it to a 422. */
const UNSUPPORTED_FILE_TYPE_CODE = "LIMIT_UNSUPPORTED_TYPE";

// the folder must exist before multer ever opens a write stream in it
fs.mkdirSync(TEMP_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        cb(null, TEMP_DIR);
    },
    filename: function (req, file, cb) {
        const extension = path.extname(path.basename(file.originalname ?? "")).toLowerCase().slice(0, 10);
        cb(null, `${Date.now()}-${randomBytes(8).toString("hex")}${extension}`);
    }
});

const fileFilter = (req, file, cb) => {
    if (ACCEPTED_MIME_TYPES.includes(file.mimetype)) {
        return cb(null, true);
    }
    const error = new Error("That file type is not supported.");
    error.code = UNSUPPORTED_FILE_TYPE_CODE;
    return cb(error);
};

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE }, fileFilter });

export { upload, ACCEPTED_MIME_TYPES, UNSUPPORTED_FILE_TYPE_CODE };
