/**
 * Voucher eligibility + discount rules (core port).
 *
 * Mirrors `shared/voucher-rules.ts` exactly: same checks (inactive/window skipped,
 * usage limit, per-user, seller scope, minimum order, category/product ids),
 * same ordering, same logic. voucherAppliedValue delegates to pricing core
 * (computeVoucherDiscount) as in TS source.
 *
 * Ported from TypeScript (ESM). Depends on ./money.js and ./pricing.js.
 */

import { computeVoucherDiscount } from './pricing.js';

function sellerSubtotalFor(groups, sellerId) {
	if (!sellerId) return 0;
	return groups.filter((group) => group.sellerId === sellerId).reduce((sum, group) => sum + group.subtotal, 0);
}

export function voucherDisplayValue(voucher, groups, subtotal) {
	if (voucher.type === 'free_shipping') {
		return groups.reduce((sum, group) => sum + group.shippingFee, 0);
	}
	const base = voucher.scope === 'seller' && voucher.sellerId ? sellerSubtotalFor(groups, voucher.sellerId) : subtotal;
	if (voucher.type === 'percentage') {
		const raw = (base * voucher.discountValue) / 100;
		return Math.min(raw, voucher.maximumDiscount ?? Infinity);
	}
	if (voucher.type === 'fixed') {
		return Math.min(voucher.discountValue, base);
	}
	return 0;
}

export function evaluateVoucherQuotes(vouchers, groups, subtotal, userId, now) {
	const selectedItems = groups.flatMap((group) => group.items.filter((item) => item.selected));
	const sellerIds = new Set(selectedItems.map((item) => item.sellerId));
	const categoryIds = new Set(selectedItems.map((item) => item.categoryId));
	const productIds = new Set(selectedItems.map((item) => item.productId));

	const pricingGroups = groups.map((group) => ({
		sellerId: group.sellerId,
		subtotal: group.subtotal,
		shippingFee: group.shippingFee ?? 0,
		freeShipping: (group.shippingFee ?? 0) === 0
	}));

	const quotes = [];
	for (const voucher of vouchers) {
		if (!voucher.active) continue;
		if (new Date(voucher.startAt).getTime() > now || new Date(voucher.expiry).getTime() < now) continue;
		if (voucher.usageLimit !== undefined && voucher.usageCount >= voucher.usageLimit) {
			quotes.push({ voucher, discount: 0, valid: false, reason: 'Usage limit reached' });
			continue;
		}
		if (voucher.perUserLimit !== undefined && userId) {
			const used = voucher.perUserUsed[userId] ?? 0;
			if (used >= voucher.perUserLimit) {
				quotes.push({ voucher, discount: 0, valid: false, reason: 'Already used' });
				continue;
			}
		}
		if (voucher.scope === 'seller' && voucher.sellerId && !sellerIds.has(voucher.sellerId)) {
			quotes.push({ voucher, discount: 0, valid: false, reason: 'Applies to a different seller' });
			continue;
		}
		if (voucher.scope === 'seller' && voucher.sellerId) {
			const sellerSubtotal = groups
				.filter((group) => group.sellerId === voucher.sellerId)
				.reduce((sum, group) => sum + group.subtotal, 0);
			if (sellerSubtotal < voucher.minimumOrder) {
				quotes.push({ voucher, discount: 0, valid: false, reason: `Minimum ${voucher.minimumOrder} required` });
				continue;
			}
		} else if (subtotal < voucher.minimumOrder) {
			quotes.push({ voucher, discount: 0, valid: false, reason: `Minimum ${voucher.minimumOrder} required` });
			continue;
		}
		if (voucher.categoryId && !categoryIds.has(voucher.categoryId)) {
			quotes.push({ voucher, discount: 0, valid: false, reason: 'Category not in cart' });
			continue;
		}
		if (voucher.productIds && voucher.productIds.length && !voucher.productIds.some((id) => productIds.has(id))) {
			quotes.push({ voucher, discount: 0, valid: false, reason: 'Product not in cart' });
			continue;
		}
		quotes.push({ voucher, discount: voucherDisplayValue(voucher, pricingGroups, subtotal), valid: true });
	}

	quotes.sort((a, b) => b.discount - a.discount);
	return quotes;
}

export function voucherAppliedValue(voucher, groups, subtotal, shippingTotal) {
	return computeVoucherDiscount(voucher, groups, subtotal, shippingTotal);
}
