import type { Prisma } from "@prisma/client";
import { auditContextFields, recordAudit } from "@/server/audit";
import { NotFoundError, pageArgs, toPage, type Actor, type Page, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { recordJobEvent } from "@/server/jobs";
import { authorizeFieldRead, authorizeFieldWrite, runJobFieldWrite } from "./access";
import type { ListFieldRecordsQuery, RecordMaterialInput } from "./schemas";

/**
 * Materials used on a job (§8.5). Free-text name and a quantity (three decimals) with a unit; `materialRef` is the
 * placeholder for the Phase 4 catalog and is stored, never resolved. A row starts unattached and is linked to the
 * visit's completion when that is submitted, so the completion form's "materials" field can be checked.
 */

const MATERIAL_COLUMNS = {
  id: true,
  jobId: true,
  completionId: true,
  employeeId: true,
  name: true,
  materialRef: true,
  quantity: true,
  unit: true,
  note: true,
  occurredAt: true,
  recordedAt: true,
  clientEventId: true,
} satisfies Prisma.JobMaterialUsageSelect;
type MaterialRow = Prisma.JobMaterialUsageGetPayload<{ select: typeof MATERIAL_COLUMNS }>;

/** `Decimal` becomes a JSON number; quantities have at most three decimals so nothing is lost. */
const viewMaterial = (row: MaterialRow): Record<string, unknown> => ({ ...row, quantity: Number(row.quantity) });

export interface RecordedMaterial {
  material: Record<string, unknown>;
  replayed: boolean;
}

async function readMaterial(tx: TenantTx, actor: Actor, jobId: string, materialId: string): Promise<Record<string, unknown>> {
  await authorizeFieldRead(tx, actor, jobId);
  const row = await tx.jobMaterialUsage.findFirst({ where: { id: materialId, jobId, tenantId: actor.tenantId }, select: MATERIAL_COLUMNS });
  if (!row) throw new NotFoundError();
  return viewMaterial(row);
}

/** `POST /jobs/{id}/materials`: records one material used (offline-safe through `clientEventId`). */
export async function recordMaterialUsed(actor: Actor, ctx: RequestContext, jobId: string, input: RecordMaterialInput): Promise<RecordedMaterial> {
  const { result, replayed } = await runJobFieldWrite<Record<string, unknown>>(actor, {
    type: "job.material",
    jobId,
    envelope: input,
    content: { ...input, clientEventId: undefined, deviceId: undefined, occurredAt: undefined },
    payload: { unit: input.unit },
    apply: async (tx, occurredAt) => {
      await authorizeFieldWrite(tx, actor, jobId);
      const row = await tx.jobMaterialUsage.create({
        data: {
          tenantId: actor.tenantId,
          jobId,
          employeeId: actor.employeeId ?? null,
          name: input.name,
          materialRef: input.materialRef ?? null,
          quantity: input.quantity,
          unit: input.unit,
          note: input.note ?? null,
          occurredAt,
          clientEventId: input.clientEventId ?? null,
        },
        select: MATERIAL_COLUMNS,
      });
      await recordJobEvent(tx, actor.tenantId, jobId, { type: "job.material_used", actor, payload: { materialUsageId: row.id } });
      await recordAudit(tx, {
        ...auditContextFields(ctx),
        action: "job_material.record",
        targetType: "JobMaterialUsage",
        targetId: row.id,
        newValue: { jobId, unit: row.unit, quantity: Number(row.quantity) },
      });
      return { result: viewMaterial(row), entity: { type: "JobMaterialUsage", id: row.id } };
    },
    replay: (tx, materialId) => readMaterial(tx, actor, jobId, materialId),
  });
  return { material: result, replayed };
}

/** `GET /jobs/{id}/materials`: the materials used on the job, newest first. */
export async function listMaterialsUsed(actor: Actor, jobId: string, query: ListFieldRecordsQuery): Promise<Page<Record<string, unknown>>> {
  return withTenant(actor.tenantId, async (tx) => {
    await authorizeFieldRead(tx, actor, jobId);
    const rows = await tx.jobMaterialUsage.findMany({
      where: { tenantId: actor.tenantId, jobId },
      select: MATERIAL_COLUMNS,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      ...pageArgs(query),
    });
    const page = toPage(rows, query.limit);
    return { data: page.data.map(viewMaterial), page: page.page };
  });
}
