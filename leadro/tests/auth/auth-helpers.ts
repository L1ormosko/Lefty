import { randomBytes } from "node:crypto";
import { beforeEach } from "vitest";
import { withTenant } from "@/server/db";
import {
  hashPassword,
  login,
  resetAuthNotifier,
  resetRateLimits,
  type ClientInfo,
  type LoginResult,
} from "@/server/auth";
import { createTenant } from "../helpers";

export const TEST_PASSWORD = "correct horse battery staple";

/** A valid AES-256 key for tests, set before any MFA code runs (read lazily by secret-box). */
export function useTestEncryptionKey(): void {
  process.env.LEADRO_ENCRYPTION_KEY = randomBytes(32).toString("base64");
}

/** Every test starts with empty rate-limit counters and the default notifier. */
export function resetAuthTestState(): void {
  beforeEach(() => {
    resetRateLimits();
    resetAuthNotifier();
  });
}

let sharedHash: Promise<string> | undefined;
/** bcrypt at cost 12 is slow on purpose; hash the shared test password once per process. */
export function testPasswordHash(): Promise<string> {
  sharedHash ??= hashPassword(TEST_PASSWORD);
  return sharedHash;
}

let emailCounter = 0;
export const uniqueEmail = (label = "user") => `${label}-${Date.now().toString(36)}-${++emailCounter}@example.test`;

export const testClient = (overrides: Partial<ClientInfo> = {}): ClientInfo => ({
  sourceApp: "API",
  ipAddress: `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
  ...overrides,
});

export interface TestUser {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  email: string;
}

/** Creates an ACTIVE user with `TEST_PASSWORD` in an existing tenant. */
export async function createActiveUser(
  tenant: { id: string; slug: string },
  options: { email?: string; status?: "ACTIVE" | "INVITED" | "DEACTIVATED" } = {},
): Promise<TestUser> {
  const email = options.email ?? uniqueEmail();
  const passwordHash = await testPasswordHash();
  const user = await withTenant(tenant.id, (tx) =>
    tx.user.create({
      data: { tenantId: tenant.id, email, passwordHash, status: options.status ?? "ACTIVE" },
      select: { id: true },
    }),
  );
  return { tenantId: tenant.id, tenantSlug: tenant.slug, userId: user.id, email };
}

/** A fresh tenant with one active user. */
export async function createTenantWithUser(): Promise<TestUser> {
  return createActiveUser(await createTenant("auth"));
}

/** Gives the user an active role; `requiresMfa` decides whether login demands a second factor. */
export async function assignRole(
  user: TestUser,
  options: { requiresMfa: boolean; active?: boolean; effectiveFrom?: Date; effectiveTo?: Date | null; revoked?: boolean },
): Promise<void> {
  await withTenant(user.tenantId, async (tx) => {
    const role = await tx.role.create({
      data: {
        tenantId: user.tenantId,
        name: `role-${randomBytes(4).toString("hex")}`,
        requiresMfa: options.requiresMfa,
        active: options.active ?? true,
      },
    });
    await tx.roleAssignment.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        roleId: role.id,
        effectiveFrom: options.effectiveFrom ?? new Date(Date.now() - 60_000),
        effectiveTo: options.effectiveTo ?? null,
        revokedAt: options.revoked ? new Date() : null,
      },
    });
  });
}

export function loginAs(user: TestUser, password = TEST_PASSWORD, client = testClient()): Promise<LoginResult> {
  return login({ tenantSlug: user.tenantSlug, email: user.email, password }, client);
}

/** A request carrying the session cookie, as a browser would send it. */
export function requestWithToken(token: string, url = "http://localhost/api/v1/auth/sessions", init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cookie", `leadro_session=${token}`);
  return new Request(url, { ...init, headers });
}

export const countEvents = (tenantId: string, type: string, userId?: string) =>
  withTenant(tenantId, (tx) =>
    tx.authenticationEvent.count({ where: { tenantId, type: type as never, ...(userId ? { userId } : {}) } }),
  );

export const loadUser = (user: TestUser) =>
  withTenant(user.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: user.userId } }));
