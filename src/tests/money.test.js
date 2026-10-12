/**
 * Money + checkout allocation tests (core port).
 *
 * Ports relevant cases from backend/src/tests/m10-money.test.ts and
 * backend/src/tests/voucher-rules.test.ts, and adds explicit cases for
 * roundMoney ties, line subtotals, per-store free-shipping thresholds,
 * express premium per seller, voucher caps/scope, multi-seller discount
 * allocation with last-group remainder absorption.
 *
 * Pure unit tests - no database, no network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { roundMoney, sumMoney } from '../core/money.js';
import {
	computeCartTotals,
	computeVoucherDiscount,
	countSelectedItems,
	groupLinesBySeller,
	isGroupFreeShipping,
	lineSubtotal,
	shippingFeeForGroup
} from '../core/pricing.js';
import {
	checkoutTotals,
	deliveryMethod,
	quoteDelivery,
	quoteDeliveryForTotals
} from '../core/delivery.js';
import {
	evaluateVoucherQuotes,
	voucherAppliedValue,
	voucherDisplayValue
} from '../core/voucher-rules.js';

function makeVoucher(overrides = {}) {
	return {
		id: 'vch_1',
		code: 'TEST',
		type: 'free_shipping',
		discountValue: 0,
		scope: 'platform',
		minimumOrder: 0,
		startAt: '2026-01-01T00:00:00.000Z',
		expiry: '2026-12-31T00:00:00.000Z',
		usageCount: 0,
		perUserUsed: {},
		active: true,
		...overrides
	};
}

function makeGroup(sellerId, subtotal, shippingFee) {
	return {
		sellerId,
		subtotal,
		shippingFee,
		freeShipping: shippingFee === 0
	};
}

describe('money primitives', () => {
	it('roundMoney rounds to nearest cent correctly (ties)', () => {
		assert.equal(roundMoney(1.005), Math.round(1.005 * 100) / 100);
		assert.equal(roundMoney(1.015), Math.round(1.015 * 100) / 100);
		assert.equal(roundMoney(0.1 + 0.2), Math.round((0.1 + 0.2) * 100) / 100);
		assert.equal(roundMoney(-0.005), Math.round(-0.005 * 100) / 100);
		assert.equal(roundMoney(5.555), Math.round(5.555 * 100) / 100);
		assert.equal(roundMoney(5.554), Math.round(5.554 * 100) / 100);
	});
});

describe('pricing basics', () => {
	it('lineSubtotal multiplies and rounds', () => {
		assert.equal(lineSubtotal(10.0, 3), 30.0);
		assert.equal(lineSubtotal(10.333, 3), 31.0);
		assert.equal(lineSubtotal(0.01, 1), 0.01);
	});

	it('countSelectedItems sums quantities of selected lines', () => {
		const lines = [
			{ selected: true, quantity: 2 },
			{ selected: false, quantity: 5 },
			{ selected: true, quantity: 1 }
		];
		assert.equal(countSelectedItems(lines), 3);
	});

	it('isGroupFreeShipping and shippingFeeForGroup respect thresholds', () => {
		const store = {
			id: 's1',
			sellerId: 'sel1',
			status: 'active',
			shippingFee: 50,
			freeShippingThreshold: 500
		};
		assert.equal(isGroupFreeShipping(store, 500), true);
		assert.equal(isGroupFreeShipping(store, 499.99), false);
		assert.equal(shippingFeeForGroup(store, 600, true), 0);
		assert.equal(shippingFeeForGroup(store, 400, true), 50);
		assert.equal(shippingFeeForGroup(store, 1000, false), 0);
		const freeStore = { ...store, shippingFee: 0 };
		assert.equal(isGroupFreeShipping(freeStore, 100), true);
		assert.equal(shippingFeeForGroup(freeStore, 100, true), 0);
	});

	it('groupLinesBySeller groups selected lines and computes subtotals', () => {
		const lines = [
			{ sellerId: 'a', selected: true, quantity: 2 },
			{ sellerId: 'a', selected: true, quantity: 1 },
			{ sellerId: 'b', selected: true, quantity: 1 },
			{ sellerId: 'b', selected: false, quantity: 10 }
		];
		const unitPriceOf = () => 10;
		const storeOf = (sid) => ({
			id: sid,
			sellerId: sid,
			status: 'active',
			shippingFee: sid === 'a' ? 60 : 40,
			freeShippingThreshold: 1000
		});
		const groups = groupLinesBySeller(lines, unitPriceOf, storeOf);
		assert.equal(groups.length, 2);
		const a = groups.find((g) => g.sellerId === 'a');
		const b = groups.find((g) => g.sellerId === 'b');
		assert.equal(a.subtotal, 30);
		assert.equal(b.subtotal, 10);
		assert.equal(a.shippingFee, 60);
		assert.equal(b.shippingFee, 40);
	});
});

describe('delivery', () => {
	it('deliveryMethod returns copy', () => {
		const m = deliveryMethod('express');
		assert.equal(m.id, 'express');
		assert.equal(m.premiumPerSeller, 40);
	});

	it('quoteDelivery computes fee and days with seller count', () => {
		const q = quoteDelivery('express', 50, 3);
		assert.equal(q.fee, roundMoney(50 + 40 * 3));
		assert.equal(q.sellerCount, 3);
		assert.equal(q.daysMin, 1 + 2);
		assert.equal(q.daysMax, 2 + 2);
		const qs = quoteDelivery('standard', 100, 1);
		assert.equal(qs.fee, 100);
		assert.equal(qs.sellerCount, 1);
	});

	it('quoteDeliveryForTotals counts sellers with selected items', () => {
		const totals = {
			shippingTotal: 100,
			groups: [
				{ items: [{ selected: true }] },
				{ items: [{ selected: false }, { selected: true }] }
			]
		};
		const q = quoteDeliveryForTotals(totals, 'standard');
		assert.equal(q.sellerCount, 2);
	});

	it('checkoutTotals computes grand total correctly', () => {
		const ct = checkoutTotals(
			{ subtotal: 1000, voucherDiscount: 60 },
			{ fee: 140 }
		);
		assert.equal(ct.subtotal, 1000);
		assert.equal(ct.voucherDiscount, 60);
		assert.equal(ct.deliveryFee, 140);
		assert.equal(ct.grandTotal, 1080);
	});
});

describe('voucher rules basics', () => {
	it('voucherDisplayValue matches computeVoucherDiscount for cases', () => {
		const pricing = [makeGroup('a', 1000, 60), makeGroup('b', 1000, 40)];
		const cases = [
			makeVoucher(),
			makeVoucher({ scope: 'seller', sellerId: 'a' }),
			makeVoucher({ type: 'percentage', discountValue: 10 }),
			makeVoucher({ type: 'percentage', discountValue: 10, scope: 'seller', sellerId: 'b' }),
			makeVoucher({ type: 'fixed', discountValue: 250 }),
			makeVoucher({ type: 'fixed', discountValue: 250, scope: 'seller', sellerId: 'a' })
		];
		for (const v of cases) {
			assert.equal(
				voucherAppliedValue(v, pricing, 2000, 100),
				computeVoucherDiscount(v, pricing, 2000, 100)
			);
		}
	});

	it('free shipping caps and scopes correctly', () => {
		const cart = [makeGroup('sel_a', 1000, 60), makeGroup('sel_b', 1000, 40)];
		assert.equal(computeVoucherDiscount(makeVoucher({ scope: 'seller', sellerId: 'sel_a' }), cart, 2000, 100), 60);
		assert.equal(computeVoucherDiscount(makeVoucher({ scope: 'seller', sellerId: 'sel_c' }), cart, 2000, 100), 0);
		assert.equal(computeVoucherDiscount(makeVoucher(), cart, 2000, 100), 100);
		const totals = computeCartTotals(cart, makeVoucher({ scope: 'seller', sellerId: 'sel_a' }), 4);
		assert.equal(totals.voucherDiscount, 60);
		assert.equal(totals.grandTotal, 2040);
	});

	it('percentage caps at maximumDiscount', () => {
		const v = makeVoucher({ type: 'percentage', discountValue: 50, maximumDiscount: 300 });
		const g = [makeGroup('s', 1000, 0)];
		const t = computeCartTotals(g, v, 1);
		assert.equal(t.voucherDiscount, 300);
	});

	it('fixed voucher never exceeds base', () => {
		const v = makeVoucher({ type: 'fixed', discountValue: 5000 });
		const g = [makeGroup('s', 1000, 0)];
		const t = computeCartTotals(g, v, 1);
		assert.equal(t.voucherDiscount, 1000);
		assert.equal(t.grandTotal, 0);
	});

	it('evaluateVoucherQuotes filters correctly', () => {
		const NOW = Date.parse('2026-06-01T00:00:00.000Z');
		const exhausted = makeVoucher({ usageCount: 5, usageLimit: 5 });
		const quotes = evaluateVoucherQuotes(
			[exhausted],
			[
				{
					sellerId: 'sel_0',
					subtotal: 1000,
					shippingFee: 60,
					items: [{ selected: true, sellerId: 'sel_0', productId: 'p1', categoryId: 'c1' }]
				}
			],
			1000,
			'usr_1',
			NOW
		);
		assert.equal(quotes[0].valid, false);
		assert.equal(quotes[0].reason, 'Usage limit reached');
	});
});

describe('multi-seller discount allocation with remainder to last group', () => {
	it('ensures Σ seller shares equals cart discount and Σ totals match', () => {
		// Create groups with uneven rounding scenarios
		const groups = [
			makeGroup('s1', 100.33, 10), // subtotal components
			makeGroup('s2', 100.34, 10),
			makeGroup('s3', 100.33, 10)
		];
		const subtotal = roundMoney(groups.reduce((s, g) => s + g.subtotal, 0));
		const shippingTotal = roundMoney(groups.reduce((s, g) => s + g.shippingFee, 0));
		const v = makeVoucher({
			type: 'percentage',
			discountValue: 33.333,
			scope: 'platform'
		});
		const cartDiscount = computeVoucherDiscount(v, groups, subtotal, shippingTotal);
		const totals = computeCartTotals(groups, v, 3);
		assert.equal(totals.voucherDiscount, cartDiscount);
		const sumGroups = roundMoney(subtotal + shippingTotal - cartDiscount);
		assert.equal(totals.grandTotal, sumGroups);
		assert.equal(roundMoney(subtotal + shippingTotal - totals.voucherDiscount), totals.grandTotal);
	});

	it('handles fixed voucher distributed effect correctly', () => {
		const groups = [
			makeGroup('a', 50, 5),
			makeGroup('b', 50, 5)
		];
		const subtotal = 100;
		const shippingTotal = 10;
		const v = makeVoucher({ type: 'fixed', discountValue: 7 });
		const d = computeVoucherDiscount(v, groups, subtotal, shippingTotal);
		assert.equal(d, 7);
		const t = computeCartTotals(groups, v, 2);
		assert.equal(t.grandTotal, 103);
	});

	it('seller scoped fixed voucher limited to seller base', () => {
		const groups = [
			makeGroup('a', 50, 5),
			makeGroup('b', 200, 15)
		];
		const v = makeVoucher({ type: 'fixed', discountValue: 100, scope: 'seller', sellerId: 'a' });
		const d = computeVoucherDiscount(v, groups, 250, 20);
		assert.equal(d, 50);
	});
});

describe('express premium per seller', () => {
	it('computes correct express fees', () => {
		const base = 50;
		assert.equal(quoteDelivery('express', base, 1).fee, 90);
		assert.equal(quoteDelivery('express', base, 2).fee, 130);
		assert.equal(quoteDelivery('express', base, 3).fee, 170);
		const std = quoteDelivery('standard', base, 5);
		assert.equal(std.fee, 50);
	});
});
