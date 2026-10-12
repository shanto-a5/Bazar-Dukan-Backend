/**
 * Order status derivation (core port).
 *
 * Mirrors `shared/order-status.ts` exactly: same SELLER_STATUS_RANK values,
 * same RETURN_OPEN/RETURN_CLOSED, same logic for deriveOrderStatus and
 * allPartsDelivered (including the bottleneck and the "returned implies
 * delivered" semantics). No behavioural changes.
 *
 * Ported from TypeScript (ESM). No runtime dependencies, pure functions.
 */

export const SELLER_STATUS_RANK = Object.freeze({
	placed: 0,
	new: 0,
	confirmed: 1,
	processing: 2,
	packed: 3,
	ready_to_ship: 4,
	shipped: 5,
	out_for_delivery: 6,
	delivered: 7,
	return_requested: 8,
	return_approved: 9,
	partially_returned: 10,
	returned: 11,
	refunded: 12
});

// The seller-driven fulfilment sequence, in order. Mirrors
// `shared/order-status.ts`; the advance endpoint and the app's seller screens
// must walk the same list or one side dead-ends on an unknown step.
export const SELLER_FULFILLMENT_FLOW = Object.freeze([
	'new',
	'confirmed',
	'processing',
	'packed',
	'ready_to_ship',
	'shipped',
	'out_for_delivery',
	'delivered'
]);

export const RETURN_OPEN = Object.freeze(['return_requested', 'return_approved']);
export const RETURN_CLOSED = Object.freeze(['partially_returned', 'returned', 'refunded']);

export function deriveOrderStatus(sellerOrders) {
	if (!sellerOrders || sellerOrders.length === 0) return 'placed';
	if (sellerOrders.every((sellerOrder) => sellerOrder.status === 'cancelled')) return 'cancelled';
	const live = sellerOrders.filter((sellerOrder) => sellerOrder.status !== 'cancelled');
	if (live.length === 0) return 'cancelled';

	const isReturnStatus = (status) =>
		RETURN_OPEN.includes(status) || RETURN_CLOSED.includes(status);

	const fulfilment = live.filter((sellerOrder) => !isReturnStatus(sellerOrder.status));

	const inFlight = fulfilment.filter((sellerOrder) => {
		const rank = SELLER_STATUS_RANK[sellerOrder.status] ?? 0;
		return rank >= 0 && rank <= 6;
	});
	if (inFlight.length > 0) {
		const least = inFlight.reduce((min, entry) =>
			(SELLER_STATUS_RANK[entry.status] ?? 0) < (SELLER_STATUS_RANK[min.status] ?? 0) ? entry : min
		);
		const rank = SELLER_STATUS_RANK[least.status] ?? 0;
		return rank <= 0 ? 'placed' : least.status;
	}

	const returning = live.filter((sellerOrder) => isReturnStatus(sellerOrder.status));
	if (returning.length > 0) {
		const highest = returning.reduce((max, entry) =>
			(SELLER_STATUS_RANK[entry.status] ?? 0) > (SELLER_STATUS_RANK[max.status] ?? 0) ? entry : max
		);
		return highest.status;
	}

	return 'delivered';
}

export function allPartsDelivered(sellerOrders) {
	const live = sellerOrders.filter((sellerOrder) => sellerOrder.status !== 'cancelled');
	if (live.length === 0) return false;
	return live.every((sellerOrder) => (SELLER_STATUS_RANK[sellerOrder.status] ?? 0) >= SELLER_STATUS_RANK.delivered);
}
