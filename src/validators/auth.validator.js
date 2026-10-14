import { ApiError } from "../utils/ApiError.js";
import { emailValidator } from "../utils/helper/email.validator.js";
import { PHONE_PATTERN, MIN_PASSWORD_LENGTH } from "../constance.js";

/**
 * Request validation for the auth surface.
 *
 * Each validator normalises what came in and throws a single
 * `422 / validation_failed` carrying *every* offending field at once, because a
 * form that highlights one problem per round trip is a bad form. The error
 * middleware forwards those entries as `error.fields`, which the client reads
 * back onto the matching input.
 */
const validationError = (message, fields) => new ApiError(422, message, fields, "", "validation_failed");

/**
 * Fields no client may ever write. They are rejected loudly rather than
 * dropped: silently ignoring `roles` would hide an attempt to grant oneself a
 * role, and a silent ignore gives the caller no way to learn the rule exists.
 */
const SERVER_ONLY_FIELDS = [
    "roles",
    "passwordHash",
    "passwordSalt",
    "id",
    "_id",
    "createdAt",
    "updatedAt",
    "emailVerified",
    "sellerApproved",
    "__v"
];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const rejectServerOnlyFields = (body, fields) => {
    for (const key of Object.keys(body)) {
        if (!SERVER_ONLY_FIELDS.includes(key)) continue;
        fields.push({
            field: key,
            message: key === "roles" ? "Roles are assigned by the server, not by the client." : `${key} cannot be set from a request.`
        });
    }
};

const validateRegister = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectServerOnlyFields(body, fields);

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (name.length < 2) fields.push({ field: "name", message: "Please enter your full name." });
    if (!emailValidator(email)) fields.push({ field: "email", message: "Enter a valid email address." });
    if (!PHONE_PATTERN.test(phone)) fields.push({ field: "phone", message: "Enter a valid phone number." });
    if (password.length < MIN_PASSWORD_LENGTH) {
        fields.push({ field: "password", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { name, email, phone, password };
};

/**
 * Quick account: the frictionless onboarding path. The only thing the customer
 * supplies is a phone number — the display name, the sign-in email and the
 * password are all generated server-side, so this validator never sees (and
 * never accepts) the fields a normal register would. The same
 * `PHONE_PATTERN` the register/login paths use is the single phone rule.
 */
const validateQuickAccount = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectServerOnlyFields(body, fields);

    const phone = typeof body.phone === "string" ? body.phone.trim() : "";
    if (!PHONE_PATTERN.test(phone)) fields.push({ field: "phone", message: "Enter a valid phone number." });

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { phone };
};

/**
 * Sign-in. The single identifier field carries either an email, or the phone
 * number a quick account was created with — quick accounts have a generated
 * placeholder address, so the phone is the only thing their owner can type.
 * Whatever arrives is normalised to `identifier`; the service decides how to
 * look it up. A phone still needs the password (the phone is not unique and is
 * never proof on its own), which is why there is no phone-only branch here.
 */
const validateLogin = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    const raw = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    let identifier = "";
    if (emailValidator(raw)) identifier = raw.toLowerCase();
    else if (PHONE_PATTERN.test(raw)) identifier = raw;
    else fields.push({ field: "email", message: "Enter the email or phone number on your account." });

    if (password === "") fields.push({ field: "password", message: "Enter your password." });

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { identifier, password };
};

/**
 * First password on a quick account. There is no `currentPassword`: the account
 * never had one its owner knew. Whether this call is allowed at all is decided
 * in the service from the account's `passwordSet` flag, not from the request.
 */
const validateInitialPassword = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        fields.push({ field: "newPassword", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { newPassword };
};

/**
 * Profile patch. Only the four profile columns are writable; the return value
 * is built key by key, so an unrecognised key has nowhere to land even if it
 * slipped past the server-only check.
 */
const validateProfilePatch = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    rejectServerOnlyFields(body, fields);

    const patch = {};

    if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (name.length < 2) fields.push({ field: "name", message: "Please enter your full name." });
        else patch.name = name;
    }

    if (body.email !== undefined) {
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!emailValidator(email)) fields.push({ field: "email", message: "Enter a valid email address." });
        else patch.email = email;
    }

    if (body.phone !== undefined) {
        const phone = typeof body.phone === "string" ? body.phone.trim() : "";
        if (!PHONE_PATTERN.test(phone)) fields.push({ field: "phone", message: "Enter a valid phone number." });
        else patch.phone = phone;
    }

    if (body.avatar !== undefined) {
        const avatar = typeof body.avatar === "string" ? body.avatar.trim() : "";
        if (avatar.length > 1024) fields.push({ field: "avatar", message: "That avatar reference is too long." });
        else patch.avatar = avatar;
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    if (Object.keys(patch).length === 0) throw validationError("No profile fields were provided.", []);

    return patch;
};

const validateChangePassword = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (currentPassword === "") {
        fields.push({ field: "currentPassword", message: "Enter your current password." });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        fields.push({ field: "newPassword", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    } else if (newPassword === currentPassword) {
        fields.push({ field: "newPassword", message: "Choose a password you have not used before." });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { currentPassword, newPassword };
};

const validateResetRequest = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!emailValidator(email)) {
        throw validationError("Please fix the highlighted fields.", [
            { field: "email", message: "Enter a valid email address." }
        ]);
    }

    return { email };
};

const validateResetConfirm = (body) => {
    if (!isPlainObject(body)) throw validationError("Request body must be an object.", []);

    const fields = [];
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (token === "") fields.push({ field: "token", message: "That reset link is not valid. Request a new one." });
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
        fields.push({ field: "newPassword", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }

    if (fields.length > 0) throw validationError("Please fix the highlighted fields.", fields);
    return { token, newPassword };
};

export {
    validationError,
    validateRegister,
    validateQuickAccount,
    validateLogin,
    validateProfilePatch,
    validateChangePassword,
    validateInitialPassword,
    validateResetRequest,
    validateResetConfirm
};
