import { ApiError } from "../utils/ApiError.js";
import { Product } from "../models/product.model.js";
import { Store } from "../models/store.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { Voucher } from "../models/voucher.model.js";
import { effectivePrice, productStock, productIsVisibleToCustomer } from "../core/catalog-rules.js";
import { roundMoney } from "../core/money.js";
import { countSelectedItems } from "../core/pricing.js";
import { resolveCartGroups, cartTotals } from "./cart-pricing.service.js";
import { quoteForResolved } from "./voucher.service.js";
import { cartRepository } from "../repositories/cart.repository.js";

/**
 * Cart domain rules, mirroring `src/services/cart-service.ts`.
 *
 * - Line identity is (productId, variantId ?? null); re-adding merges into the
 *   same line, capped at `max(stock, 1)`. The 1 floor intentionally lets a
 *   sold-out line hold quantity 1 so the customer can still see it.
 * - Quantities are clamped against live catalog stock; `selected` is flipped
 *   without ever touching `quantity` (a deselect must not re-enter the order).
 * - The cart ALWAYS belongs to `userId` (the authenticated actor); an item id
 *   that is not in that user's cart is 404 — a foreign cart is never reachable.
 * - Prices are never re-derived here: `resolveCartGroups` + `cartTotals` are
 *   the pricing engine, the stored `priceSnapshot` is diagnostic only and is
 *   surfaced as a `price_changed` issue.
 * - Every read emits a light audit (`issues`) with the same kinds and wording
 *   as the simulator's `audit()`.
 */

const NOT_FOUND_ITEM = () => new ApiError(404, "Cart item not found.", [], "", "not_found");
const NOT_AVAILABLE = () =>
    new ApiError(422, "This item is not available for ordering right now.", [], "", "validation_failed");

// ৳ with the locale the simulator's formatMoney uses, so issue messages match
// the customer-facing text verbatim.
const formatMoney = (amount) => `\u09F3${Math.round(amount).toLocaleString("en-BD")}`;

const toPlain = (value) => {
    if (value == null) return null;
    if (value instanceof Map) return Object.fromEntries(value);
    if (typeof value.toObject === "function") return value.toObject();
    return value;
};

const variantById = (product, variantId) => {
    if (!variantId) return undefined;
    return product.variants.find((entry) => String(entry._id) === String(variantId));
};

const plainItem = (item) => ({ ...item.toObject(), id: String(item._id) });

const toCartItemDto = (item) => ({
    id: String(item._id),
    productId: String(item.productId),
    sellerId: String(item.sellerId),
    variantId: item.variantId ? String(item.variantId) : null,
    variantAttributes: toPlain(item.variantAttributes),
    quantity: item.quantity,
    selected: Boolean(item.selected),
    priceSnapshot: roundMoney(item.priceSnapshot ?? 0),
    addedAt: new Date(item.addedAt ?? Date.now()).toISOString()
});

/**
 * One line in the contract's `PricedCartLine` shape — used both for the flat
 * `items` array and for each group's `items`. Extras the simulator's cart
 * screen reads (`brand`, `priceChanged`, `variantAttributes`) ride along.
 */
const toPricedLine = (line) => ({
    id: String(line.itemId),
    productId: String(line.productId),
    variantId: line.variantId ? String(line.variantId) : null,
    sellerId: String(line.sellerId),
    storeId: String(line.storeId ?? ""),
    name: line.productName,
    image: line.image ?? "",
    quantity: line.quantity,
    selected: Boolean(line.selected),
    unitPrice: roundMoney(line.unitPrice),
    subtotal: roundMoney(line.subtotal),
    available: Boolean(line.available),
    unavailableReason: line.unavailableReason ?? null,
    brand: line.brand ?? "",
    priceChanged: Boolean(line.priceChanged),
    variantAttributes: toPlain(line.variantAttributes)
});

const toGroupDto = (group) => ({
    sellerId: String(group.sellerId),
    storeId: String(group.store?._id ?? group.store?.id ?? ""),
    storeName: group.store?.name ?? "",
    items: group.items.map(toPricedLine),
    subtotal: roundMoney(group.subtotal),
    shippingFee: roundMoney(group.shippingFee),
    freeShipping: Boolean(group.freeShipping),
    hasSelectedLines: Boolean(group.hasSelectedLines),
    store: {
        id: String(group.store?._id ?? group.store?.id ?? ""),
        name: group.store?.name ?? "",
        logo: group.store?.logo ?? "",
        shippingFee: roundMoney(group.store?.shippingFee ?? 0),
        freeShippingThreshold: roundMoney(group.store?.freeShippingThreshold ?? 0),
        status: group.store?.status ?? ""
    }
});

const toTotalsDto = (totals) => ({
    subtotal: roundMoney(totals.subtotal),
    shippingTotal: roundMoney(totals.shippingTotal),
    voucherDiscount: roundMoney(totals.voucherDiscount),
    cartTotal: roundMoney(totals.cartTotal),
    deliveryFee: roundMoney(totals.deliveryFee),
    grandTotal: roundMoney(totals.grandTotal),
    itemCount: totals.itemCount,
    quote: {
        methodId: totals.quote?.methodId ?? "",
        label: totals.quote?.label ?? "",
        caption: totals.quote?.caption ?? "",
        fee: roundMoney(totals.quote?.fee ?? 0),
        daysMin: totals.quote?.daysMin ?? 0,
        daysMax: totals.quote?.daysMax ?? 0,
        window: totals.quote?.window ?? "",
        sellerCount: totals.quote?.sellerCount ?? 0,
        premiumPerSeller: totals.quote?.premiumPerSeller ?? 0,
        baseFee: roundMoney(totals.quote?.baseFee ?? 0)
    }
});

/** The `PricedCart.delivery` quote — the method the cart is priced with. */
const toDeliveryDto = (totals) => ({
    methodId: totals.quote?.methodId ?? "",
    label: totals.quote?.label ?? "",
    caption: totals.quote?.caption ?? "",
    baseFee: roundMoney(totals.quote?.baseFee ?? 0),
    premiumPerSeller: roundMoney(totals.quote?.premiumPerSeller ?? 0),
    fee: roundMoney(totals.deliveryFee),
    sellerCount: totals.quote?.sellerCount ?? 0,
    daysMin: totals.quote?.daysMin ?? 0,
    daysMax: totals.quote?.daysMax ?? 0,
    window: totals.quote?.window ?? ""
});

/**
 * Only vouchers that are active AND inside their usable window are honoured.
 * An unknown, expired or inactive code yields no quote at all for the cart
 * view, mirroring the local cart screen which drops invalid codes.
 */
const resolveVoucher = async (voucherCode) => {
    if (!voucherCode || typeof voucherCode !== "string" || voucherCode.trim() === "") return null;
    const found = await Voucher.findOne({ code: voucherCode.trim().toUpperCase() });
    if (!found || !found.active) return null;
    const now = Date.now();
    if (new Date(found.startAt).getTime() > now || new Date(found.expiry).getTime() < now) return null;
    return found;
};

/**
 * Light audit emitted on every cart read. Issue kinds, fixes and wording mirror
 * the simulator's `audit()`; blocking = remove|reduce, advisory = review.
 */
const buildIssues = async (plainItems, groups) => {
    const issues = [];
    const lineByItemId = new Map();
    for (const group of groups) {
        for (const line of group.items) lineByItemId.set(String(line.itemId), { line, store: group.store });
    }

    for (const item of plainItems) {
        const itemId = String(item._id);
        const entry = lineByItemId.get(itemId);
        const productId = String(item.productId);

        if (!entry) {
            // The product or its store no longer exists, so the pricing engine
            // excluded the line. Name it when the catalog still knows it.
            const product = await Product.findById(productId);
            const name = product ? product.name : "This item";
            issues.push({
                kind: "unavailable",
                itemId,
                productId,
                productName: name,
                message: `${name} is no longer available and will block checkout.`,
                fix: "remove"
            });
            continue;
        }

        const { line, store } = entry;
        const name = line.productName;
        if (store && store.status !== "active") {
            issues.push({
                kind: "seller_paused",
                itemId,
                productId,
                productName: name,
                message: `${store.name} is paused right now, so ${name} cannot ship yet.`,
                fix: "review"
            });
        }

        // A line that points at a deleted option must not be repriced to the
        // base listing or checked against aggregate stock. It is simply gone.
        if (item.variantId && !line.variant) {
            issues.push({
                kind: "unavailable",
                itemId,
                productId,
                productName: name,
                message: `An option of ${name} is no longer available and will block checkout.`,
                fix: "remove"
            });
            continue;
        }

        const product = line.product;
        const stock = line.variant ? line.variant.stock : productStock(product);
        if (stock <= 0) {
            issues.push({
                kind: "out_of_stock",
                itemId,
                productId,
                productName: name,
                message: `${name} just sold out.`,
                fix: "remove"
            });
        } else if (stock < line.quantity) {
            issues.push({
                kind: "reduced",
                itemId,
                productId,
                productName: name,
                message: `Only ${stock} left of ${name}.`,
                fix: "reduce",
                suggestedQuantity: stock
            });
        }

        if (line.priceChanged) {
            const previousPrice = roundMoney(item.priceSnapshot ?? line.unitPrice);
            const currentPrice = roundMoney(line.unitPrice);
            issues.push({
                kind: "price_changed",
                itemId,
                productId,
                productName: name,
                message: `${name} is now ${formatMoney(currentPrice)} (was ${formatMoney(previousPrice)}).`,
                fix: "review",
                previousPrice,
                currentPrice
            });
        }
    }
    return issues;
};

/**
 * The one cart view every endpoint returns (POST/PATCH re-read the same shape,
 * so the client's cart screen never learns two different payloads).
 *
 * It IS the contract's `PricedCart`: every top-level key the client types
 * against, plus the simulator-compatible extras (`cart`, `totals`, `issues`)
 * the existing screens read. `cartId` is never null — a cart that was never
 * stored answers with the synthetic `cart_<userId>` the reference backend
 * uses. A provided voucher code is quoted through the core; the discount is
 * only applied when that quote is valid, so an ineligible-but-live code never
 * inflates the totals (checkout would refuse the same code with a 422).
 */
const cartView = async (cart, { deliveryMethod = "standard", voucherCode, userId = null } = {}) => {
    const items = cart?.items ?? [];
    const plainItems = items.map(plainItem);

    const groups = await resolveCartGroups(plainItems);
    const requestedCode = typeof voucherCode === "string" ? voucherCode.trim() : "";
    const voucher = await resolveVoucher(requestedCode);

    const base = cartTotals(groups, { voucher: null, deliveryMethod });
    let totals = base;
    let entry = null;
    if (voucher) {
        entry = quoteForResolved(voucher, {
            userId,
            groups,
            subtotal: base.subtotal,
            shippingTotal: base.shippingTotal
        });
        if (entry.valid) {
            totals = cartTotals(groups, { voucher, deliveryMethod });
            entry = { ...entry, discount: roundMoney(totals.voucherDiscount) };
        }
    }

    const issues = await buildIssues(plainItems, groups);

    return {
        cartId: cart ? String(cart._id) : `cart_${userId ?? ""}`,
        userId: String(userId ?? ""),
        items: groups.flatMap((group) => group.items).map(toPricedLine),
        groups: groups.map(toGroupDto),
        subtotal: roundMoney(totals.subtotal),
        shippingTotal: roundMoney(totals.shippingTotal),
        voucherDiscount: roundMoney(totals.voucherDiscount),
        grandTotal: roundMoney(totals.grandTotal),
        itemCount: countSelectedItems(plainItems),
        delivery: toDeliveryDto(totals),
        checkout: {
            subtotal: roundMoney(totals.subtotal),
            voucherDiscount: roundMoney(totals.voucherDiscount),
            deliveryFee: roundMoney(totals.deliveryFee),
            grandTotal: roundMoney(totals.grandTotal)
        },
        vouchers: entry ? [entry] : [],
        selectedVoucherCode: entry && entry.valid ? requestedCode : null,
        // --- extras kept for the existing simulator screens and tests ---
        cart: {
            id: cart ? String(cart._id) : null,
            items: plainItems.map(toCartItemDto)
        },
        totals: toTotalsDto(totals),
        issues
    };
};

// --------------------------------------------------------------------- reads

const getCartView = async (userId, { deliveryMethod, voucher } = {}) => {
    const cart = await cartRepository.findByUserId(userId);
    return cartView(cart, { deliveryMethod, voucherCode: voucher, userId });
};

// -------------------------------------------------------------------- writes

const addItemToCart = async (userId, { productId, variantId = null, quantity = 1 }) => {
    const product = await Product.findById(productId);
    if (!product) throw NOT_AVAILABLE();

    const store =
        (await Store.findById(product.storeId)) ?? (await Store.findOne({ sellerId: product.sellerId }));
    const seller = await SellerProfile.findById(product.sellerId);
    const lookups = {
        getStoreById: () => store,
        getStoreBySellerId: () => store,
        getSellerById: () => seller
    };
    if (!productIsVisibleToCustomer(product, lookups)) throw NOT_AVAILABLE();

    const variant = variantById(product, variantId);
    const available = variantId ? (variant ? variant.stock : 0) : productStock(product);

    const cart = await cartRepository.ensureCart(userId);
    const existing = cart.items.find(
        (item) =>
            String(item.productId) === String(productId) &&
            (item.variantId ?? null) === (variantId ?? null)
    );

    const now = new Date();
    if (existing) {
        existing.quantity = Math.min(existing.quantity + quantity, Math.max(available, 1));
        existing.selected = true; // a deliberate deselect is overridden by re-adding
        existing.updatedAt = now;
    } else {
        cart.items.push({
            productId: product._id,
            sellerId: product.sellerId,
            variantId: variantId ? String(variantId) : null,
            variantAttributes: variant ? toPlain(variant.attributes) : null,
            quantity: Math.min(quantity, Math.max(available, 1)),
            selected: true,
            priceSnapshot: variant ? variant.price : effectivePrice(product),
            addedAt: now
        });
    }

    await cartRepository.save(cart);
    return cartView(cart, { userId });
};

const updateCartItem = async (userId, itemId, { quantity, selected } = {}) => {
    const cart = await cartRepository.findByUserId(userId);
    const item = cart?.items.find((entry) => String(entry._id) === String(itemId));
    if (!item) throw NOT_FOUND_ITEM();

    if (quantity !== undefined) {
        const product = await Product.findById(item.productId);
        if (!product) throw NOT_FOUND_ITEM();
        const variant = variantById(product, item.variantId);
        const stock = item.variantId ? (variant ? variant.stock : 0) : productStock(product);
        item.quantity = Math.max(1, Math.min(quantity, Math.max(stock, 1)));
        item.updatedAt = new Date();
    }
    // selected toggles in isolation: quantity was already handled above, so a
    // deselect can never re-enter the order just by bumping a number.
    if (selected !== undefined) {
        item.selected = Boolean(selected);
        item.updatedAt = new Date();
    }

    await cartRepository.save(cart);
    return cartView(cart, { userId });
};

const removeCartItem = async (userId, itemId) => {
    const cart = await cartRepository.findByUserId(userId);
    const index = cart?.items.findIndex((entry) => String(entry._id) === String(itemId)) ?? -1;
    if (!cart || index === -1) throw NOT_FOUND_ITEM();

    cart.items.splice(index, 1);
    await cartRepository.save(cart);
    const view = await cartView(cart, { userId });
    return { removed: true, ...view };
};

const clearCart = async (userId) => {
    const cart = await cartRepository.findByUserId(userId);
    if (cart) {
        cart.items = [];
        await cartRepository.save(cart);
    }
    // A missing cart stays missing — nothing is created by emptying it.
    return cartView(cart, { userId });
};

const setSelection = async (userId, { selected, sellerId }) => {
    const cart = await cartRepository.ensureCart(userId);
    for (const item of cart.items) {
        if (sellerId) {
            if (String(item.sellerId) === String(sellerId)) item.selected = Boolean(selected);
        } else {
            item.selected = Boolean(selected);
        }
    }
    await cartRepository.save(cart);
    return cartView(cart, { userId });
};

export {
    getCartView,
    addItemToCart,
    updateCartItem,
    removeCartItem,
    clearCart,
    setSelection,
    cartView,
    resolveVoucher
};