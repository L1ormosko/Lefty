import type { JobStatus, Prisma } from "@prisma/client";
import { nextNumber } from "@/server/core";
import { withTenant } from "@/server/db";
import { buildPerformanceWorld, type PerformanceWorld } from "../performance/fixtures";
import { createPerson, grantTemplate, type Person } from "../authz/fixtures";

/**
 * A tenant for the KPI engine tests: the standard authz world (State S > City A > Team A1, City B, Region X outside) with a
 * COO and a Lead Operations manager (State S) added, a job type, a customer with an address and a lost reason. Records the
 * KPIs read are inserted directly (the owning modules' services are not under test).
 */
export interface AnalyticsWorld extends PerformanceWorld {
  coo: Person;
  leadOps: Person;
}

export const at = (iso: string) => new Date(iso);

export async function buildAnalyticsWorld(label: string): Promise<AnalyticsWorld> {
  const w = await buildPerformanceWorld(label, { withPolicy: false });
  const coo = await createPerson(w.tenantId, "coo", { withEmployee: false });
  await grantTemplate(w.tenantId, coo, w.roles.COO, [{ type: "TENANT" }]);
  const leadOps = await createPerson(w.tenantId, "lead-ops", { orgUnitId: w.units.state, legalEntityId: w.legalEntityId });
  await grantTemplate(w.tenantId, leadOps, w.roles.LEAD_OPERATIONS_MANAGER, [{ type: "ORG_UNIT", orgUnitId: w.units.state }]);
  return { ...w, coo, leadOps };
}

export interface JobInput {
  orgUnitId: string;
  createdAt: Date;
  status?: JobStatus;
  startedAt?: Date;
  completedAt?: Date;
  currentVisitNumber?: number;
  /** A LEAD assignment: who, when, how. */
  lead?: { employeeId: string; assignedAt: Date; method?: Prisma.JobAssignmentCreateManyInput["method"] };
}

/** Inserts a job (and its lead assignment) directly. */
export async function insertJob(w: AnalyticsWorld, input: JobInput): Promise<string> {
  return withTenant(w.tenantId, async (tx) => {
    const job = await tx.job.create({
      data: {
        tenantId: w.tenantId,
        number: await nextNumber(tx, w.tenantId, "job"),
        customerId: w.customerId,
        serviceAddressId: w.addressId,
        jobTypeId: w.jobTypeId,
        orgUnitId: input.orgUnitId,
        title: "Analytics job",
        estimatedDurationMinutes: 60,
        status: input.status ?? (input.completedAt ? "COMPLETED" : "CREATED"),
        startedAt: input.startedAt ?? null,
        completedAt: input.completedAt ?? null,
        currentVisitNumber: input.currentVisitNumber ?? 1,
        createdAt: input.createdAt,
      },
    });
    if (input.lead) {
      const method = input.lead.method ?? "MANUAL";
      // Assignments taken from a recommendation must link it (CHECK job_assignment_recommendation_link): generated 10 minutes
      // before, decided at the assignment.
      const recommendationId = method.startsWith("RECOMMENDATION_")
        ? (
            await tx.dispatchRecommendation.create({
              data: {
                tenantId: w.tenantId,
                jobId: job.id,
                mode: "AI_ASSISTED",
                status: method === "RECOMMENDATION_APPROVED" ? "APPROVED" : "MODIFIED",
                candidates: [],
                generatedAt: new Date(input.lead.assignedAt.getTime() - 10 * 60_000),
                decidedAt: input.lead.assignedAt,
                decidedById: w.dispatcher.userId,
                chosenEmployeeId: input.lead.employeeId,
              },
            })
          ).id
        : null;
      await tx.jobAssignment.create({
        data: { tenantId: w.tenantId, jobId: job.id, employeeId: input.lead.employeeId, role: "LEAD", assignedAt: input.lead.assignedAt, method, recommendationId, overrideReason: method === "OVERRIDE" ? "Customer asked for this technician" : null },
      });
    }
    return job.id;
  });
}
