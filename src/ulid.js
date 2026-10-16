// ULID — Universally Unique Lexicographically Sortable Identifier (https://github.com/ulid/spec)
//   01JAB3K7Z9Q4M2X8V5N6P0R1ST
//   └─time (10)─┘└─random (16)─┘   26 chars, Crockford base32, sorts by creation time.
//
// Used for user ids, organisation ids and order ids. In production, users and
// organisations come from the 129Knots platform (already ULIDs); order ids are
// minted here when a purchase starts.

import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford: no I, L, O, U
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function ulid(now = Date.now()) {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
  return time + rand;
}

export const isUlid = (v) => typeof v === "string" && ULID_RE.test(v);

/** Creation time encoded in a ULID (handy when reading logs). */
export function ulidTime(id) {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return new Date(t);
}
