/**
 * Structural contracts for the shared commerce core (core port).
 *
 * Mirrors `shared/types.ts` exactly. These are minimal structural views
 * (enums/unions represented as string literals conceptually; implemented as
 * constants/typedef semantics not needed in JS). Only what the other core
 * files reference is represented here for clarity (not exhaustive).
 *
 * Ported from TypeScript (ESM). No runtime dependencies.
 */

export const ORDER_STATUS = Object.freeze([
	'placed',
	'new',
	'confirmed',
	'processing',
	'packed',
	'ready_to_ship',
	'shipped',
	'out_for_delivery',
	'delivered',
	'cancelled',
	'return_requested',
	'return_approved',
	'partially_returned',
	'returned',
	'refunded'
]);

export const VOUCHER_TYPE = Object.freeze(['percentage', 'fixed', 'free_shipping']);

export const VOUCHER_SCOPE = Object.freeze(['platform', 'seller']);
