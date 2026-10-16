import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Stripe from "stripe";
import { createApp, orderFromSession } from "../src/app.js";
import { createAuth, signJwt, verifyJwt } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { buildQuote, FieldError } from "../src/pricing.js";
import { MemoryLedger, MemoryOrderStore, OrderStatus } from "../src/store.js";
import { isUlid, ulid } from "../src/ulid.js";

const WHSEC = "whsec_test_secret";
const JWT_SECRET = "j".repeat(40);
const realStripe = new Stripe("sk_test_dummy"); // only for webhook signing/verification
const quiet = () => {};

const ORG_A = "01JA2Y6H8D4C2B0Z9X7W5V3T1R";
const USER_A = "01JA2Y7K3V9QF6M8N4P5R0S1TW";
const ORG_B = "01JA30AAAAAAAAAAAAAAAAAAAA";
const USER_B = "01JA30BBBBBBBBBBBBBBBBBBBB";

const cfg = loadConfig({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC });
const tokenFor = (sub, org_id) => signJwt({ sub, org_id, exp: Math.floor(Date.now() / 1000) + 600 }, JWT_SECRET);

// ---------- fake Stripe (enforces idempotency like the real API) ----------
function fakeStripe() {
  const byIdem = new Map();
  const f = {
    err: null, created: [], retrieved: null, customersCreated: 0,
    webhooks: realStripe.webhooks,
    customers: {
      async create(params) {
        if (f.err) throw f.err;
        f.customersCreated++;
        return { id: `cus_fake_${params.metadata.org_id.slice(-4)}` };
      },
    },
    checkout: { sessions: {
      async create(params, opts) {
        if (f.err) throw f.err;
        f.created.push({ params, opts });
        const prev = byIdem.get(opts.idempotencyKey);
        if (prev) {
          // Real Stripe rejects a reused key whose parameters differ.
          if (JSON.stringify(prev.params) !== JSON.stringify(params)) {
            throw new Stripe.errors.StripeIdempotencyError({ message: "Keys for idempotent requests can only be used with the same parameters" });
          }
          return prev.session;
        }
        const session = { id: `cs_test_fake${String(byIdem.size + 1).padStart(10, "0")}`, client_secret: "cs_secret_x", metadata: params.metadata };
        byIdem.set(opts.idempotencyKey, { params, session });
        return session;
      },
      async retrieve() {
        if (f.err) throw f.err;
        return f.retrieved;
      },
    } },
  };
  return f;
}

async function startApp({ authMode = "jwt" } = {}) {
  const stripe = fakeStripe();
  const store = new MemoryOrderStore();
  const ledger = new MemoryLedger();
  const auth = createAuth({ mode: authMode, secret: JWT_SECRET, devIdentity: { userId: USER_A, orgId: ORG_A } });
  const app = createApp({ cfg, stripe, store, ledger, auth, log: quiet });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = tokenFor(USER_A, ORG_A);
  let cookie = "";
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token && authMode === "jwt" ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  };
  const as = (userId, orgId) => { token = userId ? tokenFor(userId, orgId) : null; };
  return { stripe, store, ledger, call, as, close: () => server.close() };
}

// ---------- unit ----------
describe("ulid", () => {
  it("generates valid, time-sortable ids", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.ok(isUlid(a) && isUlid(b));
    assert.ok(a < b);
  });
  it("rejects non-ULIDs", () => {
    for (const v of ["org_pacific", "", "01JA2Y6H8D4C2B0Z9X7W5V3T1", "01JA2Y6H8D4C2B0Z9X7W5V3T1I", 123]) assert.equal(isUlid(v), false);
  });
});

describe("config", () => {
  it("fails fast listing every problem", () => assert.throws(() => loadConfig({}), (e) => e.configErrors.length === 3));
  it("refuses the dev session with live keys", () => {
    assert.throws(() => loadConfig({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x", STRIPE_WEBHOOK_SECRET: "w" }), /live/);
  });
  it("requires ULIDs for the dev identity", () => {
    assert.throws(() => loadConfig({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "w", DEV_ORG_ID: "org_pacific" }), /ULID/);
  });
  it("requires a strong AUTH_SECRET in jwt mode", () => {
    assert.throws(() => loadConfig({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PUBLISHABLE_KEY: "pk_test_x",
      STRIPE_WEBHOOK_SECRET: "w", AUTH_MODE: "jwt", AUTH_SECRET: "short" }), /AUTH_SECRET/);
  });
});

describe("buildQuote", () => {
  it("prices a package and a custom amount", () => {
    assert.equal(buildQuote(cfg, { package_id: "pro" }).total, 100000);
    assert.equal(buildQuote(cfg, { quantity: 2500 }).total, 250000);
  });
  for (const [name, body, field] of [
    ["below min", { quantity: 9 }, "quantity"], ["above max", { quantity: 100001 }, "quantity"],
    ["fractional", { quantity: 10.5 }, "quantity"], ["string", { quantity: "100" }, "quantity"],
    ["unknown pkg", { package_id: "gold" }, "package_id"], ["both", { package_id: "pro", quantity: 50 }, "package_id"],
    ["neither", {}, "package_id"],
  ]) {
    it(`rejects ${name}`, () => assert.throws(() => buildQuote(cfg, body), (e) => e instanceof FieldError && e.field === field));
  }
  it("rejects a client-supplied price or organisation", () => {
    assert.throws(() => buildQuote(cfg, { quantity: 100, amount: 1 }), /unsupported field/);
    assert.throws(() => buildQuote(cfg, { quantity: 100, org_id: ORG_B }), /unsupported field/);
  });
});

describe("JWT", () => {
  const claims = { sub: USER_A, org_id: ORG_A, exp: Math.floor(Date.now() / 1000) + 60 };
  it("accepts a valid token", () => assert.equal(verifyJwt(signJwt(claims, JWT_SECRET), JWT_SECRET).org_id, ORG_A));
  it("rejects wrong secret, expiry, tampering and alg=none", () => {
    assert.equal(verifyJwt(signJwt(claims, JWT_SECRET), "x".repeat(40)), null);
    assert.equal(verifyJwt(signJwt({ ...claims, exp: 1 }, JWT_SECRET), JWT_SECRET), null);
    const [h, , s] = signJwt(claims, JWT_SECRET).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims, org_id: ORG_B })).toString("base64url");
    assert.equal(verifyJwt(`${h}.${forged}.${s}`, JWT_SECRET), null);
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    assert.equal(verifyJwt(`${none}.${forged}.`, JWT_SECRET), null);
  });
});

describe("orderFromSession integrity", () => {
  const OID = ulid();
  const base = { id: "cs_1", amount_subtotal: 50000, amount_total: 50000, currency: "usd", client_reference_id: OID,
    metadata: { order_id: OID, org_id: ORG_A, user_id: USER_A, quantity: "500", unit_amount: "100" } };
  it("passes a consistent session", () => assert.equal(orderFromSession(base).problem, undefined));
  it("flags amount mismatch", () => assert.match(orderFromSession({ ...base, amount_subtotal: 1 }).problem, /amount mismatch/));
  it("flags reference mismatch", () => assert.match(orderFromSession({ ...base, client_reference_id: ulid() }).problem, /client_reference_id/));
  it("flags non-ULID org", () => assert.match(orderFromSession({ ...base, metadata: { ...base.metadata, org_id: "org_x" } }).problem, /org_id/));
  it("flags missing order", () => assert.match(orderFromSession({ ...base, metadata: { ...base.metadata, order_id: undefined } }).problem, /order_id/));
});

// ---------- identity ----------
describe("identity from the session", () => {
  it("dev mode issues a session cookie with the ULID identity", async () => {
    const t = await startApp({ authMode: "dev" });
    const first = await t.call("GET", "/api/me");
    assert.match(first.headers.get("set-cookie") ?? "", /bkc_session=.*HttpOnly/i);
    const me = (await t.call("GET", "/api/me")).json;
    t.close();
    assert.deepEqual({ s: me.signed_in, u: me.user_id, o: me.org_id }, { s: true, u: USER_A, o: ORG_A });
    assert.equal(me.name, undefined);
  });
  it("jwt mode: no token → 401 on checkout; /api/me says signed out", async () => {
    const t = await startApp();
    t.as(null);
    assert.equal((await t.call("GET", "/api/me")).json.signed_in, false);
    const r = await t.call("POST", "/api/checkout-sessions", { package_id: "pro" });
    t.close();
    assert.equal(r.status, 401);
  });
  it("jwt mode: token with non-ULID ids is rejected", async () => {
    const t = await startApp();
    t.as("user_1", "org_1");
    const r = await t.call("POST", "/api/checkout-sessions", { package_id: "pro" });
    t.close();
    assert.equal(r.status, 401);
  });
});

// ---------- checkout ----------
describe("POST /api/checkout-sessions", () => {
  it("reserves an order and passes ULID metadata to Stripe (no names)", async () => {
    const t = await startApp();
    const r = await t.call("POST", "/api/checkout-sessions", { quantity: 2500 }, { "Idempotency-Key": "key-aaaaaaaa" });
    t.close();
    assert.equal(r.status, 201);
    assert.ok(isUlid(r.json.order_id));
    const { params } = t.stripe.created.at(-1);
    assert.equal(params.ui_mode, "embedded_page");
    assert.equal(params.client_reference_id, r.json.order_id);
    assert.deepEqual(params.metadata, { app: "bunkcoin_checkout", order_id: r.json.order_id, org_id: ORG_A, user_id: USER_A,
      package_id: "custom", quantity: "2500", unit_amount: "100" });
    assert.equal(params.payment_intent_data.metadata.order_id, r.json.order_id);
    assert.equal(params.line_items[0].quantity, 2500);
    assert.equal(params.customer_email, undefined);
    assert.equal(params.payment_method_types, undefined);
    const o = await t.store.get(r.json.order_id);
    assert.equal(o.status, OrderStatus.PENDING);
    assert.equal(o.sessionId, r.json.session_id);
  });

  it("retry with the same key reuses the order and sends identical params to Stripe", async () => {
    const t = await startApp();
    const h = { "Idempotency-Key": "retry-key-123456" };
    const a = await t.call("POST", "/api/checkout-sessions", { package_id: "pro" }, h);
    await new Promise((r) => setTimeout(r, 1100)); // a second later: expires_at must NOT change
    const b = await t.call("POST", "/api/checkout-sessions", { package_id: "pro" }, h);
    t.close();
    assert.equal(b.status, 201, JSON.stringify(b.json));
    assert.equal(a.json.session_id, b.json.session_id);
    assert.equal(a.json.order_id, b.json.order_id);
  });

  it("reuses the organisation's Stripe customer", async () => {
    const t = await startApp();
    await t.call("POST", "/api/checkout-sessions", { package_id: "pro" });
    await t.call("POST", "/api/checkout-sessions", { package_id: "starter" });
    t.close();
    assert.equal(t.stripe.customersCreated, 1);
  });

  for (const [name, body, hdr, status, code] of [
    ["malformed", '{"quantity":', {}, 400, "malformed_json"],
    ["unknown field", { quantity: 100, amount: 1 }, {}, 400, "unknown_field"],
    ["too small", { quantity: 1 }, {}, 422, "validation_failed"],
    ["bad idem key", { package_id: "pro" }, { "Idempotency-Key": "x" }, 400, "invalid_idempotency_key"],
    ["wrong content type", '{"package_id":"pro"}', { "Content-Type": "text/plain" }, 415, "unsupported_media_type"],
    ["too large", { package_id: "a".repeat(5000) }, {}, 413, "body_too_large"],
  ]) {
    it(`rejects ${name}`, async () => {
      const t = await startApp();
      const r = await t.call("POST", "/api/checkout-sessions", body, hdr);
      t.close();
      assert.equal(r.status, status, JSON.stringify(r.json));
      assert.equal(r.json.error.code, code);
    });
  }
});

describe("Stripe error mapping", () => {
  const E = Stripe.errors;
  for (const [name, err, status, code, retryable] of [
    ["rate limit", new E.StripeRateLimitError({ message: "x" }), 429, "rate_limited", true],
    ["bad key", new E.StripeAuthenticationError({ message: "Invalid API Key sk_test_***" }), 500, "payments_misconfigured", false],
    ["our bug", new E.StripeInvalidRequestError({ message: "Invalid line_items", param: "line_items" }), 502, "payment_setup_failed", false],
    ["stripe 500", new E.StripeAPIError({ message: "boom" }), 502, "payment_provider_error", true],
    ["network", new E.StripeConnectionError({ message: "ETIMEDOUT" }), 503, "payment_provider_unavailable", true],
  ]) {
    it(name, async () => {
      const t = await startApp();
      t.stripe.err = err;
      const r = await t.call("POST", "/api/checkout-sessions", { package_id: "pro" });
      t.close();
      assert.equal(r.status, status);
      assert.equal(r.json.error.code, code);
      assert.equal(r.json.error.retryable, retryable);
      assert.doesNotMatch(JSON.stringify(r.json), /line_items|sk_test/);
    });
  }
});

describe("GET /api/checkout-sessions/:id", () => {
  const sess = (org) => ({ id: "cs_test_abcdefghijk", status: "complete", payment_status: "paid", amount_total: 50000,
    currency: "usd", metadata: { app: "bunkcoin_checkout", order_id: ulid(), org_id: org, quantity: "500" } });

  it("returns status for the session's own organisation", async () => {
    const t = await startApp();
    t.stripe.retrieved = sess(ORG_A);
    const r = await t.call("GET", "/api/checkout-sessions/cs_test_abcdefghijk");
    t.close();
    assert.equal(r.status, 200);
    assert.equal(r.json.quantity, 500);
  });
  it("hides another organisation's session (404)", async () => {
    const t = await startApp();
    t.stripe.retrieved = sess(ORG_B);
    const r = await t.call("GET", "/api/checkout-sessions/cs_test_abcdefghijk");
    t.close();
    assert.equal(r.status, 404);
  });
  it("rejects malformed ids", async () => {
    const t = await startApp();
    const r = await t.call("GET", "/api/checkout-sessions/pi_123");
    t.close();
    assert.equal(r.status, 400);
  });
});

// ---------- webhook / fulfilment ----------
let seq = 0;
function signed(type, object) {
  const payload = JSON.stringify({ id: `evt_${++seq}`, object: "event", api_version: Stripe.API_VERSION, type, data: { object } });
  return { payload, sig: realStripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
}
function paidSession({ orderId = ulid(), org = ORG_A, qty = 500, subtotal = qty * 100, paymentStatus = "paid", id = `cs_test_${orderId}` } = {}) {
  return {
    id, object: "checkout.session", status: "complete", payment_status: paymentStatus, client_reference_id: orderId,
    amount_subtotal: subtotal, amount_total: subtotal, currency: "usd",
    metadata: { app: "bunkcoin_checkout", order_id: orderId, org_id: org, user_id: USER_A, package_id: "standard",
      quantity: String(qty), unit_amount: "100" },
  };
}
const post = (t, { payload, sig }) => t.call("POST", "/webhooks/stripe", payload, { "Stripe-Signature": sig });

describe("webhook fulfilment", () => {
  it("credits the right organisation exactly once under concurrent duplicates", async () => {
    const t = await startApp();
    const s = paidSession();
    const ev = signed("checkout.session.completed", s);
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(t, ev)));
    t.close();
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(await t.ledger.balance(ORG_A), 500);
    assert.equal(await t.ledger.balance(ORG_B), 0);
    const o = await t.store.get(s.metadata.order_id);
    assert.equal(o.status, OrderStatus.FULFILLED);
    assert.equal(o.balanceAfter, 500);
  });

  it("rejects a forged signature", async () => {
    const t = await startApp();
    const { payload } = signed("checkout.session.completed", paidSession());
    const r = await post(t, { payload, sig: "t=1,v1=deadbeef" });
    t.close();
    assert.equal(r.status, 400);
    assert.equal(await t.ledger.balance(ORG_A), 0);
  });

  it("waits for async_payment_succeeded on delayed methods", async () => {
    const t = await startApp();
    const orderId = ulid();
    await post(t, signed("checkout.session.completed", paidSession({ orderId, paymentStatus: "unpaid" })));
    assert.equal((await t.store.get(orderId)).status, OrderStatus.AWAITING_PAYMENT);
    await post(t, signed("checkout.session.async_payment_succeeded", paidSession({ orderId })));
    t.close();
    assert.equal(await t.ledger.balance(ORG_A), 500);
  });

  it("temporary ledger failure → 500 + credit_retrying, then succeeds on retry", async () => {
    const t = await startApp();
    const orderId = ulid();
    const ev = signed("checkout.session.completed", paidSession({ orderId, qty: 100 }));
    t.ledger.failureMode = "temporary";
    assert.equal((await post(t, ev)).status, 500);
    const mid = await t.store.get(orderId);
    assert.equal(mid.status, OrderStatus.CREDIT_RETRYING);
    assert.equal(mid.attempts, 1);
    t.ledger.failureMode = "off";
    assert.equal((await post(t, ev)).status, 200);
    t.close();
    assert.equal((await t.store.get(orderId)).status, OrderStatus.FULFILLED);
    assert.equal(await t.ledger.balance(ORG_A), 100);
  });

  it("ledger rejects permanently → 200 + needs_review, no credit", async () => {
    const t = await startApp();
    const orderId = ulid();
    t.ledger.failureMode = "permanent";
    const r = await post(t, signed("checkout.session.completed", paidSession({ orderId, qty: 100 })));
    t.close();
    assert.equal(r.status, 200);
    const o = await t.store.get(orderId);
    assert.equal(o.status, OrderStatus.NEEDS_REVIEW);
    assert.equal(o.failureReason, "ledger_rejected");
  });

  it("amount mismatch → 200 + needs_review, no credit", async () => {
    const t = await startApp();
    const orderId = ulid();
    const r = await post(t, signed("checkout.session.completed", paidSession({ orderId, qty: 5000, subtotal: 100 })));
    t.close();
    assert.equal(r.status, 200);
    assert.equal((await t.store.get(orderId)).status, OrderStatus.NEEDS_REVIEW);
    assert.equal(await t.ledger.balance(ORG_A), 0);
  });

  it("expired and failed sessions are recorded", async () => {
    const t = await startApp();
    const e = ulid(), f = ulid();
    await post(t, signed("checkout.session.expired", { ...paidSession({ orderId: e }), status: "expired", payment_status: "unpaid" }));
    await post(t, signed("checkout.session.async_payment_failed", paidSession({ orderId: f, paymentStatus: "unpaid" })));
    t.close();
    assert.equal((await t.store.get(e)).status, OrderStatus.EXPIRED);
    assert.equal((await t.store.get(f)).status, OrderStatus.PAYMENT_FAILED);
  });

  it("ignores other integrations and unhandled events", async () => {
    const t = await startApp();
    const other = { ...paidSession(), metadata: { app: "else" } };
    assert.equal((await post(t, signed("checkout.session.completed", other))).status, 200);
    assert.equal((await post(t, signed("customer.created", { id: "cus_1" }))).status, 200);
    t.close();
    assert.equal(await t.ledger.balance(ORG_A), 0);
  });

  it("end to end: checkout → webhook → history shows credited, per organisation", async () => {
    const t = await startApp();
    const r = await t.call("POST", "/api/checkout-sessions", { package_id: "standard" });
    const orderId = r.json.order_id;
    await post(t, signed("checkout.session.completed", paidSession({ orderId, id: r.json.session_id })));
    const mine = (await t.call("GET", "/api/orders")).json.orders;
    const me = (await t.call("GET", "/api/me")).json;
    t.as(USER_B, ORG_B);
    const theirs = (await t.call("GET", "/api/orders")).json.orders;
    t.close();
    assert.equal(mine.length, 1);
    assert.equal(mine[0].order_id, orderId);
    assert.equal(mine[0].status, OrderStatus.FULFILLED);
    assert.equal(me.balance, 500);
    assert.equal(theirs.length, 0);
  });
});
