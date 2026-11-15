// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) and RFC 4648 base32, Node built-ins only.
import { createHmac, randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(randomBytes(20));
}

/** HOTP (RFC 4226) for a raw secret and an integer counter. */
export function hotp(secret, counter, digits = DIGITS, algorithm = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (unixSeconds) => Math.floor(unixSeconds / STEP_SECONDS);

/** The code an authenticator shows at `unixSeconds`. */
export function codeAt(secret, unixSeconds, digits = DIGITS) {
  return hotp(secret, stepOf(unixSeconds), digits);
}

/**
 * Check `code` within +-`skew` steps. Returns the matched step or undefined.
 * `afterStep` is the last accepted step: that step or an earlier one is refused
 * even inside the window (replay guard). Every candidate is compared; no early
 * exit on a match.
 */
export function verifyCode(secret, code, unixSeconds, { skew = 1, afterStep } = {}) {
  const digits = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return undefined;
  const now = stepOf(unixSeconds);
  let matched;
  for (let step = now - skew; step <= now + skew; step++) {
    const want = hotp(secret, step);
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ digits.charCodeAt(i);
    if (diff === 0 && matched === undefined) matched = step;
  }
  if (matched === undefined) return undefined;
  if (afterStep !== undefined && matched <= afterStep) return undefined;
  return matched;
}

export function otpauthUri(issuer, account, secretB32) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
