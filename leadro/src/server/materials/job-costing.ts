import { extendedCostMinor, materialCodeFromRef, quantityToThousandths, unitsMatch } from "@/lib/material-cost-rules";
import { MAX_MONEY_MINOR, sumMinor } from "@/lib/money";
import { recordAudit } from "@/server/audit";
import { enforceInTx, type ResourceRef } from "@/server/authz";
import { ConflictError, NotFoundError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { jobResourceRef } from "@/server/jobs";
import { enforceCostFieldSet, lockMaterial } from "./access";
import { materialAuditFields } from "./cost-versions";
import { costVersionRowSelect, usageCostView, usageRowSelect, type UsageRow } from "./fields";
import type { CostUsageInput } from "./schemas";

/**
 * Costing the materials used on a job (spec 11.4, 25.4).
 *
 * A Phase 3 `JobMaterialUsage` line is costed ONCE with the approved cost version in effect at the time the material was
 * used (`occurredAt`, the device time the gate accepted). The snapshot (`materialId`, `costVersionId`, `unitCostMinor`,
 * `extendedCostMinor`, `costCurrency`, `costedAt`) is written in one statement and frozen by the database trigger together
 * with `quantity`: a later cost change, approval or archive never rewrites it. `extendedCostMinor` = quantity x unit cost,
 * half-even to whole minor units (`src/lib/material-cost-rules.ts`). The direct material cost of a job is the sum of its
 * costed lines per currency; uncosted lines are counted, never guessed.
 *
 * Access: `jobs.view` over the job (404 outside scope) AND the `cost` set of `materials.view` (403). Costing writes only a
 * derived snapshot (the caller chooses nothing but, for an unlinked line, which catalog material it is), so it is open to
 * the people who may see the result; Finance gains no operational permission by it (spec 26.3).
 */

/** Why a line could not be costed (detail codes, also the i18n keys `MATERIAL.COSTING.<CODE>`). */
export type CostingSkipCode =
  | "material.usage_already_costed"
  | "material.usage_not_linked"
  | "material.unit_mismatch"
  | "material.no_effective_cost"
  | "material.cost_out_of_range";

const SKIP_MESSAGES: Record<CostingSkipCode, string> = {
  "material.usage_already_costed": "This line is already costed; its cost never changes.",
  "material.usage_not_linked": "This line is not linked to a catalog material (no material and no matching code).",
  "material.unit_mismatch": "The line's unit differs from the material's unit; there is no unit conversion.",
  "material.no_effective_cost": "The material had no approved cost at the time it was used.",
  "material.cost_out_of_range": "The extended cost is larger than the platform's money limit.",
};

export type CostingResult = { usageId: string; status: "COSTED"; line: Record<string, unknown> } | { usageId: string; status: "SKIPPED"; code: CostingSkipCode };

/** Route resolver for `/materials/usages/{usageId}/...`: the scope of the usage's job, null when the usage does not exist. */
export async function materialUsageJobResourceRef(tx: TenantTx, tenantId: string, usageId: string): Promise<ResourceRef | null> {
  const usage = await tx.jobMaterialUsage.findFirst({ where: { id: usageId, tenantId }, select: { jobId: true } });
  return usage ? jobResourceRef(tx, tenantId, usage.jobId) : null;
}

/** Re-checks job scope (404) and the cost set (403) inside the transaction. */
async function authorizeJobCosts(tx: TenantTx, actor: Actor, jobId: string): Promise<void> {
  const ref = await jobResourceRef(tx, actor.tenantId, jobId);
  if (!ref) throw new NotFoundError();
  await enforceInTx(tx, actor, "jobs.view", ref);
  await enforceCostFieldSet(tx, actor);
}

/** The catalog material a line refers to: its explicit link, else its `materialRef` read as a code; null when none. */
async function resolveMaterialId(tx: TenantTx, tenantId: string, usage: UsageRow, explicitMaterialId: string | undefined): Promise<string | null> {
  if (explicitMaterialId) {
    if (usage.materialId && usage.materialId !== explicitMaterialId) {
      throw new ConflictError({
        message: "This line is already linked to another material.",
        details: [{ field: "materialId", code: "material.usage_linked_elsewhere", message: "The line's material cannot change." }],
      });
    }
    const material = await tx.material.findFirst({ where: { id: explicitMaterialId, tenantId }, select: { id: true } });
    if (!material) throw new NotFoundError({ message: "The material does not exist." });
    return material.id;
  }
  if (usage.materialId) return usage.materialId;
  const code = materialCodeFromRef(usage.materialRef);
  if (!code) return null;
  const material = await tx.material.findFirst({ where: { tenantId, code }, select: { id: true } });
  return material?.id ?? null;
}

/**
 * Costs one line with `materialId` (the caller resolved it). Takes the material lock first, so no cost version is approved
 * between choosing the version and writing the snapshot. The conditional update (`costVersionId IS NULL`) makes a
 * concurrent second costing a no-op ("already costed") instead of a trigger error.
 */
async function costLineInTx(tx: TenantTx, ctx: RequestContext, tenantId: string, usage: UsageRow, materialId: string): Promise<CostingResult> {
  const material = await lockMaterial(tx, tenantId, materialId);
  if (!unitsMatch(usage.unit, material.unit)) return { usageId: usage.id, status: "SKIPPED", code: "material.unit_mismatch" };
  const version = await tx.materialCostVersion.findFirst({
    where: {
      tenantId,
      materialId,
      status: "APPROVED",
      effectiveFrom: { lte: usage.occurredAt },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: usage.occurredAt } }],
    },
    select: costVersionRowSelect,
  });
  if (!version) return { usageId: usage.id, status: "SKIPPED", code: "material.no_effective_cost" };

  const extended = extendedCostMinor(quantityToThousandths(usage.quantity.toFixed(3)), version.unitCostMinor);
  if (extended > MAX_MONEY_MINOR) return { usageId: usage.id, status: "SKIPPED", code: "material.cost_out_of_range" };
  const costedAt = new Date();
  const claim = await tx.jobMaterialUsage.updateMany({
    where: { id: usage.id, tenantId, costVersionId: null },
    data: { materialId, costVersionId: version.id, unitCostMinor: version.unitCostMinor, extendedCostMinor: extended, costCurrency: version.currency, costedAt },
  });
  if (claim.count !== 1) return { usageId: usage.id, status: "SKIPPED", code: "material.usage_already_costed" };
  const costed = await tx.jobMaterialUsage.findFirstOrThrow({ where: { id: usage.id, tenantId }, select: usageRowSelect });
  await recordAudit(tx, {
    ...materialAuditFields(tenantId, ctx),
    action: "job_material.costed",
    targetType: "JobMaterialUsage",
    targetId: usage.id,
    newValue: {
      jobId: usage.jobId,
      materialId,
      costVersionId: version.id,
      versionNumber: version.versionNumber,
      quantity: usage.quantity.toFixed(3),
      unitCostMinor: version.unitCostMinor,
      extendedCostMinor: extended,
      currency: version.currency,
    },
  });
  return { usageId: usage.id, status: "COSTED", line: usageCostView(costed) };
}

function skipError(code: CostingSkipCode): ConflictError {
  return new ConflictError({ message: SKIP_MESSAGES[code], details: [{ field: "usageId", code, message: SKIP_MESSAGES[code] }] });
}

/**
 * `POST /materials/usages/{usageId}/cost`: costs one line, optionally linking it to `materialId` first.
 * @throws NotFoundError, ForbiddenError, ConflictError (with the skip code as detail) when it cannot be costed.
 */
export async function costMaterialUsage(actor: Actor, ctx: RequestContext, usageId: string, input: CostUsageInput): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    const usage = await tx.jobMaterialUsage.findFirst({ where: { id: usageId, tenantId: actor.tenantId }, select: usageRowSelect });
    if (!usage) throw new NotFoundError();
    await authorizeJobCosts(tx, actor, usage.jobId);
    if (usage.costVersionId) throw skipError("material.usage_already_costed");
    const materialId = await resolveMaterialId(tx, actor.tenantId, usage, input.materialId);
    if (!materialId) throw skipError("material.usage_not_linked");
    const result = await costLineInTx(tx, ctx, actor.tenantId, usage, materialId);
    if (result.status === "SKIPPED") throw skipError(result.code);
    return result.line;
  });
}

/**
 * `POST /materials/job-costs/{jobId}/cost`: costs every uncosted line of the job that resolves to a catalog material, and
 * reports each line's result (COSTED, or SKIPPED with a code). Safe to repeat: costed lines are skipped. Lines are processed
 * in material id order so two concurrent runs take the material locks in the same order (no deadlock).
 */
export async function costJobMaterials(actor: Actor, ctx: RequestContext, jobId: string): Promise<{ results: CostingResult[]; cost: Record<string, unknown> }> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeJobCosts(tx, actor, jobId);
    const usages = await tx.jobMaterialUsage.findMany({ where: { tenantId: actor.tenantId, jobId, costVersionId: null }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], select: usageRowSelect });
    const resolved: Array<{ usage: UsageRow; materialId: string | null }> = [];
    for (const usage of usages) resolved.push({ usage, materialId: await resolveMaterialId(tx, actor.tenantId, usage, undefined) });
    resolved.sort((a, b) => (a.materialId ?? "").localeCompare(b.materialId ?? ""));

    const results: CostingResult[] = [];
    for (const { usage, materialId } of resolved) {
      results.push(materialId ? await costLineInTx(tx, ctx, actor.tenantId, usage, materialId) : { usageId: usage.id, status: "SKIPPED", code: "material.usage_not_linked" });
    }
    return { results, cost: await jobMaterialCostInTx(tx, actor.tenantId, jobId) };
  });
}

/** The direct material cost of a job: every line with its snapshot, totals of costed lines per currency, uncosted count. */
async function jobMaterialCostInTx(tx: TenantTx, tenantId: string, jobId: string): Promise<Record<string, unknown>> {
  const usages = await tx.jobMaterialUsage.findMany({ where: { tenantId, jobId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], select: usageRowSelect });
  const byCurrency = new Map<string, UsageRow[]>();
  for (const usage of usages) {
    if (!usage.costCurrency) continue;
    byCurrency.set(usage.costCurrency, [...(byCurrency.get(usage.costCurrency) ?? []), usage]);
  }
  const totals = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, lines]) => ({ currency, directMaterialCostMinor: sumMinor(lines.map((line) => line.extendedCostMinor)), costedLineCount: lines.length }));
  return {
    jobId,
    lines: usages.map(usageCostView),
    totals,
    lineCount: usages.length,
    uncostedLineCount: usages.filter((usage) => usage.costVersionId === null).length,
  };
}

/** `GET /materials/job-costs/{jobId}`: the direct material cost of a job (read only; costs nothing). */
export async function getJobMaterialCost(actor: Actor, jobId: string): Promise<Record<string, unknown>> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeJobCosts(tx, actor, jobId);
    return jobMaterialCostInTx(tx, actor.tenantId, jobId);
  });
}
