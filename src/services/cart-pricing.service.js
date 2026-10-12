import { Product } from "../models/product.model.js";
import { Store } from "../models/store.model.js";
import { SellerProfile } from "../models/seller-profile.model.js";
import { effectivePrice, lineAvailability } from "../core/catalog-rules.js";
import { groupLinesBySeller, computeCartTotals, countSelectedItems, lineSubtotal } from "../core/pricing.js";
import {
    quoteDeliveryForTotals,
    checkoutTotals,
    isDeliveryMethod,
    DEFAULT_DELIVERY_METHOD
} from "../core/delivery.js";
import { roundMoney } from "../core/money.js";

/**
 * Server-side cart pricing: resolves stored cart lines against the live
 * catalog and produces the seller groups + authoritative totals that the cart
 * screen, the voucher quotes and checkout all share.
 *
 * Mirrors the simulator's `src/services/pricing-service.ts` on top of the
 * ported rule core (`src/core/pricing.js`, `src/core/delivery.js`):
 *
 * - Prices are ALWAYS recomputed from the live catalog (variant price or
 *   effectivePrice); the stored `priceSnapshot` is diagnostic only and is
 *   surfaced as `priceChanged`.
 * - Lines whose product or store no longer exist are silently excluded from
 *   pricing (they are reported to the client as audit issues by the cart
 *   service, never repriced).
 * - Group subtotals, shipping fees and the voucher base use SELECTED lines
 *   only; unselected lines stay visible but contribute nothing.
 * - Two totals are exposed: `cartTotal` (subtotal + base shipping âˆ’ voucher,
 *   what the cart screen shows) and `grandTotal` (adds the delivery-method
 *   premium, what checkout charges).
 *
 * This module is the ONLY place that reads Product/Store/SellerProfile for
 * pricing purposes, so the cart, voucher and checkout services cannot drift
 * apart.
 */

/**
 * Builds the lookups object required by the shared catalog rules from a set of
 * raw documents, so availability checks never issue their own queries.
 */
const buildLookups = (storesById, storesBySellerId, sellersById) => {
    return {
        getStoreById: (id) => storesById.get(String(id)) ?? null,
        getStoreBySellerId: (sellerId) =>
            storesBySellerId.get(String(sellerId)) ?? storesById.get(String(sellerId)) ?? null,
        getSellerById: (id) => sellersById.get(String(id)) ?? null
    };
};

/**
 * Resolves raw cart items into seller groups with live prices and
 * availability.
 *
 * @param {Array} cartItems cart item documents (or plain objects with
 *        productId/variantId/quantity/selected/priceSnapshot).
 * @returns {Promise<Array>} groups in first-seen seller order:
 *          [{ sellerId, store, items[], subtotal, shippingFee, freeShipping,
 *             hasSelectedLines }]
 *          Each item: { itemId, productId, sellerId, storeId, categoryId,
 *          variantId, variantAttributes, quantity, selected, unitPrice,
 *          subtotal, priceChanged, available, unavailableReason, productName,
 *          brand, image, hasVariants, product, variant }.
 */
export async function resolveCartGroups(cartItems) {
    const items = Array.isArray(cartItems) ? cartItems : [];
    if (items.length === 0) return [];

    const productIds = [...new Set(items.map((item) => String(item.productId)))];
    const products = await Product.find({ _id: { $in: productIds } });
    const productsById = new Map(products.map((product) => [String(product._id), product]));

    const sellerIds = [...new Set(products.map((product) => String(product.sellerId)))];
    const storeIds = [...new Set(products.map((product) => String(product.storeId)))];
    const stores = await Store.find({ $or: [{ _id: { $in: storeIds } }, { sellerId: { $in: sellerIds } }] });
    const sellers = sellerIds.length > 0 ? await SellerProfile.find({ _id: { $in: sellerIds } }) : [];

    const storesById = new Map(stores.map((store) => [String(store._id), store]));
    const storesBySellerId = new Map(stores.map((store) => [String(store.sellerId), store]));
    const sellersById = new Map(sellers.map((seller) => [String(seller._id), seller]));
    const lookups = buildLookups(storesById, storesBySellerId, sellersById);

    const views = [];
    for (const item of items) {
        const product = productsById.get(String(item.productId));
        if (!product) continue;
        const store = storesById.get(String(product.storeId)) ?? storesBySellerId.get(String(product.sellerId));
        if (!store) continue;

        const variant = item.variantId
            ? product.variants.find((entry) => String(entry._id) === String(item.variantId))
            : undefined;
        const unitPrice = variant ? variant.price : effectivePrice(product);
        const availability = lineAvailability(product, variant ?? null, item.quantity, lookups);

        views.push({
            itemId: String(item._id ?? item.id ?? ""),
            productId: String(product._id),
            sellerId: String(product.sellerId),
            storeId: String(store._id),
            categoryId: product.subcategoryId ? String(product.subcategoryId) : String(product.categoryId),
            variantId: item.variantId ? String(item.variantId) : null,
            variantAttributes: variant?.attributes ?? null,
            quantity: item.quantity,
            selected: Boolean(item.selected),
            unitPrice,
            subtotal: lineSubtotal(unitPrice, item.quantity),
            priceChanged: roundMoney(unitPrice) !== roundMoney(item.priceSnapshot ?? unitPrice),
            available: availability.available,
            unavailableReason: availability.reason,
            productName: product.name,
            brand: product.brand,
            image: product.images?.[0] ?? "",
            hasVariants: Boolean(product.hasVariants),
            product,
            variant: variant ?? null
        });
    }

    const priced = groupLinesBySeller(
        views,
        (line) => line.unitPrice,
        (sellerId) => storesBySellerId.get(String(sellerId)) ?? storesById.get(String(sellerId)) ?? null
    );
    const pricingBySeller = new Map(priced.map((group) => [String(group.sellerId), group]));

    const bySeller = new Map();
    for (const view of views) {
        const bucket = bySeller.get(view.sellerId);
        if (bucket) bucket.push(view);
        else bySeller.set(view.sellerId, [view]);
    }

    const groups = [];
    for (const [sellerId, sellerLines] of bySeller) {
        const pricing = pricingBySeller.get(sellerId);
        if (!pricing) continue;
        const head = sellerLines[0];
        groups.push({
            sellerId,
            store: storesById.get(String(head.product.storeId)) ?? storesBySellerId.get(sellerId),
            items: sellerLines,
            subtotal: pricing.subtotal,
            shippingFee: pricing.shippingFee,
            freeShipping: pricing.freeShipping,
            hasSelectedLines: sellerLines.some((line) => line.selected)
        });
    }
    return groups;
}

/**
 * Authoritative totals for a set of resolved groups.
 *
 * @param {Array} groups output of resolveCartGroups
 * @param {object} options { voucher = null, deliveryMethod = 'standard' }
 * @returns {{ subtotal, shippingTotal, voucherDiscount, cartTotal,
 *             deliveryFee, grandTotal, itemCount, quote, groups }}
 *          - `cartTotal`  = subtotal + base shipping âˆ’ voucher (cart screen)
 *          - `grandTotal` = subtotal + delivery quote fee âˆ’ voucher (checkout)
 */
export function cartTotals(groups, { voucher = null, deliveryMethod } = {}) {
    const method = isDeliveryMethod(deliveryMethod) ? deliveryMethod : DEFAULT_DELIVERY_METHOD;
    const lines = groups.flatMap((group) => group.items);
    const base = computeCartTotals(groups, voucher, countSelectedItems(lines));
    const quote = quoteDeliveryForTotals({ groups, shippingTotal: base.shippingTotal }, method);
    const checkout = checkoutTotals({ subtotal: base.subtotal, voucherDiscount: base.voucherDiscount }, quote);

    return {
        groups,
        subtotal: base.subtotal,
        shippingTotal: base.shippingTotal,
        voucherDiscount: base.voucherDiscount,
        cartTotal: base.grandTotal,
        deliveryFee: checkout.deliveryFee,
        grandTotal: checkout.grandTotal,
        itemCount: base.itemCount,
        quote
    };
}
