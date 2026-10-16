// Who is buying? Identity is ALWAYS read from a session the server can verify
// (signed cookie or signed JWT) — never from the request body.
//
// Identity = { userId, orgId }, both ULIDs. No names, no emails: the purchase
// flow doesn't need them, and keeping them out means no personal data in
// Stripe metadata or logs.
//
// AUTH_MODE=dev → local demo: the first request gets a signed session cookie for
//                 DEV_USER_ID / DEV_ORG_ID, exactly like a logged-in platform user.
//                 Refused when using live Stripe keys.
// AUTH_MODE=jwt → production: verify the HS256 JWT issued by the 129Knots auth
//                 service (Authorization: Bearer <token>, or cookie "bkc_token").
//                 Required claims: sub (user ULID), org_id (org ULID), exp.

import crypto from "node:crypto";
import { isUlid } from "./ulid.js";

const DEV_COOKIE = "bkc_session";
const JWT_COOKIE = "bkc_token";
const DEV_SESSION_TTL_S = 8 * 3600;

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest();
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Verifies an HS256 JWT. Returns its claims, or null if invalid/expired. */
export function verifyJwt(token, secret, now = Date.now()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url"));
    claims = JSON.parse(Buffer.from(p, "base64url"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null; // never accept "none" or other algorithms
  if (!safeEqual(Buffer.from(s, "base64url"), hmac(secret, `${h}.${p}`))) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < now) return null;
  return claims;
}

/** Issues an HS256 JWT — used by tests; production tokens come from the auth service. */
export function signJwt(claims, secret) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${b64url(hmac(secret, `${h}.${p}`))}`;
}

/** Only accepts well-formed ULIDs, so nothing else can reach metadata or the ledger. */
function toIdentity(userId, orgId) {
  return isUlid(userId) && isUlid(orgId) ? { userId, orgId } : null;
}

export function createAuth({ mode, secret, devIdentity, secureCookies = false, log = () => {} }) {
  const sign = (payload) => `${payload}.${b64url(hmac(secret, payload))}`;

  function readDevSession(value) {
    const [payload, sig] = String(value ?? "").split(".");
    if (!payload || !sig || !safeEqual(Buffer.from(sig, "base64url"), hmac(secret, payload))) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url"));
      if (data.exp * 1000 < Date.now()) return null;
      return toIdentity(data.sub, data.org_id);
    } catch {
      return null;
    }
  }

  function issueDevSession(res) {
    const payload = b64url(JSON.stringify({
      sub: devIdentity.userId, org_id: devIdentity.orgId, exp: Math.floor(Date.now() / 1000) + DEV_SESSION_TTL_S,
    }));
    res.cookie(DEV_COOKIE, sign(payload), {
      httpOnly: true, sameSite: "lax", secure: secureCookies, maxAge: DEV_SESSION_TTL_S * 1000, path: "/",
    });
    return { ...devIdentity };
  }

  return {
    mode,

    /** Express middleware: sets req.auth = { userId, orgId } or null. Never rejects by itself. */
    middleware(req, res, next) {
      const cookies = parseCookies(req.headers.cookie);
      if (mode === "dev") {
        req.auth = readDevSession(cookies[DEV_COOKIE]);
        if (!req.auth) {
          req.auth = issueDevSession(res);
          log("info", "Session started (dev)", { cat: "AUTH", user: req.auth.userId, org: req.auth.orgId });
        }
      } else {
        const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1];
        const c = verifyJwt(bearer ?? cookies[JWT_COOKIE], secret);
        req.auth = c ? toIdentity(c.sub, c.org_id) : null;
      }
      next();
    },
  };
}
