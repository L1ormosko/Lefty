import type { Prisma, ReconciliationRun } from "@prisma/client";
import { serializeJson } from "@/lib/money";
import { decideFinding, findingFingerprint, periodProblem, type ExistingException } from "@/lib/reconciliation-rules";
import { auditContextFields, recordAudit } from "@/server/audit";
import { enforceInTx } from "@/server/authz";
import { ValidationError, type Actor, type RequestContext } from "@/server/core";
import { withTenant, type TenantTx } from "@/server/db";
import { detectFindingsInTx, type DetectedFinding, type RunScope } from "./detect";
import type { StartRunInput } from "./schemas";
import { toRunView, type RunView } from "./views";

/**
 * Reconciliation runs (spec 5.7, 25.4): `finance_reconciliation.create` over the legal entity (TENANT or that LEGAL_ENTITY
 * scope), or at TENANT scope for a tenant-wide run.
 *
 * Three transactions, so the status machine RUNNING -> COMPLETED | FAILED is real and visible:
 *   1. create the run RUNNING (committed: a crash leaves a visible RUNNING row, which the next run of the same scope marks
 *      FAILED `abandoned` once it is older than ABANDONED_AFTER_MS);
 *   2. detect, store the findings, set the totals and COMPLETED, all at once (all or nothing);
 *   3. only if 2 threw: FAILED `internal_error` (a machine code; the internal message goes to the log, never the client).
 *
 * Idempotent re-runs: step 2 holds a per-tenant advisory lock, so two runs never interleave, and each finding is matched
 * to the exceptions already recorded by its fingerprint (`decideFinding`): an unresolved one is NOT duplicated (its
 * `details.lastSeenRunId` moves to this run), one resolved with the same amounts stands. The lock is per tenant (not
 * per scope) because one finding can belong to overlapping scopes (a tenant-wide run and an entity run).
 */

/** A RUNNING run older than this is treated as crashed. Step 2 is bounded by RUN_TIMEOUT_MS, so this is generous. */
export const ABANDONED_AFTER_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 120_000;

export interface RunOutcome {
  run: RunView;
  /** What this run did with its findings: new exceptions, ones still open from earlier runs, resolutions that stand. */
  findings: { created: number; alreadyOpen: number; acceptedEarlier: number };
}

function assertPeriod(input: StartRunInput): void {
  const problem = periodProblem(input.periodStart, input.periodEnd);
  if (!problem) return;
  const message = problem === "period_empty" ? "The period must end after it starts." : "A reconciliation period is at most 366 days.";
  throw new ValidationError({ message, field: "body.periodEnd", details: [{ field: "body.periodEnd", code: `reconciliation.${problem}`, message }] });
}

/** Step 1. Also closes RUNNING runs of the same entity and currency that a crash left behind. */
async function createRun(tx: TenantTx, actor: Actor, ctx: RequestContext, input: StartRunInput): Promise<ReconciliationRun> {
  const legalEntityId = input.legalEntityId ?? null;
  // `{ legalEntityId }` matches TENANT or that LEGAL_ENTITY scope only (no unit), an unknown id is 404; `{}` is TENANT only.
  await enforceInTx(tx, actor, "finance_reconciliation.create", legalEntityId ? { legalEntityId } : {});
  const now = new Date();
  const abandoned = await tx.reconciliationRun.findMany({
    where: { tenantId: actor.tenantId, legalEntityId, currency: input.currency, status: "RUNNING", startedAt: { lt: new Date(now.getTime() - ABANDONED_AFTER_MS) } },
    select: { id: true },
  });
  for (const stale of abandoned) {
    const { count } = await tx.reconciliationRun.updateMany({
      where: { id: stale.id, tenantId: actor.tenantId, status: "RUNNING" },
      data: { status: "FAILED", failureReason: "abandoned", completedAt: now },
    });
    if (count === 1) {
      await recordAudit(tx, { ...auditContextFields(ctx), action: "reconciliation_run.fail", targetType: "ReconciliationRun", targetId: stale.id, newValue: { status: "FAILED", failureReason: "abandoned" } });
    }
  }
  const run = await tx.reconciliationRun.create({
    data: { tenantId: actor.tenantId, legalEntityId, currency: input.currency, periodStart: input.periodStart, periodEnd: input.periodEnd, startedById: actor.userId },
  });
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "reconciliation_run.start",
    targetType: "ReconciliationRun",
    targetId: run.id,
    newValue: { legalEntityId, currency: run.currency, periodStart: run.periodStart.toISOString(), periodEnd: run.periodEnd.toISOString() },
  });
  return run;
}

/** The exceptions already recorded about any record this run found something on (resolved ones included). */
async function existingExceptions(tx: TenantTx, tenantId: string, currency: string, findings: DetectedFinding[]): Promise<Map<string, ExistingException[]>> {
  const ids = (pick: (finding: DetectedFinding) => string | null) => [...new Set(findings.map(pick).filter((value): value is string => value !== null))];
  const or: Prisma.ReconciliationExceptionWhereInput[] = [
    { jobId: { in: ids((f) => f.jobId) } },
    { paymentId: { in: ids((f) => f.paymentId) } },
    { intakeEventId: { in: ids((f) => f.intakeEventId) } },
    { refundId: { in: ids((f) => f.refundId) } },
    { outcomeId: { in: ids((f) => f.outcomeId) } },
  ];
  const rows = findings.length === 0 ? [] : await tx.reconciliationException.findMany({ where: { tenantId, currency, OR: or } });
  const byFingerprint = new Map<string, ExistingException[]>();
  for (const row of rows) {
    const details = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? (row.details as Record<string, unknown>) : {};
    const existing: ExistingException = { ...row, code: typeof details.code === "string" ? (details.code as ExistingException["code"]) : null };
    const key = findingFingerprint(existing);
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), existing]);
  }
  return byFingerprint;
}

/** Step 2: detection and storage under the tenant's reconciliation lock. */
async function executeRun(tx: TenantTx, ctx: RequestContext, run: ReconciliationRun): Promise<RunOutcome> {
  // Serializes runs of one tenant: two runs never both decide "CREATE" for the same finding.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reconciliation:${run.tenantId}`}))`;
  const scope: RunScope = { tenantId: run.tenantId, legalEntityId: run.legalEntityId, currency: run.currency, periodStart: run.periodStart, periodEnd: run.periodEnd };
  const detection = await detectFindingsInTx(tx, scope);
  const existing = await existingExceptions(tx, run.tenantId, run.currency, detection.findings);
  const now = new Date();
  const counts = { created: 0, alreadyOpen: 0, acceptedEarlier: 0 };
  const seen = new Set<string>();

  for (const finding of detection.findings) {
    const fingerprint = findingFingerprint(finding);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const lastSeen = {
      lastSeenRunId: run.id,
      lastSeenAt: now.toISOString(),
      latestExpectedMinor: finding.expectedAmountMinor?.toString() ?? null,
      latestRecordedMinor: finding.recordedAmountMinor?.toString() ?? null,
    };
    const decision = decideFinding(finding, existing.get(fingerprint) ?? []);
    if (decision.action === "ALREADY_OPEN") {
      counts.alreadyOpen += 1;
      const current = await tx.reconciliationException.findFirstOrThrow({ where: { id: decision.exceptionId, tenantId: run.tenantId }, select: { details: true } });
      const merged = { ...(current.details && typeof current.details === "object" && !Array.isArray(current.details) ? current.details : {}), ...finding.details, ...lastSeen };
      await tx.reconciliationException.update({ where: { id: decision.exceptionId }, data: { details: serializeJson<Prisma.InputJsonObject>(merged) } });
      continue;
    }
    if (decision.action === "ACCEPTED") {
      counts.acceptedEarlier += 1;
      continue;
    }
    counts.created += 1;
    await tx.reconciliationException.create({
      data: {
        tenantId: run.tenantId,
        runId: run.id,
        kind: finding.kind,
        currency: finding.currency,
        jobId: finding.jobId,
        paymentId: finding.paymentId,
        intakeEventId: finding.intakeEventId,
        refundId: finding.refundId,
        outcomeId: finding.outcomeId,
        orgUnitId: finding.orgUnitId,
        expectedAmountMinor: finding.expectedAmountMinor,
        recordedAmountMinor: finding.recordedAmountMinor,
        details: serializeJson<Prisma.InputJsonObject>({ ...(finding.code ? { code: finding.code } : {}), ...finding.details, ...lastSeen }),
      },
    });
  }

  const completed = await tx.reconciliationRun.update({
    where: { id: run.id },
    data: {
      status: "COMPLETED",
      completedAt: new Date(),
      jobsExamined: detection.jobsExamined,
      exceptionCount: counts.created + counts.alreadyOpen,
      expectedMinor: detection.expectedMinor,
      recordedMinor: detection.recordedMinor,
    },
  });
  await recordAudit(tx, {
    ...auditContextFields(ctx),
    action: "reconciliation_run.complete",
    targetType: "ReconciliationRun",
    targetId: run.id,
    previousValue: { status: "RUNNING" },
    newValue: {
      status: "COMPLETED",
      jobsExamined: completed.jobsExamined,
      expectedMinor: completed.expectedMinor.toString(),
      recordedMinor: completed.recordedMinor.toString(),
      ...counts,
    },
  });
  return { run: toRunView(completed), findings: counts };
}

/**
 * Starts and runs a reconciliation synchronously (bounded: one currency, at most 366 days) and returns the finished run.
 * A failure marks the run FAILED and rethrows (the client gets the standard 500; the run stays on record).
 */
export async function startReconciliationRun(actor: Actor, ctx: RequestContext, input: StartRunInput): Promise<RunOutcome> {
  assertPeriod(input);
  const run = await withTenant(actor.tenantId, (tx) => createRun(tx, actor, ctx, input));
  try {
    return await withTenant(actor.tenantId, (tx) => executeRun(tx, ctx, run), { timeout: RUN_TIMEOUT_MS, maxWait: 10_000 });
  } catch (error) {
    await withTenant(actor.tenantId, async (tx) => {
      const { count } = await tx.reconciliationRun.updateMany({
        where: { id: run.id, tenantId: actor.tenantId, status: "RUNNING" },
        data: { status: "FAILED", failureReason: "internal_error", completedAt: new Date() },
      });
      if (count === 1) {
        await recordAudit(tx, { ...auditContextFields(ctx), action: "reconciliation_run.fail", targetType: "ReconciliationRun", targetId: run.id, outcome: "FAILED", newValue: { status: "FAILED", failureReason: "internal_error" } });
      }
    });
    throw error;
  }
}
