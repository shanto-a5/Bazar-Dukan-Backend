# Vanta API — `new_backend/` (M12 + M13)

The M12 marketplace backend with the M13 gap-closure slices (wishlist, address
book, recently viewed, store follows, seller media): a JavaScript ESM package
built on Express 5 and Mongoose 9 that serves the Vanta API over MongoDB.

- Base path: `/api/v1` (every router in `src/app.js` mounts on that prefix)
- Success envelope: `{ ok: true, data, meta }`
- Error envelope: `{ ok: false, error: { code, message, fields? }, meta }`
- Auth: `Authorization: Bearer <token>` (opaque session token), roles
  `customer` / `seller` / `seller_approver`

---

## 1. Overview

### What this is

`new_backend/` is a standalone Node package (`ps6`, `"type": "module"`) that
implements the Vanta marketplace API: identity, catalogue, cart, server-
authoritative checkout, order lifecycle, returns and refunds, vouchers,
reviews, notifications, the seller/approver surfaces, plus the M13 account and
engagement slices (wishlist, address book, recently viewed, store follows) and
seller media upload. Stack:

| Layer | Choice |
| --- | --- |
| HTTP | Express `^5.2.1` (`src/app.js`) |
| Database | MongoDB via Mongoose `^9.9.1`, database name `UP` (`src/db/index.js`, `src/constance.js`) |
| Validation | hand-rolled synchronous validators in `src/validators/` |
| Auth | opaque bearer session tokens + `bcrypt` (`^6.0.0`) |
| Mail | `resend` (`^6.32.1`) behind a provider split (console / resend) |
| Tests | built-in `node:test` runner against a real MongoDB |

### Where this sits in the repository

| Tree | Role |
| --- | --- |
| `new_backend/` | This package — the M12 backend being documented. |
| `backend/` | The earlier TypeScript reference implementation. Read-only reference; never modified, never imported, not run by this package. |
| `src/` + `app/` (repo root) | The Expo frontend, including the frozen local simulator (`src/services/*`, `src/repositories/local/*`) that is the behavioural specification for this API. |
| `shared/` (repo root) | Data-free commerce rules shared by the app. This backend cannot import the TypeScript, so `shared/*` is ported file-for-file into `src/core/` (see §3) — one implementation of the maths, two runtimes. |
| `src/api/vanta-api.ts` (repo root) | The frontend's typed remote contract. Where that file declares a call (health, meta, auth, catalogue, cart, orders, seller), this API serves the same path and payload shape; the M12 slices it does not yet declare (returns, reviews, notifications, voucher management, approvals, store settings) are documented in `docs/PARITY.md` and in §4 below. |

### Response envelope

Decided once, in `src/utils/ApiResponse.js` and `src/middlewares/error.middleware.js`:

```jsonc
// success
{ "ok": true, "data": { "...": "..." }, "meta": { "message": "Products." } }

// failure
{ "ok": false, "error": { "code": "validation_failed", "message": "Please fix the highlighted fields.",
                          "fields": [{ "field": "quantity", "message": "Quantity must be a whole number of at least 1." }] },
  "meta": { "requestId": "..." } }
```

- `error.code` is one the client already knows (`validation_failed`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`, `unprocessable`,
  `rate_limited`, `internal_error`) — the mapping lives in
  `STATUS_CODE_NAMES` in `src/middlewares/error.middleware.js`.
- `error.fields[]` carries `{ field, message }` for form errors.
- `meta.requestId` is the `x-request-id` value, echoed on every response
  (`src/middlewares/requestId.middleware.js`), so a client error can be traced
  to one server log line.
- Unknown routes hit `notFoundHandler` and answer in the same envelope; no
  route ever returns HTML.

### Auth model

- **Credential**: an opaque 64-hex session token issued by
  `POST /auth/register`, `POST /auth/quick-account` and `POST /auth/login`, sent as
  `Authorization: Bearer <token>`. This is **not a JWT** — there is no payload
  and no signature to forge; `src/utils/token.js` stores only a SHA-256 digest
  and every request is resolved server-side against the `Session` collection.
  A `cookie-parser` `accessToken` cookie is accepted **only** when no
  `Authorization` header was sent at all, so a bad bearer token can never fall
  through to a second identity (`src/middlewares/auth.middleware.js`).
- **Roles**: `customer`, `seller`, `seller_approver`, held on `User.roles` and
  written only by server code — no endpoint lets a client grant itself a role.
- **Guards** (`src/middlewares/authz.middleware.js`):
  - `authenticate` → attaches `req.user` (public projection, never a hash) and
    `req.sessionId`. Required on every non-public route.
  - `requireSeller` → resolves the authenticated user to an **active**
    `SellerProfile` and attaches `req.sellerProfile` / `req.sellerId`. A
    missing profile, a `pending` applicant and a `rejected`/`suspended` seller
    each get their own 403 message. Identity always comes from the session —
    never from a body field.
  - `requireApprover` (`requireRole("seller_approver")`) → the approval queue.

---

## 2. Quickstart

### Prerequisites

- **Node 20 or newer** — the suite uses the built-in `node:test` runner.
- A reachable **MongoDB** (local or Atlas). There is no in-memory fallback:
  `src/db/index.js` exits the process if it cannot connect.
- No `.env.example` is committed; `.env` and `.env.production` are git-ignored.

### Environment keys (names only)

Read by the code:

| Key | Read in | Purpose |
| --- | --- | --- |
| `PORT` | `src/index.js` | HTTP port (default `4000`) |
| `MONGODB_URI` | `src/db/index.js`, `src/seed/seed.js` | Connection string; the database name `UP` is appended |
| `CORS_ORIGIN` | `src/app.js` | Allowed origin (single value) |
| `NODE_ENV` | `src/constance.js`, `src/services/mailer.js` | `production` tightens cookies and mail |
| `MAIL_PROVIDER` | `src/constance.js` | `console` or `resend` |
| `MAIL_FROM` | `src/constance.js` | Sender address |
| `RESEND_API_KEY` | `src/constance.js` | Resend credential — read, never printed |
| `BCRYPT_ROUNDS` | `src/constance.js` | Password cost (default `12`) |
| `SESSION_TTL_DAYS` | `src/constance.js` | Session lifetime (default `30`) |
| `SESSION_MAX_PER_USER` | `src/constance.js` | Live sessions per account (default `10`, `0` = no cap) |
| `PASSWORD_RESET_TTL_MINUTES` | `src/constance.js` | Reset-token TTL (default `30`) |
| `PUBLIC_APP_URL` | `src/constance.js` | The route the mailed reset link points at |
| `SEED_DB_NAME` | `src/seed/seed.js` | Optional database-name override for rehearsals |
| `CLOUDINARY_API_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | `src/utils/cloudinary.js`, `src/controllers/meta.controller.js` | Seller media storage (M13). Read only as a presence check by the meta report; credential values are sent to Cloudinary's SDK and never printed. All three set → uploads go to Cloudinary and `/meta/media-providers` reports it; absent → the endpoints answer with the local-only fallback |

Present in `.env` but **not read anywhere in `src/`** (leftover keys, listed so
nobody re-introduces them as dependencies): `ACCESS_TOKEN_SECRETE`,
`ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRETE`, `REFRESH_TOKEN_EXPIRY`.

### Install, run, test, seed

```bash
npm install            # dependencies
npm run dev            # nodemon src/index.js
npm start              # node src/index.js
npm run start:production  # node --env-file=.env.production src/index.js
npm test               # node --test src/tests/  (needs MongoDB)
node src/seed/seed.js  # optional demo data
```

Scripts are exactly as written in `package.json`: `dev`, `start`,
`start:production`, `test`. There is no `build` step and no `seed` script —
the seed is run directly with node. `start:production` loads `.env.production`
(which sets `NODE_ENV=production`, tightening mail and cookie behaviour);
`dev`/`start` load `.env` only.

Boot order (`src/index.js`): `dotenv/config` → `assertMailConfig()` (a bad
`MAIL_PROVIDER` exits before any request) → `ConnectDB()` → `app.listen`, with
`SIGINT`/`SIGTERM` closing the listener first and the database second.

### What the seed creates

`node src/seed/seed.js` is idempotent (every row is an upsert keyed on its own
natural key) and writes only:

- the **category taxonomy** copied from the app's `src/taxonomy/index.ts`
  (20 top-level categories plus their subcategories);
- one **demo seller** signed in as `seller.demo@vanta.local`, status `active`,
  with the simulator's store defaults (shipping fee 60, free over 999, 2–4 day
  estimate);
- one store (`Demo Store`) and **eight demo products** across active, draft,
  paused and out-of-stock states, including one product with variants;
- one platform voucher **`DEMO10`** (10% off orders over 500, capped at 100).

The demo password is **generated fresh on every run** with the configured
bcrypt cost, printed to stdout once as `Demo seller password: <value>` (next to
`Demo seller sign-in: <email>`), and never written to the database or to any
file — a seeded database cannot ship with a known credential.

---

## 3. Architecture

### Directory layout

| Path | Contents |
| --- | --- |
| `src/index.js` | Process entry: env load, mail-config check, DB connect, listen, graceful shutdown |
| `src/app.js` | Express app: request id, CORS, body parsers (16kb), cookie parser, all router mounts, 404 + error handlers |
| `src/db/` | Mongoose connection (`ConnectDB` / `DisconnectDB`) |
| `src/routes/` | 18 route files — full paths, method + middleware only, no logic |
| `src/controllers/` | 18 controllers — validate input, call one service, choose status + message, write the envelope |
| `src/services/` | Domain rules (auth, cart, cart-pricing, catalog, catalog.query, order, return, review, seller, voucher, notification, wishlist, address, recently-viewed, follow, media, mailer + `mail/` providers) |
| `src/repositories/` | 17 Mongoose query modules — the only layer that touches models directly from services |
| `src/validators/` | 13 pure validators (auth, cart, order, product, return, review, seller, voucher, wishlist, address, recently-viewed, follow, media) |
| `src/models/` | 21 Mongoose models |
| `src/core/` | Pure rule functions ported from `shared/` (below) |
| `src/middlewares/` | `requestId`, `authenticate`, `authz` (roles/seller/approver), `error`, `rateLimit`, `multer` (seller media upload, M13) |
| `src/utils/` | `ApiError`, `ApiResponse`, `asyncHandlers`, `token`, `cloudinary` (seller media, M13), `helper/email.validator` |
| `src/constance.js` | Shared constants: DB name, token shape, password/session/reset knobs, mail config accessors, cookie options |
| `src/tests/` | 17 `node:test` suites |
| `src/seed/` | `seed.js` — taxonomy + demo marketplace |
| `docs/` | `PARITY.md` — the full parity matrix (§6) |

### Layering

```
route (path + middleware) → controller (validate + envelope)
                         → service (domain rules, uses core/)
                         → repository (queries) → model (Mongoose schema)
```

Requests flow one way; a controller never queries a model, and a service never
writes to `res`. Validators are called by controllers and throw `ApiError`
directly — they never touch the database.

### `src/core/` — the ported rule core

`shared/` is TypeScript; this package is JavaScript ESM, so each file was
ported 1:1 (same function names, same messages, same rounding points). Pure
functions, no I/O:

| Module | Responsibility |
| --- | --- |
| `money.js` | `roundMoney`, `sumMoney` — every amount is a 2-decimal number rounded with the same helper |
| `pricing.js` | line subtotals, per-seller grouping, free-shipping thresholds, cart totals, voucher discount maths, discount allocation with last-group remainder absorption |
| `delivery.js` | `standard`/`express` methods, express premium 40 per seller, delivery quotes and checkout totals |
| `catalog-rules.js` | `effectivePrice`, stock aggregation over variants, `customerVisibility` (product + store + seller active), line availability |
| `voucher-rules.js` | eligibility, windows, usage/per-user limits, seller scope, `voucherDisplayValue` / `voucherAppliedValue` |
| `order-status.js` | `SELLER_STATUS_RANK`, `RETURN_OPEN`/`RETURN_CLOSED`, bottleneck roll-up, `allPartsDelivered` |
| `types.js` | status/type constants shared by the other core modules |

### Validation (one 422, all fields)

Each validator normalises the payload and, if anything is wrong, throws a
single `ApiError(422, "Please fix the highlighted fields.", fields, "",
"validation_failed")` carrying **every** offending field at once — a client
never pays a round trip per mistake. The same validators reject server-only
fields (`id`, `_id`, `createdAt`, `updatedAt`, `__v`) with
`"<field> cannot be set from a request."`, so mass assignment cannot smuggle
an id or a timestamp through a normal payload.

### Error flow

```
controller/service throws ApiError  →  asyncHandlers forwards it
                                   →  errorHandler (src/middlewares/error.middleware.js)
unknown route → notFoundHandler (404, same envelope)
body-parser failures → mapped by type (400/413/415) with our wording
```

`errorHandler` picks the status from the error, the `code` from the error or
from `STATUS_CODE_NAMES`, forwards only `{ field, message }` entries as
`error.fields`, and **logs the stack locally while never putting it in the
payload**. An error that is not an `ApiError` and is 5xx is answered with the
fixed string `"Something went wrong on our side."` — no message, path, env or
stack value reaches the client.

---

## 4. API reference

All paths are relative to `/api/v1`. Auth column:

- **public** — no `authenticate`
- **customer** — `authenticate` only (acts on `req.user.id`)
- **seller** — `authenticate` + `requireSeller` (acts on `req.sellerProfile`)
- **approver** — `authenticate` + `requireApprover` (`seller_approver` role)

### Health & capability metadata

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | public | Liveness + version, uptime and database state (never touches the DB) |
| GET | `/health/ready` | public | Readiness report: `ready` flag + `database.ok`/`driver` |
| GET | `/meta/payment-methods` | public | Payment options, each flagged `simulated` / `settledOnDelivery` |
| GET | `/meta/delivery-methods` | public | `standard`/`express` vocabulary with premium and day window |
| GET | `/meta/media-providers` | public | Where uploads go: Cloudinary when all three keys are set, else the local-only report (read per request) |

### Auth

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/register` | public | Create account, start session, return token |
| POST | `/auth/quick-account` | public (optional session) | Frictionless onboarding: phone only, server mints serial name + placeholder email + random password (owner has none), start session. A valid bearer session resolves to that account instead of creating a duplicate. |
| POST | `/auth/login` | public | Sign in with an email **or** the phone a quick account was created with, plus the password; start session, return token. A phone is never accepted without the password. |
| GET | `/auth/me` | customer | Current user (public projection, includes `hasPassword`) |
| PATCH | `/auth/me` | customer | Update own profile (name/email/phone/avatar) |
| POST | `/auth/me/password` | customer | Change password, revoke other sessions |
| POST | `/auth/me/password/initial` | customer | One-time first password on a quick account: no `currentPassword`. Refused (409) once the account already has a password. |
| POST | `/auth/logout` | customer | Revoke this session |
| POST | `/auth/logout-all` | customer | Revoke every session for the account |
| POST | `/auth/password-reset/request` | public | Mail a single-use reset link; identical answer for known/unknown address |
| POST | `/auth/password-reset/confirm` | public | Spend the token, set the new password, revoke all sessions |

### Catalogue reads (public)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/catalog/categories` | public | The category tree (`parentId` + `order`) |
| GET | `/catalog/products` | public | Paged storefront list: `page`/`pageSize` or `limit`/`offset`, `search`, `categoryId`, `sellerId` |
| GET | `/catalog/products/:id` | public | One product with store, seller summary, effective price and stock |
| GET | `/catalog/stores/:sellerOrStoreId` | public | Storefront header plus its product shelf |
| GET | `/catalog/summary` | public | Product/store/seller/category counts |

### Seller application, store and approvals

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/seller/register` | customer | Submit one application; profile stored `pending`, no role granted |
| GET | `/seller/application` | customer | Own application status (`profile`/`store` nullable) |
| GET | `/seller/profile` | customer | Own seller profile and store |
| GET | `/approvals/sellers` | approver | Approval queue, filterable by status |
| POST | `/approvals/sellers/:id/approve` | approver | Activate application: status + store + role move together; a repeated decision is `409` |
| POST | `/approvals/sellers/:id/reject` | approver | Reject application with a reason; a repeated decision is `409` |
| GET | `/approvals/sellers/:id/history` | approver | Append-only decision trail: `decision`, `actorId`/`actorLabel`, `at`, `note` |
| GET | `/seller/store` | seller | Own store settings |
| PATCH | `/seller/store` | seller | Update store editable fields |
| POST | `/seller/store/status` | seller | Toggle store `active`/`paused` |
| GET | `/seller/dashboard` | seller | Storefront analytics: `productCount`, `orderCount`, `pendingFulfilment`, `revenue` |

### Seller catalogue and inventory

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/seller/products` | seller | Own products, paged |
| POST | `/seller/products` | seller | Create a product (ownership from the session) |
| GET | `/seller/products/:id` | seller | One of own products |
| PATCH | `/seller/products/:id` | seller | Update own product fields |
| PATCH | `/seller/products/:id/status` | seller | Move through `draft`/`pending`/`active`/`paused`/`out_of_stock`/`archived` |
| POST | `/seller/products/:id/stock` | seller | Adjust stock; writes an `InventoryAdjustment` ledger row |
| GET | `/seller/inventory/summary` | seller | Roll-up: units, out/low/healthy counts and per-product rows |
| GET | `/seller/inventory/adjustments` | seller | The stock ledger, newest first |

### Cart

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/cart` | customer | Priced cart: lines, per-seller groups, totals, voucher quotes (`?deliveryMethod=`) |
| POST | `/cart/items` | customer | Add/merge a line (`productId`, `quantity`, optional `variantId`) |
| PATCH | `/cart/items/:id` | customer | Clamp quantity and/or flip `selected` |
| DELETE | `/cart/items/:id` | customer | Remove one line |
| DELETE | `/cart/items` | customer | Empty the cart |
| PATCH | `/cart/select` | customer | Select/deselect all lines, or one seller's lines (`sellerId`) |

### Checkout and customer orders

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/checkout/preview` | customer | Server-priced pre-flight for the caller's own cart |
| POST | `/orders` | customer | Place the order (address, payment, delivery, `voucherCode`, `idempotencyKey`); server recomputes everything |
| GET | `/orders` | customer | Own orders |
| GET | `/orders/:id` | customer | One order with its seller splits and payment |
| POST | `/orders/:id/cancel` | customer | Cancel an own order from an early status, with restock |

### Seller orders

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/seller/orders` | seller | Fulfilment queue for own seller orders |
| GET | `/seller/orders/:id` | seller | One seller order with items and timeline |
| POST | `/seller/orders/:id/advance` | seller | Advance status along the simulator's flow; carries carrier/tracking |

### Vouchers

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/vouchers/eligible` | customer | Quotes for the caller's cart, best discount first |
| POST | `/seller/vouchers` | seller | Create a voucher (code uniqueness, caps, window) |
| GET | `/seller/vouchers` | seller | Own voucher collection |
| GET | `/seller/vouchers/:id` | seller | One own voucher (foreign id = 404) |
| PATCH | `/seller/vouchers/:id` | seller | Update an own voucher |
| DELETE | `/seller/vouchers/:id` | seller | Delete an own voucher |

### Notifications

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/notifications` | customer | Inbox page (`unreadOnly`) plus unread count |
| GET | `/notifications/unread-count` | customer | The badge alone |
| POST | `/notifications/read-all` | customer | Mark the whole inbox read |
| PATCH | `/notifications/:id/read` | customer | Mark one row read (owner only) |
| DELETE | `/notifications/:id` | customer | Delete one row (owner only) |

### Returns and refunds

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/returns` | customer | Own return requests |
| GET | `/orders/:id/returns` | customer | Returns raised against one own order |
| POST | `/orders/:id/returns` | customer | Raise a return for an order line (reason, images, preferred resolution) |
| GET | `/seller/returns` | seller | Return requests on own products |
| GET | `/seller/returns/:id` | seller | One return with timeline |
| POST | `/seller/returns/:id/approve` | seller | Approve a `pending` request |
| POST | `/seller/returns/:id/reject` | seller | Reject a `pending` request |
| POST | `/seller/returns/:id/returned` | seller | Mark goods arrived: restock here (never on approval) and refund |

### Reviews

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/reviews` | customer | Review a delivered, unreviewed order line |
| GET | `/reviews/eligible` | customer | Own delivered lines with no review yet |
| GET | `/reviews/mine` | customer | Reviews the caller wrote |
| PATCH | `/reviews/:id` | customer | Edit own review (author only) |
| DELETE | `/reviews/:id` | customer | Delete own review (author only) |
| GET | `/catalog/products/:id/reviews` | public | Reviews of a customer-visible product |
| GET | `/seller/reviews` | seller | Reviews of own products, with filters |
| GET | `/seller/reviews/:id` | seller | One review of an own product |
| POST | `/seller/reviews/:id/reply` | seller | Seller reply on an own product's review |

### Wishlist (M13)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/wishlist` | customer | The caller's list, pruned against the catalogue, newest-first |
| POST | `/wishlist/items` | customer | Add one product (duplicate = silent no-op; missing product = 422) |
| DELETE | `/wishlist/items/:productId` | customer | Remove one product (absent = no-op) |
| DELETE | `/wishlist` | customer | Empty the whole list |

### Address book (M13)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/addresses` | customer | The caller's address book, insertion order |
| POST | `/addresses` | customer | Create one address (the first auto-becomes the default) |
| GET | `/addresses/:id` | customer | One own address (foreign id = 404 "Address not found.") |
| PATCH | `/addresses/:id` | customer | Merge an `AddressInput` subset into one address |
| DELETE | `/addresses/:id` | customer | Remove one address, returning the remaining book |
| POST | `/addresses/:id/default` | customer | Promote one address to the single default |

### Recently viewed (M13)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/recently-viewed` | customer | Record a product view (only place `product.viewCount` moves; upsert-to-newest) |
| GET | `/recently-viewed` | customer | The caller's list, newest-first (`?limit=` default 12, max 100; drops invisible/missing) |
| DELETE | `/recently-viewed/products/:productId` | customer | Remove one product from the history (200 `{ removed }` either way) |

### Store follows (M13)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/stores/:id/follow` | customer | Follow a store (duplicate = no-op); answers `{ following, followerCount }` |
| DELETE | `/stores/:id/follow` | customer | Unfollow (absent = no-op, count clamped ≥ 0) |
| GET | `/stores/:id/follow` | customer | Current state for one store |
| GET | `/me/follows` | customer | The caller's followed stores as `toStoreDto`, follow order |

### Seller media (M13)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/seller/media` | seller | Multipart `file` upload (≤ 10 MB, image/* + video/mp4) → `{ media: { url, publicId, format, resourceType } }`, stored under `vanta/sellers/<sellerId>/` |
| DELETE | `/seller/media` | seller | Delete by `{ url }` — only URLs whose public id lives in the caller's own folder |

98 rows in total. Paths are taken verbatim from the 18 files in `src/routes/`;
nothing above is aspirational.

---

## 5. Data model

22 models in `src/models/`. Embedded documents are marked.

| Model | Purpose and key fields |
| --- | --- |
| `User` | Account: `name`, `email` (unique), `phone`, `passwordHash`/`passwordSalt` (`select: false`), `avatar`, `roles[]` (`customer`\|`seller`\|`seller_approver`). `toPublicUser` is the only projection that leaves the process. |
| `Session` | One opaque bearer token: `userId`, `tokenHash` (SHA-256 only), `expiresAt` with a TTL index. |
| `PasswordReset` | Single-use reset ticket: `userId`, `tokenHash`, `expiresAt`, `usedAt` (conditional claim prevents double spend). |
| `Counter` | Atomic named sequence (`_id` = key, `seq`). `findOneAndUpdate` `$inc`+upsert hands out the serial part of a quick-account display name (`Customer N`); no two callers ever read the same number. |
| `SellerProfile` | One per user (`userId` unique): identity + `sellerType`, flat pickup/return address strings, embedded `bank` and `agreement`, `status` (`pending`\|`active`\|`rejected`\|`suspended`), `decidedAt`/`decisionNote` (mutable latest-decision view), append-only `decisionHistory[]` (`decision`, `actorId`/`actorLabel`, `at`, `note`). |
| `Store` | One per seller (`sellerId` unique): `name`, `logo`, `banner`, `status`, rating counters, `shippingFee`, `freeShippingThreshold`, embedded `deliveryEstimateDays {min,max}`, `productCount`, `verified`. |
| `Category` | Tree node: `name`, `icon`, `image`, `parentId` (null = top level), `order`. |
| `Product` | Seller listing: `sellerId`, `storeId`, `categoryId`/`subcategoryId`, pricing (`regularPrice`, `salePrice`), `sku`, `stock`, `lowStockThreshold`, `status`, denormalised `ratingAvg`/`ratingCount`/`soldCount`, **embedded `variants[]`** (each with `sku`, `attributes`, `price`, `stock`). |
| `Cart` | One per user (`userId` unique): **embedded `items[]`** — `productId`, `sellerId`, `variantId?`, `quantity`, `selected`, `priceSnapshot`. |
| `Order` | Customer-side root: `customerId`, `orderCode`, `status`, `sellerOrderIds[]`, server-computed `subtotal`/`shippingTotal`/`vouchersDiscount`/`total`, `paymentMethod`, `paymentStatus`, `deliveryMethod`, embedded `shippingAddress`, `voucherCodes[]`. |
| `SellerOrder` | Per-seller split: `orderId`, `sellerId`, `storeId`, `status`, **embedded `items[]`** (immutable order-line snapshots incl. `returnedQuantity`/`remainingQuantity`), embedded `shippingAddress`, embedded `timeline[]`, `carrier`, `trackingNumber`. |
| `PaymentTransaction` | The order's single payment: `orderId` ( unique — one order can never get two payments), `method`, `amount`, `status`, `reference`, `refundedAt`/`refundedAmount`. |
| `CheckoutAttempt` | Idempotency claim: `userId`, `fingerprint` (explicit key or request fingerprint), `requestFingerprint`, `state` (`in_flight`\|`completed`\|`released`), `orderId`. |
| `InventoryAdjustment` | Stock ledger row: `productId`, `variantId?`, signed `quantity`, `reason` (`sale`\|`restock`\|`manual`\|`cancellation`\|`return`), `referenceId`, denormalised `sellerId`. |
| `Voucher` | Discount: `code` (stored uppercase, unique), `type` (`percentage`\|`fixed`\|`free_shipping`), `discountValue`, `minimumOrder`, `maximumDiscount`, `scope` (`platform`\|`seller`) + `sellerId`/`categoryId`/`productIds`, window (`startAt`/`expiry`), `usageLimit`/`usageCount`/`perUserLimit`/`perUserUsed`, `active`. |
| `Review` | One per order line (`orderItemId` unique): `userId`, `userName`, `productId`, `sellerId`, `orderId`, `rating`, `title`, `text`, `images[]`, `verifiedPurchase`, embedded `sellerReply {text, at}`. |
| `ReturnRequest` | Item-level return: `orderId`, `sellerOrderId`, `orderItemId`, `userId`, `sellerId`, `quantity` (null = all remaining), `reason`, `description`, `images[]`, `preferredResolution`, `status` (`pending`\|`approved`\|`rejected`\|`returned`\|`refunded`), embedded `timeline[]`. |
| `Notification` | In-app inbox row: `userId`, `type` (the simulator's 16 types plus `system`), `title`, `body`, `read`, `data`. |
| `Wishlist` | One per user (`userId` unique, M13): embedded `items[]` — `productId`, `addedAt`. Pruned against `Product` on read; ordering carried by `createdAt` plus reverse array order. |
| `Address` | One row per saved address (M13): `userId`, `name` (label), `phone`, `division`, `district`, `street`, `postalCode`, `isDefault` (at most one per user, maintained server-side), `createdAt`/`updatedAt`. |
| `RecentlyViewed` | One per `(userId, productId)` (unique together, M13): `userId`, `productId`, `viewedAt`, with `{userId:1, viewedAt:-1}` for the newest-first read. |
| `StoreFollower` | One per `(userId, storeId)` (unique together, M13): `userId`, `storeId`; `Store.followerCount` moves ±1 through the write, clamped ≥ 0. |

---

## 6. Parity with the simulator

> **M19 update (remote-only).** The frontend's on-device local simulator and its
> `EXPO_PUBLIC_API_MODE` switch have been removed; the app is now remote-only and
> this API is its single source of truth. The parity notes below are a historical
> record of how the backend relates to the old frozen simulator, kept for
> provenance. Where they say "the simulator's local mode", read it as the pre-M19
> client; the remote semantics described are now the client's only semantics.

The behavioural specification is the frozen local simulator (`src/services/*`,
`shared/*` on the frontend side); the full row-by-row matrix — status per
capability, what the M12 start state was, and where each rule lives — is in
**[`docs/PARITY.md`](docs/PARITY.md)** and is not repeated here.

The deliberate divergences:

- **Seller activation.** The simulator's local mode opens a store immediately
  on submit (there is no operator surface on a device). This backend uses the
  *remote* semantics: `POST /seller/register` stores the application as
  `pending` and grants nothing; only an operator with `seller_approver`
  activates it through `/approvals/sellers/:id/approve`, which moves seller
  status, store visibility and the role together.
- **No payment gateway.** `cod`, `bkash`, `nagad`, `card` exist as payment
  methods and are recorded on `PaymentTransaction`, but nothing moves money:
  online methods are marked paid at placement, COD stays `pending` until
  delivery. There is no bKash/Nagad/card verification flow server-side — the
  simulator's OTP/PIN/code sheets stay on the device.
- **Inline checkout address still wins on orders.** The M13 address book is a
  first-class resource, but `POST /orders` keeps taking the shipping address
  inline and snapshotting it onto the order (and each seller split): history
  never moves when a customer later edits the book.
- **Deferred features**: search history and promotions have no endpoint and no
  model (see §9). Search history stays device-local because the frontend
  contract (`src/api/vanta-api.ts`) declares no endpoint for it and
  `search-service.ts` keeps its history in the local store.
- **No frontend switch in this milestone.** The Expo app still runs the frozen
  simulator for everything except auth, catalogue hydration and seller
  application — this milestone lands the server, not the client's
  `isRemoteMode()` wiring (the gap recorded in `full.md` C1).

---

## 7. Testing

`npm test` runs `node --test src/tests/` — 17 suites, all against a **real
MongoDB** reached through the configured `MONGODB_URI`. Every suite uses its
own database, drops it on completion, and never touches the application
database (`UP`).

| Suite | Test database | Covers |
| --- | --- | --- |
| `auth.test.js` | `vanta_test` | Registration, login, `/auth/me`, profile/password changes, logout / logout-all, password reset (identical known/unknown answers, single use, session revocation), `/health` + `/health/ready`, envelope and `x-request-id` |
| `quick-account.test.js` | `vanta_quick_test` | Phone-only creation, serial `Customer N` name, placeholder email, session token authenticates, distinct accounts, session resolve (no duplicate), field errors, server-only field rejection, and the first-password flow: `hasPassword:false`, one-time `/auth/me/password/initial`, sign-in by phone+password, replay refused (409), normal accounts refused (409), no phone-only sign-in |
| `mail.test.js` | `vanta_mail_test` | Provider selection, `assertMailConfig` failures, reset delivery through the mailer; a stubbed Resend client means no real email is ever sent |
| `browse.test.js` | `vanta_browse_test` | The unauthenticated surface: the public catalogue reads (visibility, both paging dialects, search, filters, detail, store, summary) and the three `/meta/*` capability routes — not one request carries an `Authorization` header |
| `cart.test.js` | `vanta_cart_test` | Add/merge, quantity clamp, select/deselect, clear, pricing groups, availability |
| `catalog.test.js` | `vanta_catalog_test` | Seller product create/update/status/stock, ownership 404s, inventory ledger rows |
| `order.test.js` | `vanta_order_test` | Checkout and orders: server-side repricing, seller splits, payment/ledger/notification rows, idempotency replay/conflict/release, oversell guard, voucher reuse, cancel + restock |
| `return.test.js` | `vanta_return_test` | `pending → approved\|rejected → returned → refunded`, restock only on arrival, refund clamp against payment headroom, parent/split/item moves, notifications |
| `review.test.js` | `vanta_review_test` | One review per line, eligibility, author-only edit/delete, rating denormalisation on product and store, seller scope and reply rules |
| `voucher.test.js` | `vanta_voucher_test` | Seller voucher CRUD with ownership 404s, validation messages, `/vouchers/eligible` quotes |
| `notification.test.js` | `vanta_notification_test` | Inbox ordering, unread badge, mark read / read-all / delete, cross-user isolation |
| `seller.test.js` | `vanta_seller_test` | Application, approval queue, store settings, category tree, role/status guards, seller dashboard counters |
| `money.test.js` | *(none — pure unit tests)* | Ported core: rounding ties, subtotals, free-shipping thresholds, express premium, voucher caps/scope, multi-seller allocation with last-group remainder |
| `wishlist.test.js` | `vanta_wishlist_test` | Wishlist: lazy get-or-create, add/dup no-op, prune drop-missing + dedupe-keep-first, availability projection, newest-first, remove/clear |
| `address.test.js` | `vanta_address_test` | Address book: verbatim validation messages, first-auto-default, `isDefault:true` promotion, default transfers on delete, foreign-id 404 |
| `recently-viewed.test.js` | `vanta_recently_viewed_test` | Record (viewCount `$inc` + upsert-to-newest), newest-first list with invisible-drop, single-product remove; missing product → 422 |
| `follow.test.js` | `vanta_follow_test` | Follow/unfollow state, duplicate no-ops, followerCount clamping ≥ 0, `toStoreDto` projection, missing store → 404 |
| `media.test.js` | `vanta_media_test` | Multer 10 MB / content-type 422s, folder-scoped upload (Cloudinary when configured, local fallback otherwise), ownership-only delete, idempotent second delete |

Run everything or one file:

```bash
npm test                              # node --test src/tests/
node --test src/tests/order.test.js   # a single suite
node --test src/tests/money.test.js   # no database needed
```

Rules that hold for the whole suite:

- **Real MongoDB, real HTTP.** Eleven suites (`auth`, `mail`, `browse`, `cart`,
  `notification`, `voucher`, `wishlist`, `address`, `recently-viewed`,
  `follow`, `media`) boot `src/app.js` on an ephemeral port and assert
  what a client observes (status, envelope, error code, field messages); the
  slice suites written before final wiring (`catalog`, `order`, `return`,
  `review`, `seller`) assemble the identical middleware stack with the same
  router files, so they behave the same before and after mounting in
  `app.js`.
- **Test databases are dropped when the suite finishes** (`dropDatabase()` in
  `after`), so a run is repeatable and cannot pollute the app data.
- **Mail never leaves the machine.** Development and tests default to
  `MAIL_PROVIDER=console`, which keeps messages in an in-process outbox the
  tests read (`getOutbox`/`clearOutbox`); `mail.test.js` additionally stubs
  the Resend client. `assertMailConfig()` refuses `console` when
  `NODE_ENV=production` and refuses an unknown provider, both at boot and
  before every send.

---

## 8. Security posture

- **Identity is always server-side.** `authenticate` resolves the bearer token
  (or, only when no header was sent, the `accessToken` cookie) against the
  session store; `req.user` is the public projection — never a hash, never
  something a body can craft. `requireSeller` derives `req.sellerProfile` from
  `req.user.id`, so a client that names a seller id it does not own is simply
  not that seller.
- **IDOR is answered with 404.** A product, order, review, voucher,
  notification or return belonging to somebody else is indistinguishable from
  one that does not exist — checked in the service layer, asserted per suite.
- **Whitelisted writes.** Validators return a constructed object from allowed
  keys only and reject `id`, `_id`, `createdAt`, `updatedAt`, `__v` with a
  field error; `sellerId`, prices, totals and status transitions are set by
  server code, not by request fields.
- **The envelope never leaks.** Stacks are logged to the server console only;
  unexpected 5xx responses carry a fixed message; body-parser failures are
  re-worded; `x-powered-by` is disabled and no version banner is emitted.
- **Secrets stay server-side.** Key names only in this document —
  `RESEND_API_KEY`, `MONGODB_URI`, `CORS_ORIGIN`, `BCRYPT_ROUNDS`,
  `SESSION_TTL_DAYS`, `SESSION_MAX_PER_USER`, `PASSWORD_RESET_TTL_MINUTES`.
  Passwords are bcrypt-hashed (`select: false`), session and reset tokens are
  stored as SHA-256 digests and are single-use/expiring where applicable.
- **Sessions are revocable.** Logout deletes the row, password change revokes
  the other sessions, a reset revokes all of them; per-account sessions are
  capped by `SESSION_MAX_PER_USER` with eviction.
- **No role escalation.** `seller` is granted by the approver flow, and
  `seller_approver` exists only as a server-held enum value — no endpoint
  writes `roles`.
- **Password reset is enumeration-safe**: request answers identically for a
  known and an unknown address, stores only a digest, and both reset routes
  are unauthenticated by design.
- **A quick account's first password is a one-time, authenticated write.** The
  account's `passwordSet` flag is `false` only for quick accounts; while it is
  false `/auth/me/password/initial` sets the password without a
  `currentPassword` and flips the flag in the same update, so the no-password
  path can never be replayed and a normal account (default `true`) can never
  take it. Sign-in accepts an email or a phone, but a phone is not unique and
  is never proof on its own — the password is always required and compared
  against every account that carries the number.
- **Mail provider split**: `MAIL_PROVIDER=console` for development and tests
  (never in production — boot fails), `MAIL_PROVIDER=resend` for real
  delivery, with `RESEND_API_KEY` required at boot and read but never printed.
- **Transport hardening**: CORS allow-list from `CORS_ORIGIN`, with
  `credentials: true` **only when a concrete origin is configured** (a missing
  or `*` origin never pairs with cookie forwarding); `x-request-id`/
  `retry-after` exposed; 16kb body limit on both parsers; inline security
  headers on every answer (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`).
- **Rate-limited identity routes.** `POST /auth/register` and
  `POST /auth/login` share one per-IP window (100 / 15 min);
  `POST /auth/quick-account` has its own per-IP bucket (60 / 15 min) because it
  mints accounts without a password;
  `/auth/password-reset/request` is 25 / 15 min and `/auth/password-reset/confirm`
  is 50 / 15 min (`src/middlewares/rateLimit.middleware.js`), answering 429
  `rate_limited` with a client-facing message. Buckets are process-local, so
  they reset on restart.

---

## 9. Limitations / not yet implemented

Against `docs/PARITY.md`'s target scope (phases A→J: catalog data, seller
foundation, public browsing, cart, checkout, orders, returns/refunds,
vouchers, reviews, notifications) and the frontend contract in
`src/api/vanta-api.ts`, the following is honest state:

**Deferred features (no model, no endpoint)**

- **Search history** — stays device-local by design: the frontend contract in
  `src/api/vanta-api.ts` declares no search-history endpoint and
  `search-service.ts` records history in the app's local store, so there is
  nothing for the server to mirror (M13 §9).
- **Promotions** — the M12 report's deferred list did not include promotions
  and no M13 section covers it; the contract declares no endpoint, so it is
  recorded here as a remaining gap, not implemented.
- Seller dashboard analytics and diagnostics (beyond the M12
  `/seller/dashboard` counters) remain unexposed.

**Media (M13)**

- Seller media upload is live: `POST /seller/media` streams a single multipart
  `file` through the multer middleware to Cloudinary under
  `vanta/sellers/<sellerId>/` when all three `CLOUDINARY_*` keys are set, and
  to a local `./public/temp` fallback otherwise. Deleting a media URL is
  permitted only to the seller whose public-id folder owns it. Upload does not
  mutate a product or store document: the client hands the returned URL to the
  ordinary M12 PATCH routes, which is exactly how the seller screens already
  work with any URL.

**Public seller data**

- `GET /catalog/stores/:id` returns the reduced projection the storefront
  needs — `StoreSummary { store, seller: Pick<'id'|'fullName'|'status'|
  'sellerType'>, productCount }` — and product detail carries the same shape.
  The frontend's product screen never reads `.seller` fields beyond that and
  `remote-hydration` drops the rest, so the reduced **seller** projection is
  left deliberately unchanged (M13 §15/§16); there is still no endpoint that
  returns a full `SellerProfile`.

**Hardening gaps**

- **No CSP** and no `helmet`; the strict response headers are the inline trio
  from §8, and there is no connect-src/default-src policy for the web client.
- **Checkout is claim-based, not transactional.** Atomicity comes from the
  ordered write set plus the `CheckoutAttempt` idempotency claim with a retry
  window — there is no multi-document transaction and no compensating-write
  strategy report on `/health/ready` (which the reference `backend/` exposes).
- Idempotency exists only for checkout; other writes have no replay protection.
- Rate limiting, pagination caps and CORS are in-process/per-instance only.

**Contract/parity notes**

- The Expo app is not switched to remote mode in this milestone: only auth,
  catalogue hydration and seller application go over HTTP today
  (`full.md` C1), so this server is not yet the datastore for cart, checkout
  or orders in a shipped build. **(Superseded by M19:** the app is now
  remote-only and this server is the datastore for cart, checkout, orders,
  returns, reviews, wishlist, follows, addresses and notifications.)
- Server seed data (`node src/seed/seed.js`) is developer convenience and
  deliberately separate from the app's empty-marketplace rule; it is opt-in,
  idempotent, and never runs at boot.
- The `.env` still carries unused JWT key names from the imported project
  (`ACCESS_TOKEN_SECRETE`, `ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRETE`,
  `REFRESH_TOKEN_EXPIRY`); nothing in `src/` reads them.

---

## Requirements checklist (M12 documentation)

Each row quotes the requirement and points at the section that satisfies it.
`full.md` is the source of truth for the backend's behavioural obligations; it
contains **no** sections numbered §24/§27 and no "M12" heading (its sections
are A1–A15, B1–B11, C1–C5), so the documentation obligations are tracked
against the clauses that do exist there.

| Requirement (quoted) | Where satisfied |
| --- | --- |
| C3.1 "**Envelope** — every response is `{ok,data}` or `{ok:false,error,meta}`; error `code` must be one the client knows (A14) so `ApiError` stays typed." | §1 "Response envelope" (shapes, code list, `meta.requestId`) |
| C3.3 "**Server is authoritative** for identity, pricing, stock and order state; client money fields are discarded and recomputed from `shared/` rules." | §1 auth model, §3 layering + `src/core/` table, §4 `POST /orders`, §8 "Whitelisted writes" |
| C3.4 "**One implementation of the maths** … money rounding, cart grouping, voucher evaluation, delivery quoting, order roll-up must keep coming from `shared/`." | §3 "`src/core/` — the ported rule core" (file-for-file port table) |
| C3.5 "**Empty marketplace is a product rule** … Server seed data must remain opt-in … and never production." | §2 "What the seed creates", §9 "Contract/parity notes" |
| C3.6 "**Roles cannot be self-granted** — `seller` and `seller_approver` are server-side only." | §1 "Auth model", §4 seller/approvals tables, §8 "No role escalation" |
| C3.7 "**Seller status, store visibility and role move together** … a no-op decision is a `409`." | §4 `/approvals/sellers/:id/approve`, §6 "Seller activation" |
| C3.8 "**Password reset** is two-step, hashed, single-use, revokes all sessions, and answers known/unknown addresses identically." | §4 auth table, §8 "Password reset is enumeration-safe" |
| C3.9 "**Checkout is atomic … and idempotent** (DB-enforced key claim … replay / conflict / release semantics)." | §4 `POST /orders`, §5 `CheckoutAttempt`, §9 "Checkout is claim-based, not transactional" (stating what this port does instead) |
| C3.10 "**Line snapshots stay optional** — `variantId`, `returnedQuantity`, `remainingQuantity` must tolerate older records." | §5 `SellerOrder` embedded `items[]` |
| C3.11 "**Bottleneck roll-up + `allPartsDelivered`** semantics exactly as in A13." | §3 `order-status.js` row |
| C3.12 "**Payment simulators keep their fixed values** … no gateway is contacted." | §4 `/meta/payment-methods`, §6 "No payment gateway" |
| C3.13 "**Catalogue mirror must be replaceable wholesale** — `GET /catalog/*` must be able to return the entire catalogue (paged …)." | §4 catalogue table + paging dialects, §7 `browse.test.js` |
| C2 / C3.14 (seller display gap, client capabilities without server counterpart) | §6 "No frontend switch in this milestone", §9 "Hardening gaps" + "Contract/parity notes" |
| A14 "Envelope: `{ ok: boolean, data?, error?: { code, message, fields? }, meta?: { requestId } }`" | §1 "Response envelope" |
| A14 endpoint surface (`/health`, `/meta/*`, `/auth/*`, `/catalog/*`, `/cart`, `/orders`, `/seller/*`) | §4 API reference (98 rows; M13 adds `/wishlist`, `/addresses`, `/recently-viewed`, `/stores/:id/follow`, `/me/follows`, `/seller/media`) |
| B1 "Run: `cd … && npm install && … && npm run seed && npm run dev`" — the run/seed/test instructions | §2 Quickstart (verified against `package.json`: `dev`, `start`, `test`; seed via `node src/seed/seed.js`) |
| B6 cross-cutting concerns (request id, validation, auth, errors, response) | §3 "Validation" + "Error flow", §8 Security posture |
| The repository's own documentation contract for a backend README — *endpoints, configuration, security properties and known limitations* (root `README.md`, "The API") | §4 endpoints, §2 configuration keys, §8 security, §9 limitations |
| A13 "Rules the backend must reproduce exactly" (free-shipping scope, voucher caps, `allPartsDelivered` gating) | §3 `pricing.js` / `voucher-rules.js` rows, §7 `money.test.js` |
| `docs/PARITY.md` must be linked, not duplicated | §6 links to `docs/PARITY.md` |
