import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import {
    listAddresses,
    getAddress,
    createAddress,
    updateAddress,
    removeAddress,
    setDefaultAddress
} from "../controllers/address.controller.js";

/**
 * Vanta address book routes, mounted at `/api/v1`.
 *
 * Paths are the FULL client paths the address screen calls. Everything is
 * authenticated — every address belongs to `req.user.id` (`authenticate`
 * guarantees it), and an id that is not the caller's own is "Address not
 * found." Clients derive the default from the `isDefault` flags; there is no
 * separate default endpoint beyond the `/default` promotion below.
 */
const router = Router();

// the caller's address book, insertion order
router.route("/addresses").get(authenticate, listAddresses);

// create one address (the first one auto-becomes default)
router.route("/addresses").post(authenticate, createAddress);

// read one of the caller's own addresses
router.route("/addresses/:id").get(authenticate, getAddress);

// merge a subset of AddressInput fields into one address
router.route("/addresses/:id").patch(authenticate, updateAddress);

// remove one address, returning the remaining book
router.route("/addresses/:id").delete(authenticate, removeAddress);

// promote one address to the single default
router.route("/addresses/:id/default").post(authenticate, setDefaultAddress);

export default router;