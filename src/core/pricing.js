/**
 * Cart grouping + checkout total arithmetic (core port).
 *
 * Mirrors `shared/pricing.ts` exactly: same formulas, same rounding points,
 * same short-circuits. Every money value passes through roundMoney at the
 * same steps. Preserves the last-group remainder-absorption behavior implied
 * by the rounding calls (no re-derivation).
 *
 * Ported from TypeScript (ESM). Depends on ./money.js. Pure functions.
 */

import { roundMoney } from './money.js';

const FREE_SHIPPING_BELOW_FEE = 0;

export function lineSubtotal(unitPrice, quantity) {
	return roundMoney(unitPrice * quantity);
}

export function shippingFeeForGroup(store, selectedSubtotal, hasSelectedLines) {
	if (!hasSelectedLines) return FREE_SHIPPING_BELOW_FEE;
	return isGroupFreeShipping(store, selectedSubtotal) ? FREE_SHIPPING_BELOW_FEE : store.shippingFee;
}

export function isGroupFreeShipping(store, selectedSubtotal) {
	return selectedSubtotal >= store.freeShippingThreshold || store.shippingFee === 0;
}

export function groupLinesBySeller(lines, unitPriceOf, storeOf) {
	const bySeller = new Map();
	for (const line of lines) {
		const group = bySeller.get(line.sellerId);
		if (group) {
			group.push(line);
		} else {
			bySeller.set(line.sellerId, [line]);
		}
	}

	const groups = [];
	for (const [sellerId, sellerLines] of bySeller) {
		const store = storeOf(sellerId);
		if (!store) continue;
		const selectedLines = sellerLines.filter((line) => line.selected);
		const subtotal = roundMoney(
			selectedLines.reduce((sum, line) => sum + lineSubtotal(unitPriceOf(line), line.quantity), 0)
		);
		groups.push({
			sellerId,
			subtotal,
			shippingFee: shippingFeeForGroup(store, subtotal, selectedLines.length > 0),
			freeShipping: isGroupFreeShipping(store, subtotal)
		});
	}
	return groups;
}

export function computeVoucherDiscount(voucher, groups, subtotal, shippingTotal) {
	if (!voucher) return 0;
	let voucherDiscount = 0;
	if (voucher.type === 'free_shipping') {
		voucherDiscount =
			voucher.scope === 'seller' && voucher.sellerId
				? roundMoney(
					groups
						.filter((g) => g.sellerId === voucher.sellerId)
						.reduce((sum, g) => sum + g.shippingFee, 0)
				)
				: shippingTotal;
	} else if (voucher.type === 'percentage') {
		let base = subtotal;
		if (voucher.scope === 'seller' && voucher.sellerId) {
			base = groups
				.filter((g) => g.sellerId === voucher.sellerId)
				.reduce((sum, g) => sum + g.subtotal, 0);
		}
		const raw = roundMoney((base * voucher.discountValue) / 100);
		voucherDiscount = Math.min(raw, voucher.maximumDiscount ?? Infinity);
	} else {
		let base = subtotal;
		if (voucher.scope === 'seller' && voucher.sellerId) {
			base = groups
				.filter((g) => g.sellerId === voucher.sellerId)
				.reduce((sum, g) => sum + g.subtotal, 0);
		}
		voucherDiscount = Math.min(voucher.discountValue, base);
	}
	return roundMoney(voucherDiscount);
}

export function computeCartTotals(groups, voucher, itemCount) {
	const subtotal = roundMoney(groups.reduce((sum, group) => sum + group.subtotal, 0));
	const shippingTotal = roundMoney(groups.reduce((sum, group) => sum + group.shippingFee, 0));
	const voucherDiscount = computeVoucherDiscount(voucher, groups, subtotal, shippingTotal);
	const grandTotal = roundMoney(subtotal + shippingTotal - voucherDiscount);
	return { subtotal, shippingTotal, voucherDiscount, grandTotal, itemCount };
}

export function countSelectedItems(lines) {
	return lines.filter((line) => line.selected).reduce((sum, line) => sum + line.quantity, 0);
}
