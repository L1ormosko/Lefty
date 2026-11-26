import { randomUUID } from "node:crypto";
import { decideApprovalRequest, decideApprovalSchema } from "@/server/approvals";
import { nextNumber, type Actor } from "@/server/core";
import { withTenant } from "@/server/db";
import { createDefinition, createDefinitionSchema, submitDefinition, submitDefinitionSchema } from "@/server/performance";
import { buildWorld, type World } from "../authz/fixtures";
import { makeAddress, makeCustomer } from "../customers/fixtures";
import { contextFor } from "../org/org-helpers";

/**
 * A tenant for the performance tests: the standard authz world (HR authors metric definitions, the Owner publishes them, the
 * City A manager computes for City A, technicians read their own values) plus the seeded publication policy, two job types and
 * a customer. Records the formulas read are inserted directly (the owning modules' services are not under test here).
 */
export interface PerformanceWorld extends World {
  jobTypeId: string;
  otherJobTypeId: string;
  customerId: string;
  addressId: string;
}

export const at = (iso: string) => new Date(iso);
const uniqueKey = () => `m_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

export async function addPublicationPolicy(tenantId: string): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.approvalPolicy.create({
      data: { tenantId, code: "performance_metric_publication", subjectType: "PERFORMANCE_METRIC_DEFINITION", name: "Performance metric publication", approverPermission: "performance.publish", expiresAfterHours: 336 },
    }),
  );
}

export async function buildPerformanceWorld(label: string, options: { withPolicy?: boolean } = {}): Promise<PerformanceWorld> {
  const w = await buildWorld(label);
  if (options.withPolicy !== false) await addPublicationPolicy(w.tenantId);
  const types = await withTenant(w.tenantId, async (tx) => ({
    jobTypeId: (await tx.jobType.create({ data: { tenantId: w.tenantId, code: "install", name: "Install", category: "installation", defaultDurationMinutes: 60 } })).id,
    otherJobTypeId: (await tx.jobType.create({ data: { tenantId: w.tenantId, code: "repair", name: "Repair", category: "repair", defaultDurationMinutes: 60 } })).id,
  }));
  const customer = await makeCustomer(w.tenantId);
  const addressId = await makeAddress(w.tenantId, customer.id, { orgUnitId: w.units.cityA });
  return { ...w, ...types, customerId: customer.id, addressId };
}

/** A job led by `employeeId` (LEAD assignment from a week before), completed at `completedAt` when given. */
export async function makeVisit(
  w: PerformanceWorld,
  options: { employeeId: string; completedAt?: Date | null; createdAt?: Date; jobTypeId?: string; appointmentWindowEnd?: Date; status?: "COMPLETED" | "CANCELLED" | "SCHEDULED" },
): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const completedAt = options.completedAt ?? null;
    const reference = completedAt ?? options.createdAt ?? new Date();
    const job = await tx.job.create({
      data: {
        tenantId: w.tenantId,
        number: await nextNumber(tx, w.tenantId, "job"),
        customerId: w.customerId,
        serviceAddressId: w.addressId,
        jobTypeId: options.jobTypeId ?? w.jobTypeId,
        orgUnitId: w.units.cityA,
        title: "Visit",
        estimatedDurationMinutes: 60,
        status: options.status ?? (completedAt ? "COMPLETED" : "SCHEDULED"),
        completedAt,
        createdAt: options.createdAt ?? new Date(reference.getTime() - 7 * 86_400_000),
        ...(options.appointmentWindowEnd
          ? { appointmentWindowStart: new Date(options.appointmentWindowEnd.getTime() - 2 * 3_600_000), appointmentWindowEnd: options.appointmentWindowEnd }
          : {}),
      },
    });
    await tx.jobAssignment.create({
      data: { tenantId: w.tenantId, jobId: job.id, employeeId: options.employeeId, role: "LEAD", assignedAt: new Date(reference.getTime() - 7 * 86_400_000) },
    });
    return job.id;
  });
}

/** A metric definition authored by HR, optionally submitted (by HR) and published (decided by the Owner). */
export async function makeDefinition(
  w: PerformanceWorld,
  fields: { kind: string; params?: Record<string, unknown>; minSample?: number; key?: string },
  stage: "DRAFT" | "PUBLISHED" = "PUBLISHED",
): Promise<{ id: string; key: string }> {
  const key = fields.key ?? uniqueKey();
  const created = await createDefinition(
    w.hr.actor,
    contextFor(w.hr.actor),
    createDefinitionSchema.parse({ key, kind: fields.kind, name: `Metric ${key}`, params: fields.params ?? {}, minSample: fields.minSample ?? 1 }),
  );
  const id = created.id as string;
  if (stage === "PUBLISHED") await publish(w, id);
  return { id, key };
}

/** Submits a DRAFT version as HR and approves it as the Owner. */
export async function publish(w: PerformanceWorld, definitionId: string, approver: Actor = w.ceo.actor): Promise<void> {
  const submitted = await submitDefinition(w.hr.actor, contextFor(w.hr.actor), definitionId, submitDefinitionSchema.parse({}));
  await decideApprovalRequest(approver, contextFor(approver), submitted.approvalRequestId as string, decideApprovalSchema.parse({ decision: "APPROVE" }));
}
