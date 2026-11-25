import { authenticateRequest } from "@/server/auth";
import { requirePermission, requireTenantLevelPermission } from "@/server/authz";
import { actorOf, created, defineRoute, ok, type Actor, type RequestContext } from "@/server/core";
import { listReconciliationRuns, listRunsQuerySchema, startReconciliationRun, startRunSchema, type StartRunInput } from "@/server/reconciliation";

/** GET /api/v1/finance/reconciliation/runs: runs the caller may see (TENANT / LEGAL_ENTITY scopes), newest first. */
export const GET = defineRoute({
  schemas: { query: listRunsQuerySchema },
  authenticate: authenticateRequest,
  authorize: requirePermission("finance_reconciliation.view"),
  handler: async ({ ctx, input }) => ok(await listReconciliationRuns(actorOf(ctx), input.query)),
});

// A legal-entity run needs TENANT or that LEGAL_ENTITY scope (unknown / out-of-scope entity = 404); a tenant-wide run
// needs a TENANT scope (403). Both denials are audited; the service re-checks in its own transaction.
const forEntity = requirePermission<{ body: StartRunInput }>("finance_reconciliation.create", (_actor, { body }) => ({ legalEntityId: body.legalEntityId ?? undefined }));
const forTenant = requireTenantLevelPermission("finance_reconciliation.create");
const authorizeStart = (actor: Actor, input: { body: StartRunInput }, ctx?: RequestContext) =>
  input.body.legalEntityId ? forEntity(actor, input, ctx) : forTenant(actor, input, ctx);

/**
 * POST /api/v1/finance/reconciliation/runs: run a reconciliation now (synchronous) and return the finished run with what it
 * did with its findings. Re-running the same period never duplicates an open exception. Accepts `Idempotency-Key`.
 */
export const POST = defineRoute({
  schemas: { body: startRunSchema },
  authenticate: authenticateRequest,
  authorize: authorizeStart,
  idempotent: true,
  handler: async ({ ctx, input }) => created(await startReconciliationRun(actorOf(ctx), ctx, input.body)),
});
