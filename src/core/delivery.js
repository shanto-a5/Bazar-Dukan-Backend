/**
 * Delivery method + quote rules (core port).
 *
 * Mirrors `shared/delivery.ts` exactly: same methods, same quotes, same rounding.
 * Express premium is 40 per seller as in TS source; days adjusted per seller count.
 *
 * Ported from TypeScript (ESM). Depends on ./money.js. Pure functions.
 */

import { roundMoney } from './money.js';

export const DELIVERY_METHODS = Object.freeze([
	{
		id: 'standard',
		label: 'Standard delivery',
		caption: 'Store dispatch with tracking',
		premiumPerSeller: 0,
		daysMin: 2,
		daysMax: 5
	},
	{
		id: 'express',
		label: 'Express delivery',
		caption: 'Priority handling for faster arrival',
		premiumPerSeller: 40,
		daysMin: 1,
		daysMax: 2
	}
]);

export const DEFAULT_DELIVERY_METHOD = 'standard';

export function isDeliveryMethod(value) {
	return typeof value === 'string' && DELIVERY_METHODS.some((option) => option.id === value);
}

export function deliveryMethod(id) {
	const found = DELIVERY_METHODS.find((option) => option.id === id);
	return found ? { ...found } : { ...DELIVERY_METHODS[0] };
}

export function deliveryMethods() {
	return DELIVERY_METHODS.map((option) => ({ ...option }));
}

export function quoteDelivery(id, baseFee, sellerCount) {
	const method = DELIVERY_METHODS.find((option) => option.id === id) ?? DELIVERY_METHODS[0];
	const sellers = Math.max(1, sellerCount);
	const extraDays = sellers - 1;
	const daysMin = method.daysMin + extraDays;
	const daysMax = method.daysMax + extraDays;
	return {
		methodId: method.id,
		label: method.label,
		caption: method.caption,
		baseFee: roundMoney(baseFee),
		premiumPerSeller: method.premiumPerSeller,
		fee: roundMoney(baseFee + method.premiumPerSeller * sellers),
		sellerCount: sellers,
		daysMin,
		daysMax,
		window: `${daysMin}–${daysMax} working days`
	};
}

export function quoteDeliveryForTotals(totals, id) {
	const sellerCount = totals.groups.filter((group) => group.items.some((line) => line.selected)).length;
	return quoteDelivery(id, totals.shippingTotal, sellerCount);
}

export function checkoutTotals(totals, quote) {
	const subtotal = roundMoney(totals.subtotal);
	const voucherDiscount = roundMoney(totals.voucherDiscount);
	const deliveryFee = roundMoney(quote.fee);
	return {
		subtotal,
		voucherDiscount,
		deliveryFee,
		grandTotal: roundMoney(subtotal + deliveryFee - voucherDiscount)
	};
}
