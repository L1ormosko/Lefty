/**
 * Session authentication.
 *
 * - password: bcrypt hash, cost 12
 * - session token: 256-bit random, sent to the browser, stored only as sha256
 * - cookie: HttpOnly, SameSite=Lax, Secure in production
 * - logout deletes the database row, so a stolen cookie dies with it
 */
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import type { Role, User } from "@prisma/client";
import { prisma } from "./db";
import { AuthError, ForbiddenError, ValidationError } from "./errors";
import { rateLimit } from "./rate-limit";

export const SESSION_COOKIE = "velto_session";
const SESSION_TTL_DAYS = 30;
const BCRYPT_ROUNDS = 12;
/** Compared against when the email is unknown, so response time does not leak existence. */
const DUMMY_HASH = "$2a$12$XpchPL3nySwoh1.kYvcny./L25yUxDnsJsV2f7cLyH.nu0Gf2i/fW";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  // Always run a comparison, even for an unknown user.
  const ok = await bcrypt.compare(plain, hash ?? DUMMY_HASH);
  return hash ? ok : false;
}

export type SessionUser = Pick<User, "id" | "email" | "name" | "role" | "companyId" | "phone">;

/** Create a session row and set the cookie. Returns the raw token (tests use it). */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
  await prisma.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user, or null. Safe to call from any server component. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive) return null;
  // Throttled sliding refresh: at most one write per hour per session.
  if (Date.now() - session.lastUsedAt.getTime() > 3_600_000) {
    await prisma.session.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });
  }
  const { id, email, name, role, companyId, phone } = session.user;
  return { id, email, name, role, companyId, phone };
}

/** Use at the top of every action/route that requires a signed-in user. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError();
  return user;
}

/** Use when a specific role is required. ADMIN passes every check. */
export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role === "ADMIN") return user;
  if (!roles.includes(user.role)) throw new ForbiddenError();
  return user;
}

export async function login(email: string, password: string, ipKey = "unknown"): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  const perIp = rateLimit(`login:ip:${ipKey}`, 20, 15 * 60_000);
  const perAccount = rateLimit(`login:acct:${normalized}`, 5, 15 * 60_000);
  if (!perIp.ok || !perAccount.ok) {
    throw new ValidationError("auth.tooManyAttempts");
  }

  const user = await prisma.user.findUnique({ where: { email: normalized } });
  const ok = await verifyPassword(password, user?.passwordHash ?? null);
  if (!user || !ok || !user.isActive) {
    throw new ValidationError("auth.invalidCredentials");
  }
  await createSession(user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    companyId: user.companyId,
    phone: user.phone,
  };
}

/** Constant-time string compare, used where a secret is compared outside bcrypt. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
