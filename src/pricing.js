import { STRIPE_MAX_AMOUNT } from "./config.js";

export class FieldError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

const ALLOWED_FIELDS = new Set(["package_id", "quantity"]); // who is buying comes from login, not the body

/**
 * Validates what the browser sent and prices it. The browser sends a *choice*
 * (package or quantity), never a price — amounts are only calculated here.
 */
export function buildQuote(cfg, body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new FieldError("package_id", "Choose how much BunkCoin you need.");
  }
  const unknown = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k));
  if (unknown.length) {
    const e = new Error("Request contains an unsupported field.");
    e.code = "unknown_field";
    throw e;
  }

  const { package_id: packageId, quantity } = body;
  const hasPkg = packageId !== undefined && packageId !== null && packageId !== "";
  const hasQty = quantity !== undefined && quantity !== null;
  let pkgId, qty;

  if (hasPkg && hasQty) throw new FieldError("package_id", "Choose a package or a custom amount, not both.");

  if (hasPkg) {
    const p = typeof packageId === "string" && cfg.packages.find((x) => x.id === packageId);
    if (!p) throw new FieldError("package_id", "That package is no longer available. Please pick another.");
    pkgId = p.id;
    qty = p.quantity;
  } else if (hasQty) {
    if (typeof quantity !== "number" || !Number.isSafeInteger(quantity)) {
      throw new FieldError("quantity", "Must be a whole number.");
    }
    if (quantity < cfg.minQty) throw new FieldError("quantity", `Minimum purchase is ${cfg.minQty} BunkCoin.`);
    if (quantity > cfg.maxQty) {
      throw new FieldError("quantity", `Maximum purchase is ${cfg.maxQty} BunkCoin. Contact us for larger orders.`);
    }
    pkgId = "custom";
    qty = quantity;
  } else {
    throw new FieldError("package_id", "Choose how much BunkCoin you need.");
  }

  if (qty > Math.floor(STRIPE_MAX_AMOUNT / cfg.unitAmount)) {
    throw new FieldError("quantity", "That amount is above the per-payment limit.");
  }

  return {
    packageId: pkgId,
    quantity: qty,
    unitAmount: cfg.unitAmount,
    total: qty * cfg.unitAmount,
    currency: cfg.currency,
  };
}
