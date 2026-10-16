// BunkCoin checkout — HTTP routes, Stripe integration, webhook fulfilment.
//
// Identity: { userId, orgId } (ULIDs) read from the verified session — see src/auth.js.
// Orders:   each purchase gets an order ULID, which ties together our order row,
//           the Stripe Checkout Session and the ledger credit.
//
// Flow (each step is logged with its number):
//   CHECKOUT  ① requested → ② priced → ③ order reserved → ④ Stripe customer → ⑤ session created & linked
//   (customer pays inside Stripe's iframe — nothing reaches this server)
//   WEBHOOK   ⑥ event received → ⑦ signature verified → ⑧ routed
//   FULFIL    ⑨ integrity checks → ⑩ ledger credit (exactly once) → ⑪ order fulfilled
//   STATUS    return page polls GET /api/checkout-sessions/:id until fulfilment = "fulfilled"
//
// Lines marked "PRODUCTION:" say what to change for the real 129Knots deployment.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { ApiError, badRequest, fromStripe, validationError } from "./errors.js";
import { money, short } from "./logger.js";
import { buildQuote, FieldError } from "./pricing.js";
import { LedgerError, OrderStatus } from "./store.js";
import { isUlid, ulid } from "./ulid.js";

const META_APP = "bunkcoin_checkout"; // tags our sessions; other Checkout traffic on the account is ignored
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const IDEM_KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const HANDLED_EVENTS = new Set([
  "checkout.session.completed", // customer finished checkout (paid, or delayed method pending)
  "checkout.session.async_payment_succeeded", // delayed method (bank debit) cleared
  "checkout.session.async_payment_failed", // delayed method bounced
  "checkout.session.expired", // nobody paid before expires_at
]);

/**
 * Builds the Express app. Dependencies are injected so tests can pass fakes.
 * @param {object} deps
 * @param {object} deps.cfg      validated config (src/config.js)
 * @param {object} deps.stripe   stripe-node client (secret key) — or a fake in tests
 * @param {object} deps.store    order store (PRODUCTION: Postgres)
 * @param {object} deps.ledger   BunkCoin ledger (PRODUCTION: your balance service)
 * @param {object} deps.auth     identity from the session (src/auth.js)
 * @param {Function} deps.log    logger (src/logger.js)
 */
export function createApp({ cfg, stripe, store, ledger, auth, log }) {
  const app = express();
  app.disable("x-powered-by");
  // PRODUCTION: behind an ALB/ingress set this to the number of proxy hops (e.g. 1)
  // so req.ip is the real client IP.
  app.set("trust proxy", false);

  // ── Request ID, security headers, access log ────────────────────────────────
  app.use((req, res, next) => {
    req.id = "req_" + crypto.randomBytes(6).toString("hex");
    res.set({
      "X-Request-Id": req.id,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY", // our page isn't framed; Stripe frames *inside* it
    });
    const start = Date.now();
    res.on("finish", () => {
      // Routine page reads are debug; writes and errors are shown.
      const routine = req.method === "GET" && res.statusCode < 400;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : routine ? "debug" : "info";
      log(level, `${req.method} ${req.path} → ${res.statusCode}`, { cat: "HTTP", ms: Date.now() - start, req: req.id });
    });
    next();
  });

  // ── Webhook FIRST: signature verification needs the raw, unparsed body ──────
  app.post("/webhooks/stripe", express.raw({ type: "*/*", limit: "64kb" }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get("stripe-signature") ?? "", cfg.webhookSecret);
    } catch (err) {
      log("error", "⑦ Webhook signature verification FAILED — rejected (400)", {
        cat: "WEBHOOK", reason: err.message, hint: "wrong STRIPE_WEBHOOK_SECRET, or body altered by a proxy", req: req.id });
      throw new ApiError(400, "invalid_webhook", "Webhook verification failed.");
    }
    log("info", `⑥ Webhook received: ${event.type}`, { cat: "WEBHOOK", event: event.id, req: req.id });
    log("debug", "⑦ Signature verified", { cat: "WEBHOOK", event: event.id });

    await handleEvent(event, req);
    res.json({ received: true });
  });

  // ── Identity for everything below ───────────────────────────────────────────
  app.use(auth.middleware);
  app.use("/api", express.json({ limit: "4kb", strict: true }));

  const requireAuth = (req, _res, next) => {
    if (!req.auth) {
      log("warn", "Rejected: no valid session", { cat: "AUTH", path: req.path, req: req.id });
      throw new ApiError(401, "not_signed_in", "Please sign in to 129Knots to continue.");
    }
    next();
  };

  // ── Public config for the page ──────────────────────────────────────────────
  app.get("/api/config", (_req, res) => {
    res.set("Cache-Control", "no-store").json({
      publishable_key: cfg.publishableKey,
      currency: cfg.currency,
      unit_amount: cfg.unitAmount,
      min_quantity: cfg.minQty,
      max_quantity: cfg.maxQty,
      packages: cfg.packages,
    });
  });

  // ── Session identity + balance ──────────────────────────────────────────────
  app.get("/api/me", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.auth) return res.json({ signed_in: false });
    res.json({
      signed_in: true,
      user_id: req.auth.userId,
      org_id: req.auth.orgId,
      // PRODUCTION: read from your balance service.
      balance: await ledger.balance(req.auth.orgId),
    });
  });

  // ── Purchase history for the session's organisation ────────────────────────
  app.get("/api/orders", requireAuth, async (req, res) => {
    const orders = await store.listByOrg(req.auth.orgId, 10);
    res.set("Cache-Control", "no-store").json({
      orders: orders.map((o) => ({
        order_id: o.orderId, quantity: o.quantity, total: o.total, currency: o.currency,
        status: o.status, created_at: o.createdAt, credited_at: o.creditedAt,
      })),
    });
  });

  // ── ①–⑤ Create a Checkout Session ───────────────────────────────────────────
  app.post("/api/checkout-sessions", requireAuth, rateLimit({ limit: 20, windowMs: 60_000 }), async (req, res) => {
    const { userId, orgId } = req.auth;
    const ctx = { cat: "CHECKOUT", org: orgId, user: userId, req: req.id };

    if (!req.is("application/json")) throw new ApiError(415, "unsupported_media_type", "Send JSON.");
    log("info", "① Checkout requested", { ...ctx, choice: JSON.stringify(req.body) });

    // ② Price it on the server. The browser only ever sends a choice — never an amount or an account.
    let quote;
    try {
      quote = buildQuote(cfg, req.body);
    } catch (err) {
      if (err instanceof FieldError) {
        log("warn", "② Validation failed", { ...ctx, field: err.field, reason: err.message });
        throw validationError(err);
      }
      if (err.code === "unknown_field") throw badRequest("unknown_field", err.message);
      throw err;
    }
    log("info", "② Priced the order", { ...ctx, package: quote.packageId, qty: quote.quantity,
      unit: money(quote.unitAmount, quote.currency), total: money(quote.total, quote.currency) });

    // Idempotency key = browser's key + who + what. Same click retried → same key.
    let clientKey = req.get("Idempotency-Key");
    if (clientKey && !IDEM_KEY_RE.test(clientKey)) {
      throw badRequest("invalid_idempotency_key", "Idempotency-Key must be 8–100 letters, digits, '-' or '_'.");
    }
    clientKey ||= "srv_" + crypto.randomUUID();
    const basket = crypto.createHash("sha256")
      .update(JSON.stringify([orgId, userId, quote.packageId, quote.quantity, quote.unitAmount, quote.currency]))
      .digest("hex").slice(0, 16);
    const idempotencyKey = `bkc-${clientKey}-${basket}`;

    // ③ Reserve the order BEFORE calling Stripe. A retry with the same key reuses the
    //    same order — and the same order_id and expires_at — so the Stripe request is
    //    byte-for-byte identical, which Stripe's idempotency requires.
    let order = await store.findByIdempotencyKey(idempotencyKey);
    if (order) {
      log("info", "③ Retry of an earlier attempt — reusing order", { ...ctx, order: order.orderId });
    } else {
      order = await store.create({
        orderId: ulid(), orgId, userId, packageId: quote.packageId, quantity: quote.quantity,
        unitAmount: quote.unitAmount, total: quote.total, currency: quote.currency,
        status: OrderStatus.PENDING, idempotencyKey,
        expiresAt: Math.floor(Date.now() / 1000) + cfg.sessionTtlMinutes * 60,
      });
      log("info", "③ Order reserved → pending", { ...ctx, order: order.orderId });
    }
    ctx.order = order.orderId;

    // ④ One Stripe Customer per organisation: payments group under the org in the Dashboard.
    const customerId = await getOrCreateStripeCustomer(orgId, ctx);

    // Metadata = OUR identifiers stored on Stripe's objects. Not shown to the customer;
    // it comes back in the webhook so we know which order to fulfil and whom to credit.
    // Only ULIDs and numbers — no names or emails (limits: 50 keys, 500 chars per value).
    const metadata = {
      app: META_APP,
      order_id: order.orderId,
      org_id: orgId,
      user_id: userId,
      package_id: quote.packageId,
      quantity: String(quote.quantity),
      unit_amount: String(quote.unitAmount),
    };

    // ⑤ Create the session.
    let session;
    const t0 = Date.now();
    try {
      session = await stripe.checkout.sessions.create(
        {
          ui_mode: "embedded_page", // Stripe's form renders inside our page (iframe)
          mode: "payment", // one-time payment
          customer: customerId,
          client_reference_id: order.orderId, // Stripe's field for "your id for this purchase"
          submit_type: "pay",
          return_url: `${cfg.publicBaseUrl}/return.html?session_id={CHECKOUT_SESSION_ID}`,
          expires_at: order.expiresAt,
          // What the customer SEES in the form (Stripe computes amount = quantity × unit_amount):
          line_items: [{
            quantity: quote.quantity,
            price_data: {
              currency: quote.currency,
              unit_amount: quote.unitAmount,
              product_data: { name: "BunkCoin", description: "129Knots platform credits", unit_label: "coin" },
            },
          }],
          metadata,
          // Same identifiers on the PaymentIntent, so they show on the payment itself
          // (Dashboard → Payments) and in payment_intent.* / charge.* events.
          payment_intent_data: {
            description: `BunkCoin order ${order.orderId}`,
            metadata: { app: META_APP, order_id: order.orderId, org_id: orgId, user_id: userId, quantity: String(quote.quantity) },
          },
          // No payment_method_types: removed in 2026-09-30.endive. Methods come from
          // Dashboard → Settings → Payment methods (use allowed_payment_method_types to restrict).
        },
        { idempotencyKey },
      );
    } catch (err) {
      const e = fromStripe(err);
      log("error", "⑤ Stripe refused to create the session", { cat: "STRIPE", order: order.orderId, ms: Date.now() - t0,
        code: e.code, stripe_type: err.type, stripe_code: err.code, stripe_param: err.param, stripe_req: err.requestId,
        reason: err.message, req: req.id });
      throw e; // the reserved order stays pending without a session; a retry reuses it
    }
    if (!session?.client_secret) {
      throw new ApiError(502, "payment_setup_failed", "We couldn't start the payment. Please try again later.");
    }

    // Link our order to the session. PRODUCTION: UPDATE bunkcoin_orders SET stripe_session_id=$2 WHERE order_id=$1.
    await store.update(order.orderId, { sessionId: session.id, stripeCustomerId: customerId });
    log("info", "⑤ Session created & linked to order", { cat: "STRIPE", order: order.orderId, session: short(session.id),
      ms: Date.now() - t0, expires: new Date(order.expiresAt * 1000).toISOString().slice(11, 16) + " UTC", req: req.id });

    res.status(201).set("Cache-Control", "no-store").json({
      order_id: order.orderId,
      session_id: session.id,
      client_secret: session.client_secret, // lets Stripe.js open THIS session in the browser
      quote: { package_id: quote.packageId, quantity: quote.quantity, unit_amount: quote.unitAmount,
        total: quote.total, currency: quote.currency },
    });
  });

  // ── Return-page status: payment (from Stripe) + fulfilment (from our order) ─
  app.get("/api/checkout-sessions/:id", requireAuth, async (req, res) => {
    const { id } = req.params;
    if (!SESSION_ID_RE.test(id)) throw badRequest("invalid_session_id", "That checkout link looks invalid.");

    let s;
    try {
      s = await stripe.checkout.sessions.retrieve(id); // Stripe answers "was it paid?"
    } catch (err) {
      throw fromStripe(err);
    }
    // Only our sessions, and only the session's own organisation.
    if (s.metadata?.app !== META_APP || s.metadata?.org_id !== req.auth.orgId) {
      log("warn", "Status lookup for a session of another organisation — hidden (404)", {
        cat: "STATUS", session: short(id), org: req.auth.orgId, req: req.id });
      throw new ApiError(404, "not_found", "We couldn't find that checkout session.");
    }

    const order = await store.get(s.metadata.order_id); // WE answer "was it credited?"
    const fulfilment = order?.status ?? "unknown";
    log("info", `Return page check: payment=${s.payment_status}, fulfilment=${fulfilment}`, {
      cat: "STATUS", order: s.metadata.order_id, org: req.auth.orgId });

    res.set("Cache-Control", "no-store").json({
      order_id: s.metadata.order_id,
      status: s.status, // open | complete | expired
      payment_status: s.payment_status, // paid | unpaid | no_payment_required
      fulfilment, // pending | awaiting_payment | credit_retrying | fulfilled | needs_review | ...
      quantity: Number(s.metadata.quantity) || 0,
      amount_total: s.amount_total,
      currency: s.currency,
      customer_email: s.customer_details?.email ?? "", // typed by the payer in Stripe's form; shown only to them
      balance_after: order?.balanceAfter ?? null,
    });
  });

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/api", () => {
    throw new ApiError(404, "not_found", "Unknown API endpoint.");
  });
  app.use(express.static(WEB_DIR, { extensions: ["html"], index: "index.html" }));

  // ── Central error handler (Express 5 forwards rejected async handlers here) ─
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = err;
    if (!(e instanceof ApiError)) {
      if (err.type === "entity.parse.failed") e = badRequest("malformed_json", "Request body isn't valid JSON.");
      else if (err.type === "entity.too.large") e = new ApiError(413, "body_too_large", "Request is too large.");
      else {
        e = new ApiError(500, "internal_error", "Something went wrong on our side. Please try again later.", { cause: err });
        log("error", "Unexpected error", { cat: "SYSTEM", reason: err.message, stack: err.stack, req: req.id });
      }
    }
    if (res.headersSent) return;
    res.status(e.status).set("Cache-Control", "no-store").json({
      error: { code: e.code, message: e.message, retryable: e.retryable, request_id: req.id,
        ...(e.fields ? { fields: e.fields } : {}) },
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  Helpers
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Stripe Customer for an organisation, created on its first purchase. Holds only
   * the org ULID — no name or email.
   * PRODUCTION: store stripe_customer_id on your organisations table.
   */
  async function getOrCreateStripeCustomer(orgId, ctx) {
    const cached = await store.getStripeCustomerId(orgId);
    if (cached) {
      log("info", "④ Using the organisation's Stripe customer", { ...ctx, customer: cached });
      return cached;
    }
    try {
      const c = await stripe.customers.create(
        { description: `129Knots organisation ${orgId}`, metadata: { app: META_APP, org_id: orgId } },
        { idempotencyKey: `bkc-cust-${orgId}` },
      );
      await store.setStripeCustomerId(orgId, c.id);
      log("info", "④ Created Stripe customer for organisation (first purchase)", { ...ctx, customer: c.id });
      return c.id;
    } catch (err) {
      const e = fromStripe(err);
      log("error", "④ Could not create Stripe customer", { cat: "STRIPE", org: orgId, code: e.code, reason: err.message });
      throw e;
    }
  }

  // ── ⑧ Route webhook events ─────────────────────────────────────────────────
  async function handleEvent(event, req) {
    const ctx = { cat: "WEBHOOK", event: event.id, req: req.id };
    if (!HANDLED_EVENTS.has(event.type)) {
      log("info", `⑧ Ignored: we don't handle ${event.type} (acknowledged 200)`, ctx);
      return;
    }
    const s = event.data.object;
    if (s?.metadata?.app !== META_APP) {
      log("info", "⑧ Ignored: session belongs to another integration", { ...ctx, session: short(s?.id) });
      return;
    }
    const orderId = s.metadata.order_id;
    Object.assign(ctx, { order: orderId, org: s.metadata.org_id });

    switch (event.type) {
      case "checkout.session.completed":
        if (s.payment_status !== "paid") {
          // e.g. bank debit: checkout finished but money hasn't cleared. Wait for async_payment_*.
          log("info", "⑧ Checkout completed but payment NOT yet cleared → awaiting_payment", { ...ctx, payment_status: s.payment_status });
          await store.update(orderId, { ...orderFieldsFromSession(s), status: OrderStatus.AWAITING_PAYMENT });
          return;
        }
        log("info", "⑧ Payment confirmed (paid) → fulfilling", ctx);
        return fulfil(s, ctx);

      case "checkout.session.async_payment_succeeded":
        log("info", "⑧ Delayed payment cleared → fulfilling", ctx);
        return fulfil(s, ctx);

      case "checkout.session.async_payment_failed":
        log("warn", "⑧ Delayed payment FAILED → no coins", ctx);
        // PRODUCTION: notify the organisation's admins with a link to try again.
        await store.update(orderId, { ...orderFieldsFromSession(s), status: OrderStatus.PAYMENT_FAILED });
        return;

      case "checkout.session.expired":
        log("info", "⑧ Checkout expired unpaid", ctx);
        await store.update(orderId, { ...orderFieldsFromSession(s), status: OrderStatus.EXPIRED });
        return;
    }
  }

  // ── ⑨–⑪ Credit BunkCoin ─────────────────────────────────────────────────────
  //
  // Outcomes and how we answer Stripe:
  //   credited / already credited          → 200 (done)
  //   permanent problem (bad metadata,     → 200 + needs_review + ALERT log
  //     amount mismatch, account rejected)    (retrying can never fix it; a human
  //                                            must credit manually or refund)
  //   temporary problem (ledger down)      → 500 + credit_retrying
  //                                          (Stripe retries with backoff for up to 3 days)
  async function fulfil(s, ctxIn) {
    const ctx = { ...ctxIn, cat: "FULFIL" };

    // ⑨ Integrity checks: what Stripe charged and recorded vs. what we priced.
    const { order, problem } = orderFromSession(s);
    if (problem) {
      if (isUlid(order.orderId)) {
        await store.update(order.orderId, { ...order, status: OrderStatus.NEEDS_REVIEW, failureReason: problem });
      }
      log("error", "⑨ ALERT: paid but NOT credited — failed integrity check, needs manual review", {
        ...ctx, session: short(s.id), problem, action: "verify in Stripe Dashboard, then credit manually or refund" });
      return;
    }
    log("info", "⑨ Integrity checks passed", { ...ctx, qty: order.quantity,
      check: `${order.quantity} × ${order.unitAmount} = ${s.amount_subtotal}`, total: money(order.total, order.currency) });

    // ⑩ Credit exactly once: store.fulfil() serialises deliveries per order and skips
    //    if already fulfilled; the ledger is also idempotent by order id.
    let result;
    try {
      result = await store.fulfil(order, async (o) => {
        log("info", "⑩ Crediting ledger…", { ...ctx, qty: o.quantity });
        const entry = await ledger.credit(o.orgId, o.quantity, o.orderId);
        log("info", `⑩ Credited ${o.quantity} BunkCoin`, { cat: "LEDGER", org: o.orgId, order: o.orderId,
          balance: `${entry.balanceBefore ?? "?"} → ${entry.balanceAfter}`,
          ...(entry.duplicate ? { note: "ledger already had this order" } : {}) });
        return entry;
      });
    } catch (err) {
      if (err instanceof LedgerError && err.permanent) {
        await store.update(order.orderId, { ...order, status: OrderStatus.NEEDS_REVIEW, failureReason: err.code });
        log("error", "⑩ ALERT: paid but ledger REJECTED the credit permanently — needs manual review", {
          ...ctx, reason: err.code, detail: err.message, action: "fix the account then credit manually, or refund" });
        return; // 200: Stripe retrying won't help
      }
      const prev = await store.get(order.orderId);
      const attempts = (prev?.attempts ?? 0) + 1;
      await store.update(order.orderId, { ...order, status: OrderStatus.CREDIT_RETRYING,
        failureReason: err.code ?? "credit_failed", attempts });
      log("error", `⑩ Temporary failure crediting (attempt ${attempts}) → 500, Stripe will retry`, { ...ctx, reason: err.message });
      // PRODUCTION: alert if attempts > N or the order has been credit_retrying for > 1 hour.
      throw new ApiError(500, "fulfilment_failed", "Fulfilment failed; Stripe will retry.", { retryable: true, cause: err });
    }

    if (result.alreadyDone) log("info", "⑪ Duplicate delivery — already fulfilled, nothing to do", ctx);
    else log("info", "⑪ Order fulfilled ✓", { ...ctx, balance_after: result.order.balanceAfter });
  }

  return app;
}

/** Order fields rebuilt from Stripe's copy of our metadata (works even if our store lost the row). */
function orderFieldsFromSession(s) {
  const m = s.metadata ?? {};
  return {
    orderId: m.order_id, orgId: m.org_id, userId: m.user_id, packageId: m.package_id,
    quantity: Number(m.quantity), unitAmount: Number(m.unit_amount), total: s.amount_total,
    currency: s.currency, sessionId: s.id,
  };
}

/** Rebuilds the order and runs the integrity checks. Returns { order, problem? }. */
export function orderFromSession(s) {
  const order = orderFieldsFromSession(s);
  const { orderId, orgId, userId, quantity: qty, unitAmount: unit } = order;
  if (!isUlid(orderId)) return { order, problem: `missing/invalid order_id in metadata (${orderId})` };
  if (!isUlid(orgId)) return { order, problem: `missing/invalid org_id in metadata (${orgId})` };
  if (userId && !isUlid(userId)) return { order, problem: `invalid user_id in metadata (${userId})` };
  if (s.client_reference_id !== orderId) {
    return { order, problem: `client_reference_id (${s.client_reference_id}) ≠ metadata.order_id (${orderId})` };
  }
  if (!Number.isSafeInteger(qty) || qty <= 0 || !Number.isSafeInteger(unit) || unit <= 0) {
    return { order, problem: `invalid quantity/unit_amount in metadata (${s.metadata?.quantity} × ${s.metadata?.unit_amount})` };
  }
  if (s.amount_subtotal !== qty * unit) {
    return { order, problem: `amount mismatch: charged subtotal ${s.amount_subtotal} ≠ ${qty} × ${unit}` };
  }
  return { order };
}

/** Small fixed-window limiter, keyed per organisation (falls back to IP). PRODUCTION: WAF / Redis. */
function rateLimit({ limit, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.auth?.orgId ?? req.ip;
    const now = Date.now();
    let b = hits.get(key);
    if (!b || now > b.reset) {
      if (hits.size > 10_000) hits.clear();
      b = { count: 0, reset: now + windowMs };
      hits.set(key, b);
    }
    if (++b.count > limit) {
      res.set("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      throw new ApiError(429, "rate_limited", "Too many attempts. Please wait a minute and try again.", { retryable: true });
    }
    next();
  };
}
