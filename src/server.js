// Entry point. Stripe API version: 2026-09-30.endive (pinned by stripe-node 23).
import Stripe from "stripe";
import { createApp } from "./app.js";
import { createAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { MemoryLedger, MemoryOrderStore } from "./store.js";

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(err.message);
  console.error("\nCopy .env.example to .env and fill in your Stripe test keys.");
  process.exit(1);
}

const live = cfg.stripeSecretKey.includes("_live_");
const log = createLogger({
  format: process.env.LOG_FORMAT ?? (live ? "json" : "pretty"),
  minLevel: process.env.LOG_LEVEL ?? "info",
});

const stripe = new Stripe(cfg.stripeSecretKey, {
  maxNetworkRetries: 2, // safe: every create call carries an idempotency key
  timeout: 20_000,
  appInfo: { name: "bunkcoin-checkout", version: "2.1.0" },
});

const auth = createAuth({
  mode: cfg.authMode,
  secret: cfg.authSecret,
  devIdentity: cfg.devIdentity,
  secureCookies: cfg.publicBaseUrl.startsWith("https://"),
  log,
});

// PRODUCTION: replace both with real implementations:
//   store  → Postgres (bunkcoin_orders + organisations.stripe_customer_id)
//   ledger → your BunkCoin balance service (credit must be idempotent by order id)
const store = new MemoryOrderStore();
const ledger = new MemoryLedger();

const app = createApp({ cfg, stripe, store, ledger, auth, log });

const server = app.listen(cfg.port, () => {
  log("info", `BunkCoin checkout running → http://localhost:${cfg.port}`, {
    cat: "SYSTEM", stripe_api: Stripe.API_VERSION, mode: live ? "LIVE" : "test", auth: cfg.authMode,
    price: `${cfg.unitAmount} ${cfg.currency}/coin` });
  if (cfg.authMode === "dev") {
    log("info", "Dev session identity", { cat: "SYSTEM", user: cfg.devIdentity.userId, org: cfg.devIdentity.orgId });
    log("info", "Orders and balances are in memory — restarting clears them", { cat: "SYSTEM" });
  }
});
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;

const shutdown = (sig) => {
  log("info", `${sig} received, shutting down`, { cat: "SYSTEM" });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
  server.closeAllConnections?.();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (err) =>
  log("error", "unhandledRejection", { cat: "SYSTEM", reason: String(err?.message ?? err), stack: err?.stack }));
