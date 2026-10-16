// Orders + BunkCoin ledger — in memory for local development only.
//
// PRODUCTION
//   Orders → Postgres table bunkcoin_orders (see README), primary key order_id (ULID),
//            unique indexes on stripe_session_id and idempotency_key.
//   Ledger → your BunkCoin balance service; credit() must be idempotent by reference.

export const OrderStatus = Object.freeze({
  PENDING: "pending", // order reserved / checkout open, not paid yet
  AWAITING_PAYMENT: "awaiting_payment", // completed with a delayed method (bank debit), not cleared yet
  CREDIT_RETRYING: "credit_retrying", // paid, crediting failed temporarily — Stripe retries the webhook
  FULFILLED: "fulfilled", // paid and BunkCoin credited
  NEEDS_REVIEW: "needs_review", // paid, but crediting can never succeed automatically — a human must act
  PAYMENT_FAILED: "payment_failed", // delayed payment failed
  EXPIRED: "expired", // checkout expired unpaid
});

/**
 * Order shape:
 * { orderId, orgId, userId, packageId, quantity, unitAmount, total, currency,
 *   status, idempotencyKey, expiresAt, sessionId?, stripeCustomerId?,
 *   failureReason?, attempts?, balanceAfter?, createdAt, creditedAt?, updatedAt }
 */
export class MemoryOrderStore {
  #orders = new Map(); // orderId → order
  #bySession = new Map(); // stripe session id → orderId
  #byIdem = new Map(); // idempotency key → orderId
  #locks = new Map(); // orderId → promise chain (per-order mutex)
  #stripeCustomers = new Map(); // orgId → Stripe customer id

  /** SQL: INSERT INTO bunkcoin_orders (...) VALUES (...) */
  async create(order) {
    const o = { ...order, createdAt: order.createdAt ?? new Date(), updatedAt: new Date() };
    this.#orders.set(o.orderId, o);
    if (o.idempotencyKey) this.#byIdem.set(o.idempotencyKey, o.orderId);
    if (o.sessionId) this.#bySession.set(o.sessionId, o.orderId);
    return o;
  }

  async get(orderId) {
    return this.#orders.get(orderId) ?? null;
  }

  /** SQL: SELECT … WHERE idempotency_key = $1 — lets a retried request reuse the same order. */
  async findByIdempotencyKey(key) {
    const id = this.#byIdem.get(key);
    return id ? this.#orders.get(id) : null;
  }

  async findBySession(sessionId) {
    const id = this.#bySession.get(sessionId);
    return id ? this.#orders.get(id) : null;
  }

  /**
   * SQL: UPDATE … SET … WHERE order_id = $1 AND status <> 'fulfilled'
   * Creates the row if missing (e.g. our store lost it but Stripe's metadata has it).
   * Never downgrades a fulfilled order.
   */
  async update(orderId, fields) {
    const cur = this.#orders.get(orderId) ?? { orderId, createdAt: new Date() };
    if (cur.status === OrderStatus.FULFILLED) return cur;
    const next = { ...cur, ...fields, updatedAt: new Date() };
    this.#orders.set(orderId, next);
    if (next.sessionId) this.#bySession.set(next.sessionId, orderId);
    return next;
  }

  /**
   * Runs `credit` exactly once per order, even when Stripe delivers the same event
   * several times or concurrently. If `credit` throws, the order is NOT marked
   * fulfilled, so a later webhook retry can try again.
   *
   * SQL (one transaction):
   *   UPDATE bunkcoin_orders SET status='fulfilled', credited_at=now()
   *    WHERE order_id=$1 AND status<>'fulfilled' RETURNING *;   -- 0 rows → already done
   *   …credit the ledger… COMMIT;  (ROLLBACK if the credit fails)
   */
  async fulfil(order, credit) {
    const prev = this.#locks.get(order.orderId) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    this.#locks.set(order.orderId, prev.then(() => mine));
    await prev;
    try {
      const cur = this.#orders.get(order.orderId);
      if (cur?.status === OrderStatus.FULFILLED) return { alreadyDone: true, order: cur };
      const entry = await credit(order);
      const done = { ...cur, ...order, createdAt: cur?.createdAt ?? new Date(), status: OrderStatus.FULFILLED, balanceAfter: entry?.balanceAfter,
        failureReason: undefined, creditedAt: new Date(), updatedAt: new Date() };
      this.#orders.set(order.orderId, done);
      if (done.sessionId) this.#bySession.set(done.sessionId, done.orderId);
      return { alreadyDone: false, order: done };
    } finally {
      release();
    }
  }

  /** Most recent orders for one organisation (purchase history). Hides orders that never reached Stripe. */
  async listByOrg(orgId, limit = 10) {
    return [...this.#orders.values()]
      .filter((o) => o.orgId === orgId && o.sessionId)
      .sort((a, b) => b.orderId.localeCompare(a.orderId)) // ULIDs sort by creation time
      .slice(0, limit);
  }

  /** PRODUCTION: organisations.stripe_customer_id */
  async getStripeCustomerId(orgId) {
    return this.#stripeCustomers.get(orgId) ?? null;
  }

  async setStripeCustomerId(orgId, customerId) {
    this.#stripeCustomers.set(orgId, customerId);
  }
}

/**
 * Ledger errors carry `permanent`:
 *   permanent: true  → retrying never helps (account unknown/suspended) → needs_review
 *   permanent: false → temporary (service down, timeout) → 500, Stripe retries
 */
export class LedgerError extends Error {
  constructor(message, { permanent, code }) {
    super(message);
    this.permanent = permanent;
    this.code = code;
  }
}

/**
 * In-memory BunkCoin ledger with balances. Credits are idempotent by `reference`
 * (the order ULID), so even a bug elsewhere can't double-credit.
 */
export class MemoryLedger {
  #balances = new Map();
  #byReference = new Map();
  /** Test hook: "off" | "temporary" | "permanent" */
  failureMode = "off";

  async balance(orgId) {
    return this.#balances.get(orgId) ?? 0;
  }

  async credit(orgId, quantity, reference) {
    if (this.failureMode === "temporary") {
      throw new LedgerError("Ledger service unavailable (simulated)", { permanent: false, code: "ledger_unavailable" });
    }
    if (this.failureMode === "permanent") {
      throw new LedgerError("Ledger rejected the credit (simulated)", { permanent: true, code: "ledger_rejected" });
    }
    if (!orgId) throw new LedgerError("No organisation on the order", { permanent: true, code: "no_account" });

    const existing = this.#byReference.get(reference);
    if (existing) return { ...existing, duplicate: true };

    const balanceBefore = this.#balances.get(orgId) ?? 0;
    const balanceAfter = balanceBefore + quantity;
    this.#balances.set(orgId, balanceAfter);
    const entry = { orgId, quantity, reference, balanceBefore, balanceAfter, at: new Date() };
    this.#byReference.set(reference, entry);
    return entry;
  }
}
