// Minimal X Premium gift checkout-link generator (Node.js, no SDKs for payment).
//
// How it works (traced from github.com/mizorewww/x_gift_bot, internal/checkout):
// X itself creates the Stripe Checkout Session and returns its URL. Our backend
// only calls X's official GraphQL endpoints as the operator's own X account:
//   1. PremiumGiftingQuery      -> verify recipient exists + can receive gifts
//   2. useSubscriptionProductDetailsByRestIdQuery -> verify product/price/currency
//   3. useOneTimePurchaseGiftMutation -> X creates the session, returns its URL
// Payment happens ONLY on the returned official checkout.stripe.com URL.
// No Stripe secret key (sk_) is needed or used. No card handling. No database.

require("dotenv").config();
const express = require("express");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);

// Operator's own X account cookies (server-side only, never sent anywhere
// except https://x.com). Get them from your browser after logging in to x.com:
// DevTools -> Application -> Cookies -> https://x.com : auth_token and ct0.
// Authorization/User-Agent below are X's public web-client identifiers, same
// for everyone (defaults taken from x_gift_bot's setup wizard); override via
// env only if X starts rejecting them.
const DEFAULT_X_AUTHORIZATION =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const DEFAULT_X_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const X_AUTH_TOKEN = (process.env.X_AUTH_TOKEN || "").trim();
const X_CT0 = (process.env.X_CT0 || "").trim();
const X_AUTHORIZATION = (process.env.X_AUTHORIZATION || "").trim() || DEFAULT_X_AUTHORIZATION;
const X_USER_AGENT = (process.env.X_USER_AGENT || "").trim() || DEFAULT_X_USER_AGENT;

// ---------------------------------------------------------------------------
// Plan catalog. Each plan maps to exactly one X/Stripe Product + amount.
// Amounts are in the smallest currency unit (poisha for BDT):
//   30000 = BDT 300.00, 60000 = BDT 600.00
// NOTE: The request mentions "three plans" but only two were provided
// (3 months + 6 months). Only those two are implemented below. To add a
// third plan later, add one more entry here with its product + amount.
// ---------------------------------------------------------------------------
const CURRENCY = "bdt";
const MERCHANT_ACCOUNT_ID = (process.env.MERCHANT_ACCOUNT_ID || "acct_1Ika5JA3KZ32dPo1").trim();
const PLANS = {
  plan_3m: {
    id: "plan_3m",
    label: "X Premium Gift — 3 months",
    months: 3,
    amount: 30000,
    currency: CURRENCY,
    product: "prod_TJXJtpzqCpI36N",
  },
  plan_6m: {
    id: "plan_6m",
    label: "X Premium Gift — 6 months",
    months: 6,
    amount: 60000,
    currency: CURRENCY,
    product: "prod_TJXKKNJwZJIhCM",
  },
};

// X GraphQL operations (stable identifiers used by x.com itself).
const OPS = {
  identity: { name: "PremiumGiftingQuery", id: "kn8hCE6bHstQV2MtfYDTKg" },
  quote: { name: "useSubscriptionProductDetailsByRestIdQuery", id: "Se1Bp6zcNnuXYXRecV2qLA" },
  create: { name: "useOneTimePurchaseGiftMutation", id: "GqTVJ4S1526tLkxj69xIZw" },
};

function publicPlan(p) {
  return {
    id: p.id,
    label: p.label,
    months: p.months,
    amount: p.amount,
    currency: p.currency,
    // Human-readable display only; the charge uses `amount` above.
    displayAmount: formatAmount(p.amount, p.currency),
  };
}

function formatAmount(amount, currency) {
  const units = amount / 100;
  if (currency === "bdt") return `BDT ${units.toFixed(2)}`;
  return `${units.toFixed(2)} ${currency.toUpperCase()}`;
}

function cleanHandle(v) {
  return String(v || "").trim().replace(/^@/, "").toLowerCase();
}
function isValidHandle(h) {
  return /^[a-z0-9_]{1,15}$/.test(h);
}
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function xConfigured() {
  // Only the personal cookies are required; Authorization/User-Agent have
  // built-in public defaults (same for every X web client).
  return Boolean(X_AUTH_TOKEN && X_CT0 && X_AUTHORIZATION.startsWith("Bearer ") && X_USER_AGENT);
}
function xHeaders(user) {
  return {
    Authorization: X_AUTHORIZATION,
    "User-Agent": X_USER_AGENT,
    "Content-Type": "application/json",
    Origin: "https://x.com",
    Referer: `https://x.com/${user}/gift-premium`,
    "X-Twitter-Auth-Type": "OAuth2Session",
    "X-Twitter-Active-User": "yes",
    "X-Twitter-Client-Language": "en",
    "X-Csrf-Token": X_CT0,
    Cookie: `auth_token=${X_AUTH_TOKEN}; ct0=${X_CT0}`,
  };
}
async function xGet(user, op, variables, extraQuery) {
  const q = new URLSearchParams({ variables: JSON.stringify(variables) });
  if (extraQuery) for (const [k, v] of Object.entries(extraQuery)) q.set(k, v);
  const res = await fetch(
    `https://x.com/i/api/graphql/${op.id}/${op.name}?${q.toString()}`,
    { headers: xHeaders(user), signal: AbortSignal.timeout(30000) }
  );
  if (res.status !== 200) throw new Error(`X_HTTP_${res.status}`);
  const data = await res.json();
  if (data && data.errors && data.errors.length) throw new Error("X_REJECTED");
  return data;
}
async function xPost(user, op, variables) {
  const res = await fetch(`https://x.com/i/api/graphql/${op.id}/${op.name}`, {
    method: "POST",
    headers: xHeaders(user),
    body: JSON.stringify({ variables, queryId: op.id }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 200) throw new Error(`X_HTTP_${res.status}`);
  const data = await res.json();
  if (data && data.errors && data.errors.length) throw new Error("X_REJECTED");
  return data;
}
// The URL must be the official Stripe checkout page for exactly this session.
function isOfficialCheckoutUrl(link, id) {
  try {
    if (!/^cs_live_[A-Za-z0-9]+$/.test(id)) return false;
    const u = new URL(link);
    if (u.protocol !== "https:" || u.host !== "checkout.stripe.com" || u.search) return false;
    const m = u.pathname.match(/^\/[A-Za-z]\/pay\/(.+)$/);
    return !!m && m[1] === id;
  } catch {
    return false;
  }
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// Public plan list (no secrets, no product IDs, no merchant ID, no cookies).
app.get("/api/plans", (req, res) => {
  res.json({ currency: CURRENCY, plans: Object.values(PLANS).map(publicPlan) });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, configured: xConfigured() });
});

// Ask X to create the official gift checkout session and return its URL.
app.post("/api/create-checkout", async (req, res) => {
  try {
    const { planId, recipient } = req.body || {};

    const plan = PLANS[String(planId || "")];
    if (!plan) {
      return res.status(400).json({ error: "Please select a valid plan." });
    }

    const handle = cleanHandle(recipient);
    if (!isValidHandle(handle)) {
      return res
        .status(400)
        .json({ error: "Enter a valid X username (letters, numbers, _ — max 15 chars)." });
    }

    if (!xConfigured()) {
      return res.status(500).json({
        error:
          "Server is not configured: X cookies are missing. Put your auth_token and ct0 in .env (see .env.example).",
      });
    }

    // 1. Recipient identity + gift eligibility (read-only).
    let identity;
    try {
      identity = await xGet(handle, OPS.identity, { screenName: handle });
    } catch {
      return res.status(502).json({ error: "Could not reach X. Check connection and try again." });
    }
    const found = identity?.data?.user?.result;
    if (!found || !found.rest_id) {
      return res.status(404).json({ error: "Recipient was not found on X." });
    }
    if (String(found.core?.screen_name || "").toLowerCase() !== handle) {
      return res.status(400).json({ error: "Recipient identity could not be verified." });
    }
    if (!found.premium_gifting_eligible) {
      return res.status(400).json({ error: "This recipient cannot receive Premium gifts." });
    }
    const recipientId = found.rest_id;

    // 2. Regional price quote: X's price must exactly match our plan.
    let quote;
    try {
      quote = await xGet(handle, OPS.quote, { stripeId: plan.product }, {
        features: '{"subscriptions_marketing_page_fetch_promotions":true}',
      });
    } catch {
      return res.status(502).json({ error: "Could not verify the plan price with X. Try again." });
    }
    const product = quote?.data?.web_subscription_product_details_by_rest_id;
    const prices = product?.prices || [];
    if (product?.rest_id !== plan.product || prices.length !== 1) {
      return res.status(502).json({ error: "X returned an unexpected product or price list." });
    }
    const price = prices[0];
    if (
      price.price_type !== "OneTime" ||
      String(price.currency_code || "").toLowerCase() !== plan.currency ||
      Number(price.amount_local_micro) !== plan.amount * 10000
    ) {
      return res.status(400).json({ error: "Plan price does not match X's current price. Stopped." });
    }

    // 3. Ask X to create the gift checkout (mutation). X returns the session URL.
    let created;
    try {
      created = await xPost(handle, OPS.create, {
        cancel_url: `https://x.com/${handle}/gift-premium`,
        success_url: `https://x.com/${handle}/gift-premium/success`,
        external_product_id: plan.product,
        gift_recipient: recipientId,
      });
    } catch {
      return res.status(502).json({ error: "X did not create the checkout. Try again." });
    }
    const gift = created?.data?.onetimepurchase_gift || {};
    if (gift.session_status !== "Unpaid") {
      return res.status(502).json({ error: "X checkout is not in Unpaid state; no link generated." });
    }
    if (!isOfficialCheckoutUrl(gift.session_url, gift.session_id)) {
      return res.status(502).json({ error: "X returned an invalid checkout URL; no link generated." });
    }

    // Never log secrets, cookies, tokens, or full X responses.
    console.log(`checkout created: plan=${plan.id} months=${plan.months}`);
    return res.json({ url: gift.session_url });
  } catch {
    // Never leak API internals or secrets to the browser.
    console.error("checkout failed");
    return res.status(502).json({ error: "Could not create the checkout link. Try again." });
  }
});

app.listen(PORT, () => {
  console.log(`xpremium-gift-link running on http://localhost:${PORT}`);
  if (!xConfigured()) console.log("WARNING: X credentials are not set (see .env.example).");
});
