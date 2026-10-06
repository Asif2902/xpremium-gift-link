# X Premium Gift — Official Checkout Link Generator

Minimal Node.js app. It does one thing: ask **X itself** to create the official
gift checkout session and return its URL. Payment happens only on the official
checkout page (`checkout.stripe.com`). This app never processes cards, holds no
Stripe secret key, and stores nothing.

## How they did it (traced from `mizorewww/x_gift_bot`)

That project proved the key fact: **X creates the Stripe Checkout Session and
returns the URL — our app never creates it.** No `sk_` secret is used anywhere
in their flow either. Their `internal/checkout` package does exactly this, and
so do we:

| Step | Request (all to `https://x.com`, authed as your own X account) |
|---|---|
| Recipient identity + eligibility | `GET /i/api/graphql/kn8hCE6bHstQV2MtfYDTKg/PremiumGiftingQuery` with `{"screenName": user}` → numeric id + `premium_gifting_eligible` |
| Product/plan selection + price check | `GET /i/api/graphql/Se1Bp6zcNnuXYXRecV2qLA/useSubscriptionProductDetailsByRestIdQuery` with `{"stripeId": product}` → must be one `OneTime` price, same currency, `amount_local_micro == amount_minor × 10000` |
| Order/checkout creation | `POST /i/api/graphql/GqTVJ4S1526tLkxj69xIZw/useOneTimePurchaseGiftMutation` with `cancel_url`, `success_url`, `external_product_id`, `gift_recipient` → `{ session_id: cs_live_…, session_url, session_status: "Unpaid" }` |
| Payment URL | `session_url` (validated: `https://checkout.stripe.com/<lang>/pay/<session_id>`) shown as "Open Official Checkout" |

Plan catalog (their `catalog` record = our `PLANS` in `server.js`):
`plan_3m` → `prod_TJXJtpzqCpI36N` / `30000` (BDT),
`plan_6m` → `prod_TJXKKNJwZJIhCM` / `60000` (BDT).
Amounts are minor units. The request says "three plans" but only two were
specified — only those two are implemented.

Auth is your own X login: `auth_token` + `ct0` cookies (ct0 also sent as
`X-Csrf-Token`), the `Bearer ...` Authorization header, and your User-Agent.
Their Stripe `pk_live_` public key is only used for the *card-payment* step,
which this app deliberately does not implement.

## Run locally

```bash
npm install
cp .env.example .env   # then fill in your four X values (see below)
npm run dev    # or: npm start
```

Open http://localhost:3000

Flow: Select plan → enter recipient X username → Generate Link → Open Official Checkout.

## Configuration

All credentials stay server-side in `.env` (never in frontend JS):

- `X_AUTH_TOKEN`, `X_CT0` — from your browser: log in to x.com, F12 → Application → Cookies → `https://x.com`
- `X_AUTHORIZATION` — the `Bearer ...` value from DevTools → Network → any `x.com/i/api` request header
- `X_USER_AGENT` — the User-Agent header from the same request
- `MERCHANT_ACCOUNT_ID` — defaults to `acct_1Ika5JA3KZ32dPo1`
- `PORT` — defaults to `3000`

No Stripe secret key. No database, no marketplace, no proxies, no automation.
The only third-party calls are the three official X endpoints above. X cookies
expire — when link generation starts failing, refresh the four values from
your browser again.
