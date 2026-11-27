import { PrismaClient } from "@prisma/client";
import { withTenant, type TenantTx } from "@/server/db";

/**
 * The analytics read path (spec 2: "heavy reporting can later be separated from the main transactional workload").
 *
 * With `REPORTING_DATABASE_URL` set, KPI data is read from that database (a read replica); without it, from the primary. Either
 * way the read runs in a READ ONLY transaction whose `app.tenant_id` is bound like `withTenant`, so row-level security filters
 * every row exactly as on the primary (the replica must connect as the same non-superuser, NOBYPASSRLS role) and analytics can
 * never write a business table. Permission and scope checks do NOT use this client: they read the primary, so a revoked grant
 * takes effect immediately even while a replica lags.
 */

const globalForReporting = globalThis as unknown as { leadroReportingPrisma?: PrismaClient };

function reportingClient(url: string): PrismaClient {
  globalForReporting.leadroReportingPrisma ??= new PrismaClient({ datasourceUrl: url, log: ["error"] });
  return globalForReporting.leadroReportingPrisma;
}

const READ_TIMEOUTS = { maxWait: 5_000, timeout: 30_000 };

/** Runs `fn` in a read-only, tenant-bound transaction on the reporting database (or the primary when none is configured). */
export async function withReportingTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const url = process.env.REPORTING_DATABASE_URL?.trim();
  if (!url) {
    return withTenant(
      tenantId,
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return fn(tx);
      },
      READ_TIMEOUTS,
    );
  }
  if (tenantId.trim() === "") throw new Error("withReportingTenant requires a non-empty tenantId");
  return reportingClient(url).$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    // Same tenant binding as withTenant (is_local = true: it cannot leak to another request on the pooled connection).
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  }, READ_TIMEOUTS);
}
