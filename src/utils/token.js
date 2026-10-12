import { createHash, randomBytes } from "crypto";
import { TOKEN_SHAPE } from "../constance.js";

/**
 * Opaque bearer tokens.
 *
 * The client stores the token and learns nothing from it: there is no payload
 * to read and no signature to forge, so every request is resolved server-side.
 * What the database keeps is `hashToken(token)` — a SHA-256 digest — which means
 * a leaked collection yields no credential anybody can replay.
 */
const generateOpaqueToken = () => randomBytes(32).toString("hex");

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** Shape check before any lookup, so junk never reaches an index. */
const isWellFormedToken = (token) => typeof token === "string" && TOKEN_SHAPE.test(token);

export { generateOpaqueToken, hashToken, isWellFormedToken };
