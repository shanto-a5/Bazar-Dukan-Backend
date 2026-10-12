import { ApiError } from "../utils/ApiError.js";
import { User } from "../models/user.model.js";
import { addressRepository } from "../repositories/address.repository.js";

/**
 * Address book domain rules, mirroring `src/services/address-service.ts`.
 *
 * - Validation is `validate()` verbatim: the exact message strings, phone
 *   checked on its non-digit-stripped digits, postal code only when present,
 *   and `area` deliberately NOT validated (trimmed only, default "").
 * - `label` trimmed or "Address"; `instructions` trimmed and stored as
 *   `null` when blank.
 * - `isDefault` is a single-default invariant maintained by `setDefault`:
 *   the first address auto-becomes default (or `isDefault: true` on create),
 *   clearing every other row; a default demoted by PATCH hands the flag to
 *   the first remaining address, or keeps it when it is the only one.
 * - Every owner-scoped read is by the authenticated `userId`; a row that is
 *   not yours is "Address not found." Identity always comes from `req.user.id`.
 */
const NOT_FOUND = () => new ApiError(404, "Address not found.", [], "", "not_found");

const str = (value) => (typeof value === "string" ? value.trim() : "");

/** The simulator's `validate()` — every field collected, exact wording. */
const validate = (input) => {
    const errors = [];
    if (str(input.recipientName) === "") errors.push({ field: "recipientName", message: "Who should receive the order?" });
    if (str(input.phone).replace(/\D/g, "").length < 6) {
        errors.push({ field: "phone", message: "Enter a valid phone number" });
    }
    if (str(input.division) === "") errors.push({ field: "division", message: "Division is required" });
    if (str(input.district) === "") errors.push({ field: "district", message: "District is required" });
    if (str(input.addressLine) === "") errors.push({ field: "addressLine", message: "Street address is required" });
    const postalCode = str(input.postalCode);
    if (postalCode !== "" && !/^\d{4}$/.test(postalCode)) {
        errors.push({ field: "postalCode", message: "Use a 4 digit postal code" });
    }
    return errors;
};

/** ONE 422 carrying every offending field; the top message is the first, as thrown first. */
const throwValidation = (input) => {
    const errors = validate(input);
    if (errors.length > 0) throw new ApiError(422, errors[0].message, errors, "", "validation_failed");
};

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** The wire shape of an address: `id`, never `_id`/`__v`, ISO timestamps. */
const toAddressDto = (address) => ({
    id: String(address._id),
    userId: String(address.userId),
    label: address.label ?? "Address",
    recipientName: address.recipientName,
    phone: address.phone,
    division: address.division,
    district: address.district,
    area: address.area ?? "",
    addressLine: address.addressLine,
    postalCode: address.postalCode ?? "",
    instructions: address.instructions ?? null,
    isDefault: Boolean(address.isDefault),
    createdAt: iso(address.createdAt),
    updatedAt: iso(address.updatedAt)
});

/** The caller's addresses in insertion order (createdAt ascending). */
const list = async (userId) => {
    const rows = await addressRepository.listByUser(userId);
    return rows.map(toAddressDto);
};

const count = async (userId) => addressRepository.countByUser(userId);

/** One address, but only when it is the caller's own; otherwise undefined. */
const get = async (userId, id) => {
    const address = await addressRepository.findById(id);
    if (!address || String(address.userId) !== String(userId)) return undefined;
    return toAddressDto(address);
};

/** Mark one address default and every other one not — the single-default rule. */
const setDefault = async (userId, id) => {
    const address = await addressRepository.findById(id);
    if (!address || String(address.userId) !== String(userId)) throw NOT_FOUND();

    const now = new Date();
    for (const entry of await addressRepository.listByUser(userId)) {
        const isDefault = String(entry._id) === String(id);
        if (Boolean(entry.isDefault) !== isDefault) {
            await addressRepository.updateById(entry._id, { isDefault, updatedAt: now });
        }
    }
};

/** Create an address; auto-default when it is the first, else honour `isDefault`. */
const add = async (userId, input) => {
    if (!(await User.findById(userId))) throw new ApiError(404, "User not found.", [], "", "not_found");
    throwValidation(input);

    const existingCount = await count(userId);
    const makeDefault = input.isDefault ?? existingCount === 0;

    const address = await addressRepository.create({
        userId,
        label: str(input.label) || "Address",
        recipientName: str(input.recipientName),
        phone: str(input.phone),
        division: str(input.division),
        district: str(input.district),
        area: str(input.area),
        addressLine: str(input.addressLine),
        postalCode: str(input.postalCode),
        instructions: input.instructions ? str(input.instructions) || null : null,
        isDefault: makeDefault
    });

    if (makeDefault) await setDefault(userId, String(address._id));
    return toAddressDto(await addressRepository.findById(address._id));
};

/**
 * Merge only the AddressInput fields, re-validate the result, then apply the
 * default rules: set when patched true, hand on when demoted and others exist,
 * keep when it is the only address.
 */
const update = async (userId, id, patch) => {
    const address = await addressRepository.findById(id);
    if (!address || String(address.userId) !== String(userId)) throw NOT_FOUND();

    const merged = {
        label: patch.label ?? address.label,
        recipientName: patch.recipientName ?? address.recipientName,
        phone: patch.phone ?? address.phone,
        division: patch.division ?? address.division,
        district: patch.district ?? address.district,
        area: patch.area ?? address.area,
        addressLine: patch.addressLine ?? address.addressLine,
        postalCode: patch.postalCode ?? address.postalCode,
        instructions: patch.instructions ?? address.instructions ?? null
    };
    throwValidation(merged);

    const now = new Date();
    await addressRepository.updateById(id, {
        label: str(merged.label) || "Address",
        recipientName: str(merged.recipientName),
        phone: str(merged.phone),
        division: str(merged.division),
        district: str(merged.district),
        area: str(merged.area),
        addressLine: str(merged.addressLine),
        postalCode: str(merged.postalCode),
        instructions: merged.instructions ? str(merged.instructions) || null : null,
        updatedAt: now
    });

    if (patch.isDefault && !address.isDefault) await setDefault(userId, id);
    if (patch.isDefault === false && address.isDefault) {
        const remaining = (await addressRepository.listByUser(userId)).filter(
            (entry) => String(entry._id) !== String(id)
        );
        if (remaining.length === 0) await setDefault(userId, id);
        else await setDefault(userId, String(remaining[0]._id));
    }

    return toAddressDto(await addressRepository.findById(id));
};

/** Remove one address; if it was default, hand the flag to the first remaining. */
const remove = async (userId, id) => {
    const address = await addressRepository.findById(id);
    if (!address || String(address.userId) !== String(userId)) throw NOT_FOUND();

    await addressRepository.removeById(id);

    const remaining = await addressRepository.listByUser(userId);
    if (address.isDefault && remaining.length > 0) {
        await setDefault(userId, String(remaining[0]._id));
    }
};

export { list, count, get, add, update, setDefault, remove, toAddressDto };