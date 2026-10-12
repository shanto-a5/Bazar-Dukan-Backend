/**
 * Catalog availability + customer visibility rules (core port).
 *
 * Mirrors `shared/catalog-rules.ts` exactly, including injected lookups design.
 * Same function names, same messages, same logic for effective price, stock,
 * visibility, and line availability.
 *
 * Ported from TypeScript (ESM). No runtime dependencies, pure functions.
 */

export function effectivePrice(product) {
	return product.salePrice && product.salePrice < product.regularPrice ? product.salePrice : product.regularPrice;
}

export function productStock(product) {
	if (product.hasVariants && product.variants.length > 0) {
		return product.variants.reduce((sum, variant) => sum + variant.stock, 0);
	}
	return product.stock;
}

export function productIsAvailable(product) {
	return product.status === 'active' && productStock(product) > 0;
}

export function customerVisibility(product, lookups) {
	if (product.status !== 'active') return { visible: false, blocker: 'not_listed' };
	const store = lookups.getStoreById(product.storeId) ?? lookups.getStoreBySellerId(product.sellerId);
	if (!store) return { visible: false, blocker: 'store_missing' };
	if (store.status !== 'active') return { visible: false, blocker: 'store_paused' };
	const seller = lookups.getSellerById(product.sellerId);
	if (!seller) return { visible: false, blocker: 'seller_missing' };
	if (seller.status !== 'active') return { visible: false, blocker: 'seller_suspended' };
	return { visible: true };
}

export function productIsVisibleToCustomer(product, lookups) {
	return customerVisibility(product, lookups).visible;
}

export const VISIBILITY_MESSAGES = Object.freeze({
	not_listed: 'This listing is not available right now.',
	store_missing: 'The store for this listing is no longer available.',
	store_paused: 'This store is paused, so this item cannot be ordered right now.',
	seller_missing: 'The seller for this listing is no longer available.',
	seller_suspended: 'This seller account is suspended, so this item cannot be ordered right now.'
});

export function stockLevelOf(product) {
	const stock = productStock(product);
	if (stock <= 0) return 'out';
	if (stock <= product.lowStockThreshold) return 'low';
	return 'healthy';
}

export function lineAvailability(product, variant, quantity, lookups) {
	const visibility = customerVisibility(product, lookups);
	if (!visibility.visible) {
		return { available: false, reason: VISIBILITY_MESSAGES[visibility.blocker ?? 'not_listed'] };
	}
	if (product.hasVariants && !variant) {
		return { available: false, reason: `One of the options for "${product.name}" is no longer available.` };
	}
	const stock = variant ? variant.stock : productStock(product);
	if (stock <= 0) {
		return { available: false, reason: `"${product.name}" does not have enough stock right now.` };
	}
	if (stock < quantity) {
		return {
			available: false,
			reason: `"${product.name}" does not have enough stock — only ${stock} left.`
		};
	}
	return { available: true, reason: null };
}
