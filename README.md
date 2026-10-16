# Bunk Coin top-up (129Knots)

Organisations on the 129Knots platform buy Bunk Coin with preset packages or a custom amount, paid through **Stripe embedded Checkout**. Coins are credited to the buying organisation by a verified Stripe webhook, exactly once.

- **Backend:** Node.js 22.9+, Express 5, `stripe` 23.0.0 → Stripe API **`2026-09-30.endive`**
- **Frontend:** plain HTML/CSS/JS in `web/` (no build step), 129Knots "Dashboard 4" styling, responsive from 340px phones to desktop
- **Identity:** user and organisation are **ULIDs read from the session**. No names or emails are stored, logged or sent to Stripe.

---

## Run locally

```bash
npm install
cp .env.example .env            # paste sk_test_ / pk_test_ keys from the SAME sandbox as `stripe login`

# terminal B — forward webhooks (copy the whsec_ it prints into .env)
stripe login
npm run webhooks

# terminal A — the app (auto-restarts on save)
npm run dev
```

1. Open http://localhost:4242 → **dashboard** with the Bunk Coin card.
2. Click **+** (or **Top up Bunk Coin**) → **purchase page** with *Choose amount* and *Purchase history*.
3. Pick an amount → **Continue to payment** → pay with `4242 4242 4242 4242`, any future expiry, any CVC.
4. Stripe redirects to the **result page**: ✅ coins added and the new balance. History shows *Credited*.

Terminal A prints every server step, numbered ① to ⑪. Terminal B shows each webhook and the status your server answered.

```bash
npm test     # 51 tests: ULID identity, pricing, idempotent retries, Stripe errors, webhook crediting & failure paths
```

To act as a different organisation, set `DEV_ORG_ID` in `.env` to another ULID and restart.

---

## Pages

| Page | Contents |
|---|---|
| `/` (`index.html`) | Dashboard: short header with the Bunk Coin stats card (**+**, *Top up*, *Purchase history*) |
| `/topup.html` | Purchase page: choose amount → Stripe embedded checkout · purchase history |
| `/return.html?session_id=…` | Where Stripe sends the customer back: payment result · purchase history |

---

## Identity and metadata

The server reads `{ userId, orgId }` (both ULIDs) from the verified session (`src/auth.js`), never from the request body.

| Mode | Where the identity comes from |
|---|---|
| `AUTH_MODE=dev` | Signed, HTTP-only `bkc_session` cookie issued on first visit for `DEV_USER_ID` / `DEV_ORG_ID` |
| `AUTH_MODE=jwt` | HS256 JWT from the 129Knots auth service: `sub` = user ULID, `org_id` = organisation ULID, `exp` |

Every purchase gets an **order ULID** before Stripe is called. It links our order, the Stripe session and the ledger credit:

| Stripe field | Value |
|---|---|
| `client_reference_id` | order ULID |
| `metadata` (session) | `app`, `order_id`, `org_id`, `user_id`, `package_id`, `quantity`, `unit_amount` |
| `payment_intent_data.metadata` | `app`, `order_id`, `org_id`, `user_id`, `quantity` (visible on the payment in the Dashboard) |
| `customer` | one Stripe Customer per organisation (`metadata.org_id`), no name or email |

---

## How a purchase flows (log line per step)

```
CHECKOUT ① Checkout requested           browser sent { package_id } or { quantity }, never a price or organisation
         ② Priced the order              server: quantity × unit price  (src/pricing.js)
         ③ Order reserved → pending      new order ULID (a retried request reuses the same order)
         ④ Stripe customer               the organisation's Stripe Customer (created on first purchase)
         ⑤ Session created & linked      Checkout Session with the order ULID in client_reference_id + metadata
   … customer pays inside Stripe's iframe (card data never reaches us) …
WEBHOOK  ⑥ Webhook received             POST /webhooks/stripe from Stripe
         ⑦ Signature verified            STRIPE_WEBHOOK_SECRET: forged requests are rejected
         ⑧ Payment confirmed (paid)      or: awaiting payment / expired / failed
FULFIL   ⑨ Integrity checks passed       ULIDs valid, client_reference_id = order_id, subtotal = qty × unit
         ⑩ Credited N BunkCoin           ledger.credit(org, qty, order_id): idempotent by order
         ⑪ Order fulfilled ✓             result page shows ✅ and the new balance
STATUS   Return page check               page polls payment (Stripe) + fulfilment (our order)
```

**Why the order is reserved first:** Stripe only accepts a retried idempotent request if its parameters are identical. Reserving the order (with its ULID and `expires_at`) before calling Stripe means a double click or network retry sends exactly the same request and gets back the same session.

### When crediting fails

| Situation | Order status | Answer to Stripe | Customer sees |
|---|---|---|---|
| Credited | `fulfilled` | 200 | ✅ "N Bunk Coin added. Balance is now X" |
| Same event delivered again | unchanged | 200 | — (log: duplicate delivery) |
| Ledger temporarily down | `credit_retrying` (+attempts) | **500**, so Stripe retries for up to 3 days | ⏳ "taking a little longer…" |
| Ledger rejects (account closed/suspended) | `needs_review` | 200 (retrying can't help) | 🛟 "Payment received, our team will finalise it" |
| Amount or metadata doesn't match | `needs_review` | 200 | 🛟 same |
| Bank payment not cleared yet | `awaiting_payment` | 200 | 🕒 "Processing by your bank" |

`needs_review` and `credit_retrying` are logged as **error** with an `action=` hint. Alert on these in production.

---

## Project layout

```
src/server.js   wiring: config, logger, Stripe client, auth, store, ledger
src/app.js      routes, checkout ①–⑤, webhook ⑥–⑧, fulfilment ⑨–⑪ ("PRODUCTION:" notes inline)
src/auth.js     identity from the session: dev cookie or JWT; ULIDs only
src/ulid.js     ULID generate / validate
src/store.js    orders (keyed by order ULID) + ledger, in memory; LedgerError (permanent vs temporary)
src/pricing.js  validates the choice and prices it
src/errors.js   one error shape; Stripe errors → customer-safe messages
src/logger.js   pretty / JSON logs
src/config.js   env validation (fails fast)
web/theme.css   brand tokens: the only file to edit for colours/fonts
web/style.css   layout + components (responsive)
web/index.html + dashboard.js   dashboard
web/topup.html + topup.js       purchase page → embedded checkout
web/return.html + return.js     result after payment (polls status)
web/shell.js    shared: session, balance, purchase history
web/api.js      fetch helper, money formatting, error banner
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/config` | — | Packages, price, limits, publishable key |
| GET | `/api/me` | — | `{ signed_in, user_id, org_id, balance }` |
| GET | `/api/orders` | ✓ | Organisation's last 10 purchases |
| POST | `/api/checkout-sessions` | ✓ | `{package_id}` or `{quantity}` → `{order_id, session_id, client_secret, quote}` |
| GET | `/api/checkout-sessions/:id` | ✓ (own organisation only) | `{order_id, status, payment_status, fulfilment, quantity, balance_after, …}` |
| POST | `/webhooks/stripe` | Stripe signature | Fulfilment |

---

## Going to production: what to implement

1. **Login:** set `AUTH_MODE=jwt` and `AUTH_SECRET` to the HS256 secret your auth service signs with. Tokens need `sub` (user ULID), `org_id` (organisation ULID) and `exp`. If your service uses RS256/JWKS, replace `verifyJwt()` in `src/auth.js`.
2. **Orders table** (Postgres) replacing `MemoryOrderStore`:
   ```sql
   CREATE TABLE bunkcoin_orders (
     order_id          CHAR(26) PRIMARY KEY,          -- ULID
     org_id            CHAR(26) NOT NULL,
     user_id           CHAR(26) NOT NULL,
     package_id        TEXT NOT NULL,
     quantity          BIGINT NOT NULL,
     unit_amount       BIGINT NOT NULL,
     total             BIGINT NOT NULL,
     currency          CHAR(3) NOT NULL,
     status            TEXT NOT NULL,                 -- pending | awaiting_payment | credit_retrying | fulfilled | needs_review | payment_failed | expired
     idempotency_key   TEXT UNIQUE NOT NULL,
     expires_at        BIGINT NOT NULL,
     stripe_session_id TEXT UNIQUE,
     failure_reason    TEXT,
     attempts          INT NOT NULL DEFAULT 0,
     balance_after     BIGINT,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
     credited_at       TIMESTAMPTZ,
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX ON bunkcoin_orders (org_id, order_id DESC);
   ALTER TABLE organisations ADD COLUMN stripe_customer_id TEXT;
   ```
   `fulfil()` runs as one transaction: `UPDATE … SET status='fulfilled' WHERE order_id=$1 AND status<>'fulfilled' RETURNING *`, credit, commit.
3. **Ledger** replacing `MemoryLedger`: `credit(orgId, qty, orderId)` must be idempotent by order id, return `{balanceBefore, balanceAfter}`, and throw `LedgerError({permanent: true})` for closed/suspended accounts or `{permanent: false}` for outages.
4. **Webhook endpoint** in the Stripe Dashboard (live mode) for the four `checkout.session.*` events, API version `2026-09-30.endive`. Its `whsec_` goes in your secrets store.
5. **Logs & alerts:** `LOG_FORMAT=json`. Alert on `cat=FULFIL level=error` (paid but not credited) and `cat=WEBHOOK level=error` (signature failures).
6. **Edge:** set `trust proxy`, make sure the ingress passes the webhook body unmodified, and add a CSP allowing `js.stripe.com`.
7. **"Utilised coins"** on the Bunk Coin card: wire to your usage records (`web/shell.js`).
8. **Branding:** confirm the exact hex codes and font in Figma's Inspect panel and update `web/theme.css`. Replace the CSS logo mark with the real logo file.


---

## Sample card numbers

Mastercard success	5555 5555 5555 4444
Amex success (4-digit CVC)	3782 822463 10005
Visa debit success	4000 0566 5566 5556
Requires 3D Secure authentication	4000 0025 0000 3155
Generic decline	4000 0000 0000 0002
Insufficient funds	4000 0000 0000 9995
Incorrect CVC decline	4000 0000 0000 0127
Expired card decline	4000 0000 0000 0069