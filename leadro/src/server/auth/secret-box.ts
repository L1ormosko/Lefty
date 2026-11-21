/**
 * AES-256-GCM encryption for secrets we must be able to read back (MFA TOTP seeds).
 * Passwords and tokens are hashed instead; they never go through here.
 *
 * Stored format: `v1:<iv>:<authTag>:<ciphertext>` (each part base64). The `v1` prefix leaves room
 * for key rotation later.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_ENV_VAR = "LEADRO_ENCRYPTION_KEY";
const IV_BYTES = 12; // the GCM standard nonce size
const FORMAT_VERSION = "v1";

/** Thrown when MFA features are used without a usable encryption key. Never carries key material. */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionKeyError";
  }
}

/**
 * Read lazily (not at import) so the app still boots and non-MFA features work without the key,
 * while every MFA code path fails closed instead of falling back to plaintext.
 */
function loadKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR];
  if (!raw) throw new EncryptionKeyError(`${KEY_ENV_VAR} is not set; MFA is unavailable.`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new EncryptionKeyError(`${KEY_ENV_VAR} must be 32 bytes, base64-encoded.`);
  }
  return key;
}

/** True when an encryption key is configured and valid. */
export function isEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/** Encrypts `plaintext`; every call uses a fresh random IV. */
export function encryptSecret(plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Decrypts a value from `encryptSecret`; throws if it was tampered with or the key differs. */
export function decryptSecret(stored: string): Buffer {
  const [version, iv, authTag, ciphertext] = stored.split(":");
  if (version !== FORMAT_VERSION || !iv || !authTag || !ciphertext) {
    throw new Error("Unrecognised encrypted secret format");
  }
  const decipher = createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
}
