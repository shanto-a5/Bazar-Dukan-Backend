# M12 Backend Audit + Parity Matrix

> **M13 update.** The matrix below records the pre-M12 start state and the M12
> target scope; the `MISSING` entries there describe where the audit began, not
> where the backend is today. M13 closed the deferred account/engagement gaps —
> wishlist, address book, recently viewed, store follows, seller media — so the
> Customer/media rows below are implemented and tested; the live endpoint and
> model reference is the package `README.md` (§4, §5). Search history stays
> device-local by contract; promotions remain unimplemented.

> **M19 update (remote-only).** The Expo client's on-device "local simulator"
> and its `EXPO_PUBLIC_API_MODE` switch have been removed. The app is now
> remote-only and the API is the single source of truth, so the parity matrix
> below is no longer "backend must catch up to the simulator" — it records the
> historical audit. References to "the simulator", `isRemoteMode()` and local
> mode describe the pre-M19 client and are kept for provenance only; the live
> endpoint and model reference is the package `README.md` (§4, §5).

Status legend: **COMPLETE** / **PARTIAL** / **MISSING** / **NEEDS TESTING**

Sources of truth:
- Specification = the frozen local simulator (`../src/services/*`, `../src/repositories/local/*`, `../shared/*.ts`, `../src/domain/types/*`). **Removed in M19** — retained here only as the historical parity source.
- Reference implementation (never modified) = `../backend/` (TypeScript, M10/M11 era: mongo models, services, contract harness, `m10-money` / `m11-returns` tests).
- This backend = `new_backend/` (JavaScript ESM, Express 5, Mongoose 9).

---

## 3. Internal inventory of `new_backend/` (as audited at M12 start)

| Area | State |
|---|---|
| Models | 3 only: `User`, `Session`, `PasswordReset` (src/models) |
| Repositories | `user`, `session`, `password-reset` (src/repositories) |
| Services | `auth.service.js`, `mailer.js` + `mail/console.provider.js`, `mail/resend.provider.js` |
| Controllers | `user.controller.js` (9 auth handlers), `health.controller.js` |
| Routes | `user.route.js` → `/api/v1/auth/*` (9), `health.route.js` → `/api/v1/health*` (2) |
| Middleware | `requestId`, `authenticate` (bearer-first, cookie fallback), CORS, body parsers (16kb), `notFoundHandler`, `errorHandler` |
| Authorization | **None.** No role middleware; `roles` exist only as User data |
| Validation | Hand-rolled synchronous validators (`validators/auth.validator.js`), single 422 with all fields, `SERVER_ONLY_FIELDS` rejection |
| Sessions | Opaque 64-hex token, sha256 at rest, TTL index, cap+eviction, server-side revocation, cookie `accessToken` |
| Mail | `auth.service → sendMail() → provider (console|resend)`, boot-time `assertMailConfig()` |
| Tests | `auth.test.js` (49), `mail.test.js` (13) — real MongoDB (Atlas `UP`, dbs `vanta_test`/`vanta_mail_test`), `node --test` |
| Config | `.env` / `.env.production` / `.gitignore` verified: secrets ignored, `MAIL_PROVIDER` console=resend split |
| Missing entirely | store, category, product, variant, media, inventory, address, cart, wishlist, voucher, order, return/refund, review, notification, seller, rate limiting, pagination helper |

---

## 4. Parity matrix

### Identity
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| users | `auth-service.ts`, local users repo | `user.model.js` + `auth.service.js` | COMPLETE | bcrypt cost 12 (sim uses sha256×12 — password formats are independent per system) |
| sessions | 30-day session, `auth-service.ts:10` | `session.model.js`, TTL, cap 10 | COMPLETE | Backend is stronger (hashed tokens, server-side revoke) |
| roles | `Role = customer\|seller` (`user.ts:3`) | `roles[]` enum `customer\|seller\|seller_approver` | PARTIAL | Enum exists; no role middleware yet (M12 adds `requireRole`/`requireSeller`) |
| seller status | `SellerStatus = pending\|active\|rejected\|suspended` (`catalog.ts:63`) | — | MISSING | Local simulator self-activates; backend keeps application→approval flow |
| seller ownership | `sellerId` on product/store/order | — | MISSING | Server must derive seller from authenticated identity, never from body |

### Marketplace
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| stores | `seller-service.ts` create defaults (fee 60, threshold 999, 2–4 days) | — | MISSING | |
| products | `catalog-service.ts` (validate/status/query) | — | MISSING | |
| product variants | `ProductVariant` (`catalog.ts:19-27`) | — | MISSING | Variant price is the unit price; aggregate stock = Σ variants |
| categories | tree `parentId`+`order` | — | MISSING | |
| product media | images[] + `p:` placeholder scheme | — (orphaned cloudinary/multer utils) | MISSING | Media URLs only; no upload pipeline in M12 scope |
| availability | `customerVisibility`/`lineAvailability` (`catalog-rules.ts:31-112`) | — | MISSING | visibility = product active + store active + seller active |

### Inventory
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| stock | `product.stock` denormalized, variants | — | MISSING | No reservation at add-to-cart; decrement at order creation only |
| adjustments | `adjustStock` clamp ≥0, `InventoryAdjustment` ledger | — | MISSING | |
| low/out of stock | `stockLevelOf`, crossing notifications | — | MISSING | |
| out-of-stock behavior | auto `statusFor` → `out_of_stock`, restore on restock | — | MISSING | |

### Customer
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| addresses | `Address` on order + address book | — | MISSING | |
| cart | `cart-service.ts` per-user, selected lines | — | MISSING | |
| wishlist / recently viewed / follows | local services | — | MISSING | Not in M12 minimum scope; tracked as later |

### Checkout
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| delivery methods | `shared/delivery.ts` standard/express (premium 40/seller) | — | MISSING | |
| payment methods | cod/bkash/nagad/card; online=paid at placement | — | MISSING | Simulated only (no gateway) |
| vouchers at checkout | `evaluateVoucherQuotes` + `computeVoucherDiscount` | — | MISSING | |
| shipping | per-store fee, threshold-free-shipping, per-seller | — | MISSING | |
| seller splitting | `groupLinesBySeller` | — | MISSING | |
| totals | `computeCartTotals`+`checkoutTotals` (server-authoritative) | — | MISSING | Client numbers are advisory only |
| stock validation | soft pre-check + hard re-check, abort (no clamp) | — | MISSING | |
| idempotency | 45s submission fingerprint | — | MISSING | |

### Orders
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| orders / seller orders / lines | `commerce.ts:86-175` snapshots | — | MISSING | Price/variant/shipping/voucher snapshots are immutable history |
| status | `shared/order-status.ts` rank + bottleneck roll-up | — | MISSING | Return states stripped before bottleneck; `allPartsDelivered` gates COD |
| fulfillment | seller `ADVANCE_FLOW` new→…→delivered | — | MISSING | Seller-owned only |
| cancellation | customer-only, from new/confirmed/processing, restock | — | MISSING | |
| delivery | carrier/tracking on shipped; deliveredAt on first arrival | — | MISSING | |

### Returns / refunds
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| return request | item-level, delivered/partially_returned, 1 open request/line | — | MISSING | No time window enforced (matches simulator) |
| approval/rejection | pending-only decision, item-first ordering | — | MISSING | |
| returned quantity | `returnedQuantity`/`remainingQuantity` accumulation | — | MISSING | Partial ≠ full-line |
| restock | +qty to variant/product, ledger, out_of_stock→active | — | MISSING | |
| refund | `round(unitPrice × qty)` gross, clamped to `amount − refundedAmount` | — | MISSING | Single payment per order = shared refund headroom (simulator behavior) |
| settlement / totals | `sellerRefundEvents`, `orderMoneySummary`, `sellerOrderMoneySummary` | — | MISSING | |
| idempotency | decide pending-only, markReturned approved-only, refund clamp | — | MISSING | |

### Reviews
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| product/store reviews | `review-service.ts`, one per order line | — | MISSING | Store reviews = reviews by sellerId |
| eligibility | delivered only, owner check | — | MISSING | |
| ownership | edit/delete owner-only; seller reply-only | — | MISSING | |
| aggregation | raw mean, distribution, store counters | — | MISSING | |
| seller inbox | filters + reply | — | MISSING | |

### Notifications
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| events | 17 emission sites (order/return/seller/review) | — | MISSING | 16 types; `promotion/voucher/review_reminder` unemitted |
| read state | per-user list, unread count, mark read/remove | — | MISSING | |

### Seller
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| application/status | becomeSeller (local: immediate active; remote: pending review) | — | MISSING | Backend = remote semantics: `pending` until `seller_approver` approves |
| profile/store settings | seller profile + store editable fields | — | MISSING | |
| catalog/inventory/orders/returns/analytics | seller screens over services | — | MISSING | analytics deferred after core parity |
| isolation | ownership checks everywhere | — | MISSING | Server-side identity resolution is the security model |

### Vouchers
| Capability | Simulator | Backend | Status | Notes |
|---|---|---|---|---|
| creation/validation | `voucher-service.ts:276-356` (code pattern, unique, caps) | — | MISSING | |
| activation/expiry/usage | active+window, usageLimit, perUserLimit | — | MISSING | |
| seller-scoped | eligibility + scoped base for discount | — | MISSING | |
| free shipping | waives base fees only, never express premium | — | MISSING | |
| discount math | percentage/fixed with min(base) caps, rounded | — | MISSING | |
| allocation | pro-rata by subtotal (or shipping for free_shipping), last group absorbs remainder | — | MISSING | |

---

## M12 target scope (this milestone)

Phases A→J: catalog data, seller foundation, public browsing, cart, checkout (server-authoritative), orders (+lifecycle), returns/refunds, vouchers, reviews, notifications — each with tests, seller-isolation security checks, and the auth/mail suites staying green.
