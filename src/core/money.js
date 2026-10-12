/**
 * Money primitives shared by the Express backend (core port).
 *
 * Mirrors `shared/money.ts` exactly: every money value is a 2-decimal number,
 * rounded with the same helper so totals computed here cannot disagree by a cent.
 *
 * Ported from TypeScript (ESM). No runtime dependencies, pure functions.
 */

export function roundMoney(value) {
	return Math.round(value * 100) / 100;
}

export function sumMoney(values) {
	return values.reduce((total, value) => total + value, 0);
}
