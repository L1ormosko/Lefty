import type { Prisma } from "@prisma/client";
import { prisma } from "./client";

export type TenantTx = Prisma.TransactionClient;

export interface WithTenantOptions {
  /** Max time (ms) to wait for a connection. Default 5000. */
  maxWait?: number;
  /** Max time (ms) the transaction may run. Default 15000. */
  timeout?: number;
}

/**
 * Runs `fn` inside a transaction whose Postgres setting `app.tenant_id` is bound to `tenantId`
 * (`set_config(..., is_local = true)`, so it cannot leak to another request on the same pooled
 * connection). Row-level-security policies compare every tenant-owned row against that setting.
 *
 * This is the ONLY sanctioned way to touch tenant-owned tables. Use the returned `tx` for all
 * queries; using the global `prisma` inside `fn` would bypass the tenant context.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("withTenant requires a non-empty tenantId");
  }
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { maxWait: options.maxWait ?? 5_000, timeout: options.timeout ?? 15_000 },
  );
}
