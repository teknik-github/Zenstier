import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP.
 *
 * Written against the spec rather than pulled in as a dependency: the
 * algorithm is small and fully specified, and it is verified here against the
 * official RFC test vectors (see totp.test.ts), which is stronger evidence
 * than a package's popularity.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** Accepts the neighbouring steps, covering ordinary clock drift. */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateCode(
  secret: string,
  counter: number,
  algorithm: "sha1" | "sha256" | "sha512" = "sha1",
  digits: number = DIGITS,
): string {
  const key = base32Decode(secret);

  // Counter as a big-endian 64-bit value.
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, key).update(message).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

export function currentCounter(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
}

/**
 * Verifies a submitted code.
 *
 * Comparison is constant-time: a timing oracle on a six-digit code is a real
 * shortcut for an attacker who can make many attempts.
 */
export function verifyCode(
  secret: string,
  submitted: string,
  window: number = DEFAULT_WINDOW,
  at: Date = new Date(),
): boolean {
  const cleaned = submitted.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;

  const counter = currentCounter(at);
  for (let drift = -window; drift <= window; drift++) {
    const expected = generateCode(secret, counter + drift);
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** The otpauth:// URI an authenticator app scans. */
export function otpauthUri(
  secret: string,
  accountName: string,
  issuer = "Zenstier",
): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery codes, for a lost authenticator. */
export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
