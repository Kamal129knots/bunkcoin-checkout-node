// Readable logs for every step of a purchase.
//
// LOG_FORMAT=pretty (default with test keys) → one coloured line per step:
//   18:21:04.120  CHECKOUT   ② Priced the order   org=01JA2Y6H… qty=500 total=US$500.00
// LOG_FORMAT=json (default with live keys)    → one JSON object per line for CloudWatch / Datadog / Loki.
//
// PRODUCTION: keep LOG_FORMAT=json, ship stdout to your log platform, and alert on
// level=error with cat=FULFIL (paid-but-not-credited) and cat=WEBHOOK (signature failures).

const COLORS = { HTTP: 90, AUTH: 35, CHECKOUT: 36, STRIPE: 34, WEBHOOK: 33, FULFIL: 32, LEDGER: 92, STATUS: 37, SYSTEM: 97 };
const LEVEL_MARK = { debug: " ", info: " ", warn: "⚠", error: "✖" };
const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEYS = /secret|password|token|authorization|cookie|card/i;

export function createLogger({ format = "pretty", minLevel = "info" } = {}) {
  /**
   * log(level, msg, fields) — fields.cat sets the category column (CHECKOUT, WEBHOOK, FULFIL, …).
   * Empty fields are dropped; anything that looks like a secret is redacted.
   */
  function log(level, msg, fields = {}) {
    if (ORDER[level] < ORDER[minLevel]) return;
    const { cat = "SYSTEM", ...rest } = fields;
    const clean = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null || v === "") continue;
      clean[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
    }
    const out = level === "error" ? console.error : console.log;

    if (format === "json") {
      out(JSON.stringify({ time: new Date().toISOString(), level, cat, msg, ...clean }));
      return;
    }
    const now = new Date();
    const t = `${now.toLocaleTimeString("en-GB", { hour12: false })}.${String(now.getMilliseconds()).padStart(3, "0")}`;
    const lvl = level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : "";
    const kv = Object.entries(clean)
      .filter(([k]) => k !== "stack")
      .map(([k, v]) => `\x1b[2m${k}=\x1b[0m${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    out(`\x1b[2m${t}\x1b[0m  \x1b[${COLORS[cat] ?? 37}m${cat.padEnd(8)}\x1b[0m ${lvl}${LEVEL_MARK[level]} ${msg}\x1b[0m${kv ? "   " + kv : ""}`);
    if (clean.stack && level === "error") console.error(`\x1b[2m${clean.stack}\x1b[0m`);
  }
  return log;
}

/** "US$500.00" style formatting for logs (minor units → display). */
export function money(minor, currency) {
  try {
    const fmt = new Intl.NumberFormat("en-SG", { style: "currency", currency: currency.toUpperCase() });
    return fmt.format(minor / 10 ** fmt.resolvedOptions().maximumFractionDigits);
  } catch {
    return `${minor} ${currency}`;
  }
}

/** Short Stripe ids keep log lines readable: cs_test_a1B2c3d4e5f6… → cs_test_…e5f6 */
export const short = (id) => (typeof id === "string" && id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);
