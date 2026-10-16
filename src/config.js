// Loads and validates configuration once at startup. Fails fast on mistakes
// instead of failing on the first customer.

import crypto from "node:crypto";
import { isUlid } from "./ulid.js";

export const STRIPE_MAX_AMOUNT = 99_999_999; // Stripe's per-payment cap in minor units

const DEFAULT_PACKAGES = [
  { id: "starter", quantity: 100, label: "Starter" },
  { id: "standard", quantity: 500, label: "Standard", popular: true },
  { id: "pro", quantity: 1000, label: "Pro" },
  { id: "fleet", quantity: 5000, label: "Fleet" },
];

export function loadConfig(env = process.env) {
  const errors = [];
  const str = (k, def = "") => (env[k] ?? "").trim() || def;
  const int = (k, def) => {
    const v = str(k);
    if (v === "") return def;
    if (!/^-?\d+$/.test(v)) {
      errors.push(`${k} must be an integer, got "${v}"`);
      return def;
    }
    return Number(v);
  };

  const cfg = {
    port: int("PORT", 4242),
    publicBaseUrl: str("PUBLIC_BASE_URL", "http://localhost:4242").replace(/\/+$/, ""),
    stripeSecretKey: str("STRIPE_SECRET_KEY"),
    publishableKey: str("STRIPE_PUBLISHABLE_KEY"),
    webhookSecret: str("STRIPE_WEBHOOK_SECRET"),
    currency: str("BUNKCOIN_CURRENCY", "usd").toLowerCase(),
    unitAmount: int("BUNKCOIN_UNIT_AMOUNT", 100),
    minQty: int("BUNKCOIN_MIN_QTY", 10),
    maxQty: int("BUNKCOIN_MAX_QTY", 100000),
    sessionTtlMinutes: int("CHECKOUT_SESSION_TTL_MINUTES", 30),
    packages: DEFAULT_PACKAGES,
    authMode: str("AUTH_MODE", "dev").toLowerCase(),
    authSecret: str("AUTH_SECRET"),
    // Dev session identity — stands in for the logged-in platform user and their organisation.
    devIdentity: {
      userId: str("DEV_USER_ID", "01JA2Y7K3V9QF6M8N4P5R0S1TW").toUpperCase(),
      orgId: str("DEV_ORG_ID", "01JA2Y6H8D4C2B0Z9X7W5V3T1R").toUpperCase(),
    },
  };

  if (!["dev", "jwt"].includes(cfg.authMode)) errors.push(`AUTH_MODE must be "dev" or "jwt", got "${cfg.authMode}"`);
  if (cfg.authMode === "dev" && cfg.stripeSecretKey.includes("_live_")) {
    errors.push("AUTH_MODE=dev (automatic demo session) is not allowed with live Stripe keys");
  }
  if (cfg.authMode === "dev" && (!isUlid(cfg.devIdentity.userId) || !isUlid(cfg.devIdentity.orgId))) {
    errors.push("DEV_USER_ID and DEV_ORG_ID must be valid ULIDs (26 chars, Crockford base32)");
  }
  if (cfg.authMode === "jwt" && cfg.authSecret.length < 32) {
    errors.push("AUTH_SECRET must be at least 32 characters when AUTH_MODE=jwt (it must match your auth service's signing secret)");
  }
  if (cfg.authMode === "dev" && !cfg.authSecret) {
    // Fine for local testing: the dev session just restarts when the server restarts.
    cfg.authSecret = crypto.randomBytes(32).toString("hex");
  }

  if (!cfg.stripeSecretKey) errors.push("STRIPE_SECRET_KEY is required");
  else if (!/^(sk|rk)_/.test(cfg.stripeSecretKey)) errors.push("STRIPE_SECRET_KEY must start with sk_ or rk_");
  if (!cfg.publishableKey.startsWith("pk_")) errors.push("STRIPE_PUBLISHABLE_KEY is required and must start with pk_");
  if (cfg.stripeSecretKey && cfg.publishableKey &&
      cfg.stripeSecretKey.includes("_live_") !== cfg.publishableKey.includes("_live_")) {
    errors.push("secret and publishable keys are from different modes (test vs live)");
  }
  if (!cfg.webhookSecret) errors.push("STRIPE_WEBHOOK_SECRET is required (run `stripe listen` locally to get one)");
  if (!/^[a-z]{3}$/.test(cfg.currency)) errors.push(`BUNKCOIN_CURRENCY "${cfg.currency}" must be a 3-letter ISO code`);
  if (cfg.unitAmount <= 0) errors.push("BUNKCOIN_UNIT_AMOUNT must be > 0");
  if (cfg.minQty <= 0 || cfg.maxQty < cfg.minQty) errors.push("need 0 < BUNKCOIN_MIN_QTY <= BUNKCOIN_MAX_QTY");
  if (cfg.unitAmount > 0 && cfg.maxQty * cfg.unitAmount > STRIPE_MAX_AMOUNT) {
    errors.push(`BUNKCOIN_MAX_QTY × BUNKCOIN_UNIT_AMOUNT exceeds Stripe's per-payment cap of ${STRIPE_MAX_AMOUNT} minor units`);
  }
  if (cfg.sessionTtlMinutes < 30 || cfg.sessionTtlMinutes > 1440) errors.push("CHECKOUT_SESSION_TTL_MINUTES must be between 30 and 1440");

  if (errors.length) {
    const err = new Error("Invalid configuration:\n  - " + errors.join("\n  - "));
    err.configErrors = errors;
    throw err;
  }
  return cfg;
}
