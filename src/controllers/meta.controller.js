import { asyncHandlers } from "../utils/asyncHandlers.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { deliveryMethods } from "../core/delivery.js";
import { ACCEPTED_MIME_TYPES } from "../middlewares/multer.middleware.js";

/**
 * The three `/meta/*` capability reads: what the checkout and upload screens
 * can offer, answered before anyone signs in.
 *
 * These lists are the app's vocabulary, not a tenant's configuration, so they
 * are constants here rather than rows in the datastore — the simulator answers
 * from `PAYMENT_METHODS` and `shared/delivery.ts` the same way, and the old
 * backend exposed the very same three routes.
 *
 * Two details are deliberate:
 *
 *   Payment entries keep the full option (`caption`, `simulated`,
 *   `settledOnDelivery`) behind the `id`/`label` the client types, because
 *   whether money moves is exactly what a checkout screen must be able to say
 *   out loud.
 *
 *   Delivery entries carry `premiumPerSeller` and the day window but NO fee:
 *   a fee only exists once a store's `shippingFee` and a seller count are
 *   known, which is cart pricing's job (`core/delivery.js#quoteDelivery`).
 *   Publishing a flat number here would advertise a price checkout cannot honour.
 */

/** Mirror of `payment-service.ts` PAYMENT_METHODS — same ids, same captions. */
const PAYMENT_METHODS = [
    {
        id: "cod",
        label: "Cash on delivery",
        caption: "Pay the courier when the order reaches you",
        simulated: false,
        settledOnDelivery: true
    },
    {
        id: "bkash",
        label: "bKash",
        caption: "Simulated bKash confirmation — no real money moves",
        simulated: true,
        settledOnDelivery: false
    },
    {
        id: "nagad",
        label: "Nagad",
        caption: "Simulated Nagad confirmation — no real money moves",
        simulated: true,
        settledOnDelivery: false
    },
    {
        id: "card",
        label: "Card",
        caption: "Simulated card confirmation — no gateway is contacted",
        simulated: true,
        settledOnDelivery: false
    }
];

const PAYMENT_NOTE =
    "Only cash on delivery settles with the courier. Other methods are simulated locally and move no money.";

/**
 * The zero-configuration provider: media produced on the device, stored as
 * `p:…` placeholders. `configured` is true for the one thing that works with
 * no vendor at all, `available` rides along as the simulator's spelling of the
 * same fact, and `active` names the default provider when no object-storage
 * vendor is configured.
 */
const MEDIA_PROVIDERS = [
    {
        id: "local",
        label: "Device media (local)",
        configured: true,
        available: true
    }
];

const MEDIA_ACTIVE = "local";

const ACCEPTED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const MEDIA_NOTE = "Product and avatar media is produced on the device. No object-storage vendor is configured.";

/**
 * Where uploads actually go, reported from the environment instead of from a
 * hard-coded story. Before M13 nothing on this server consumed object
 * storage, so the report said "local" and said it plainly; the seller media
 * slice now uploads to Cloudinary, and a capability endpoint that still
 * claimed no vendor was configured would be lying to the client it is meant
 * to inform.
 *
 * The shape is unchanged (`active`, `providers[]`, `acceptedContentTypes`,
 * `note`): only the values follow the configuration. With all three
 * CLOUDINARY_* keys present the Cloudinary provider is `active` and
 * `configured`, the accepted list mirrors the multer fileFilter exactly, and
 * the note says media is stored per seller; without them the payload is the
 * old local-only report, byte for byte. Local stays listed either way —
 * `p:…` placeholders and device media still work with zero configuration.
 *
 * `configured` is read per request rather than at module load, so an
 * environment change is visible without a restart and no credential value is
 * ever echoed (only the fact that all three are set).
 */
const cloudinaryConfigured = () =>
    Boolean(
        (process.env.CLOUDINARY_API_NAME ?? "").trim() &&
        (process.env.CLOUDINARY_API_KEY ?? "").trim() &&
        (process.env.CLOUDINARY_API_SECRET ?? "").trim()
    );

const mediaProvidersReport = () => {
    if (!cloudinaryConfigured()) {
        return {
            active: MEDIA_ACTIVE,
            providers: MEDIA_PROVIDERS.map((provider) => ({ ...provider })),
            acceptedContentTypes: [...ACCEPTED_CONTENT_TYPES],
            note: MEDIA_NOTE
        };
    }

    return {
        active: "cloudinary",
        providers: [
            { id: "cloudinary", label: "Cloudinary object storage", configured: true, available: true },
            ...MEDIA_PROVIDERS.map((provider) => ({ ...provider }))
        ],
        acceptedContentTypes: [...ACCEPTED_MIME_TYPES],
        note: "Uploads are stored on Cloudinary inside the uploading seller's own folder."
    };
};

// GET /meta/payment-methods — the settlement vocabulary, with its honesty note.
const getPaymentMethods = asyncHandlers(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, { methods: PAYMENT_METHODS.map((option) => ({ ...option })), note: PAYMENT_NOTE }, "Payment methods.")
    );
});

// GET /meta/delivery-methods — standard and express, priced by the cart only.
const getDeliveryMethods = asyncHandlers(async (req, res) => {
    return res.status(200).json(new ApiResponse(200, { methods: deliveryMethods() }, "Delivery methods."));
});

// GET /meta/media-providers — where an upload can go, and what it may carry.
const getMediaProviders = asyncHandlers(async (req, res) => {
    const report = mediaProvidersReport();

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                active: report.active,
                providers: report.providers,
                acceptedContentTypes: report.acceptedContentTypes,
                note: report.note
            },
            "Media providers."
        )
    );
});

export { getPaymentMethods, getDeliveryMethods, getMediaProviders };
