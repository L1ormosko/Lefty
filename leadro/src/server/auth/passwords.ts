import bcrypt from "bcryptjs";
import { ValidationError } from "@/server/core";
import { BCRYPT_COST, PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from "./config";

/**
 * Enforces the password policy: at least 12 characters, at most 72 bytes (bcrypt's limit), and
 * not simply the account's email address.
 * @throws ValidationError (field `password`) describing the first problem found.
 */
export function assertPasswordMeetsPolicy(password: string, email?: string): void {
  const fail = (message: string): never => {
    throw new ValidationError({ message, field: "password" });
  };
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    fail(`The password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
  if (Buffer.byteLength(password, "utf8") > PASSWORD_MAX_BYTES) {
    fail(`The password must be at most ${PASSWORD_MAX_BYTES} bytes long.`);
  }
  if (email && password.toLowerCase() === email.trim().toLowerCase()) {
    fail("The password must not be the same as the email address.");
  }
}

/** bcrypt hash at cost 12. Does not check policy: call `assertPasswordMeetsPolicy` first. */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

/** Constant-time bcrypt comparison. Never throws on a malformed hash; it just returns false. */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch {
    return false;
  }
}

let dummyHashPromise: Promise<string> | undefined;

/**
 * Spends the same CPU as a real password check. Login calls it when the tenant/user does not
 * exist (or cannot log in), so response time does not reveal whether an account exists (§22).
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword("not-a-real-account-password");
  await verifyPassword(password, await dummyHashPromise);
}
