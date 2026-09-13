// RFC 6238 Appendix B test vectors.
//
// Run with: node --experimental-strip-types src/server/modules/auth/totp.test.mjs
import assert from "node:assert";
import { base32Encode, generateCode, verifyCode, currentCounter } from "./totp.ts";

const SEED_SHA1 = Buffer.from("12345678901234567890", "ascii");
const secret = base32Encode(SEED_SHA1);

// [unix time, expected 8-digit code] from RFC 6238, truncated to 6 digits.
const vectors = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

let failures = 0;
for (const [time, expected8] of vectors) {
  const counter = Math.floor(time / 30);
  const got = generateCode(secret, counter, "sha1", 8);
  const ok = got === expected8;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} t=${time} expected ${expected8} got ${got}`);
}

// A code from the current step must verify; one from far away must not.
const now = new Date();
const valid = generateCode(secret, currentCounter(now));
assert.equal(verifyCode(secret, valid, 1, now), true, "current code should verify");
console.log("  ✓ current code verifies");

const stale = generateCode(secret, currentCounter(now) - 10);
assert.equal(verifyCode(secret, stale, 1, now), false, "stale code must be rejected");
console.log("  ✓ stale code rejected");

// Drift of one step either way is tolerated.
for (const drift of [-1, 1]) {
  const c = generateCode(secret, currentCounter(now) + drift);
  assert.equal(verifyCode(secret, c, 1, now), true, `drift ${drift} should verify`);
}
console.log("  ✓ ±1 step drift tolerated");

assert.equal(verifyCode(secret, "abc123", 1, now), false);
assert.equal(verifyCode(secret, "12345", 1, now), false);
console.log("  ✓ malformed input rejected");

process.exit(failures === 0 ? 0 : 1);
