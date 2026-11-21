/**
 * RFC 6238 time-based one-time passwords (and the RFC 4226 HOTP they build on), implemented with
 * `node:crypto` so MFA needs no extra dependency. Pure: no Prisma, no Next.
 *
 * Defaults match what authenticator apps expect: HMAC-SHA1, 6 digits, 30 second steps.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step too, to tolerate clock drift between phone and server. */
export const TOTP_ALLOWED_DRIFT_STEPS = 1;

/** RFC 4648 base32 without padding (the format authenticator apps import). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Inverse of `base32Encode`. Ignores spaces/padding and is case-insensitive; throws on other characters. */
export function base32Decode(text: string): Buffer {
  const cleaned = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret (the size RFC 4226 recommends for HMAC-SHA1). */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** RFC 4226 HOTP: the code for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(counterBytes).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** The time step (counter) that contains `atMs`. */
export function totpTimeStep(atMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(atMs / 1000 / stepSeconds);
}

/** The code an authenticator app shows at `atMs`. */
export function generateTotp(secret: Buffer, atMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpTimeStep(atMs), digits);
}

/**
 * Checks `code` against the steps around `atMs`.
 * @returns the matching time step (so callers can refuse to accept it twice), or null.
 */
export function verifyTotp(secret: Buffer, code: string, atMs: number, digits = TOTP_DIGITS): number | null {
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const currentStep = totpTimeStep(atMs);
  const submitted = Buffer.from(code);
  let matchedStep: number | null = null;
  // Check every step (no early exit) so timing does not reveal which step was close.
  for (let drift = -TOTP_ALLOWED_DRIFT_STEPS; drift <= TOTP_ALLOWED_DRIFT_STEPS; drift++) {
    const expected = Buffer.from(hotp(secret, currentStep + drift, digits));
    if (timingSafeEqual(expected, submitted)) matchedStep = currentStep + drift;
  }
  return matchedStep;
}

/** `otpauth://` URI that authenticator apps read from a QR code. */
export function buildOtpauthUri(params: { issuer: string; account: string; secret: Buffer }): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const query = new URLSearchParams({
    secret: base32Encode(params.secret),
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
