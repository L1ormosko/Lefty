import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, withTenant, type TenantTx } from "@/server/db";
import { createTenant } from "../helpers";

/**
 * Phase 4 schema: tenant isolation of every new table, composite tenant-safe foreign keys, CHECK constraints, status
 * machines, immutability, the append-only ledger and approval decisions, separation of duties, cost-version overlap and
 * BigInt money. Constraint, index and trigger names asserted here are part of the migration contract
 * (20261124100000_phase4_financial_core).
 */

interface Graph {
  tenantId: string;
  userId: string;
  otherUserId: string;
  orgUnitId: string;
  customerId: string;
  jobId: string;
  otherJobId: string;
  outcomeId: string;
  materialId: string;
  costVersionId: string;
  policyId: string;
  requestId: string;
  paymentId: string;
  ledgerEntryId: string;
}

const suffix = Math.random().toString(36).slice(2, 7);
let counter = 0;
const key = (prefix: string) => `${prefix}-${suffix}-${(counter += 1)}`;
let A: Graph;
let B: Graph;

async function buildGraph(label: string): Promise<Graph> {
  const tenant = await createTenant(label);
  const tenantId = tenant.id;
  return withTenant(tenantId, async (tx) => {
    const orgUnit = await tx.orgUnit.create({ data: { tenantId, type: "BRANCH", name: `Branch ${label}` } });
    const user = await tx.user.create({ data: { tenantId, email: `u-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const otherUser = await tx.user.create({ data: { tenantId, email: `v-${label}-${suffix}@x.test`, status: "ACTIVE" } });
    const customer = await tx.customer.create({ data: { tenantId, number: 1, name: "Ann Customer", orgUnitId: orgUnit.id } });
    const address = await tx.customerAddress.create({
      data: { tenantId, customerId: customer.id, line1: "1 Main St", city: "Dallas", region: "TX", postalCode: "75201", normalizedKey: `k-${label}` },
    });
    const jobType = await tx.jobType.create({ data: { tenantId, code: "ac-install", name: "AC installation", category: "installation", defaultDurationMinutes: 180 } });
    const job = await tx.job.create({
      data: { tenantId, number: 1, customerId: customer.id, serviceAddressId: address.id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, title: "Install AC", estimatedDurationMinutes: 180 },
    });
    const otherJob = await tx.job.create({
      data: { tenantId, number: 2, customerId: customer.id, serviceAddressId: address.id, jobTypeId: jobType.id, orgUnitId: orgUnit.id, title: "Second", estimatedDurationMinutes: 60 },
    });
    const outcome = await tx.jobOutcome.create({
      data: { tenantId, jobId: job.id, outcome: "SOLD", chargedAmountMinor: 500_000n, collectedAmountMinor: 500_000n, recordedById: user.id },
    });
    const material = await tx.material.create({ data: { tenantId, code: "copper-pipe", name: "Copper pipe", unit: "m", createdById: user.id } });
    const costVersion = await tx.materialCostVersion.create({
      data: { tenantId, materialId: material.id, versionNumber: 1, unitCostMinor: 1250n, effectiveFrom: new Date("2026-01-01T00:00:00Z"), status: "APPROVED", approvedAt: new Date(), createdById: user.id },
    });
    const policy = await tx.approvalPolicy.create({
      data: { tenantId, code: "refund_standard", subjectType: "REFUND", name: "Refund", approverPermission: "finance_refunds.approve", createdById: user.id },
    });
    const request = await tx.approvalRequest.create({
      data: {
        tenantId, subjectType: "REFUND", subjectId: "subject-1", policyId: policy.id, policyCode: policy.code, policyVersion: 1, requiredApprovals: 1,
        approverPermission: "finance_refunds.approve", amountMinor: 1000n, currency: "USD", jobId: job.id, orgUnitId: orgUnit.id, requestedById: user.id,
      },
    });
    const payment = await tx.payment.create({
      data: { tenantId, jobId: job.id, customerId: customer.id, method: "CASH", status: "RECEIVED", amountMinor: 500_000n, receivedAt: new Date(), recordedById: user.id },
    });
    const entry = await tx.ledgerEntry.create({
      data: {
        tenantId, type: "PAYMENT", source: "PAYMENT", amountMinor: 500_000n, currency: "USD", jobId: job.id, customerId: customer.id, paymentId: payment.id,
        orgUnitId: orgUnit.id, idempotencyKey: key("seed-payment"), actorUserId: user.id, occurredAt: new Date(),
      },
    });
    await tx.refund.create({ data: { tenantId, jobId: job.id, paymentId: payment.id, amountMinor: 1000n, reason: "Customer unhappy", requestedById: user.id } });
    await tx.chargeback.create({ data: { tenantId, jobId: job.id, paymentId: payment.id, amountMinor: 2000n, recordedById: user.id } });
    await tx.adjustment.create({ data: { tenantId, jobId: job.id, amountMinor: -500n, reason: "Reopened job", requestedById: user.id } });
    await tx.approvalDecision.create({ data: { tenantId, requestId: request.id, deciderId: otherUser.id, decision: "APPROVE" } });
    const run = await tx.reconciliationRun.create({ data: { tenantId, periodStart: new Date("2026-01-01T00:00:00Z"), periodEnd: new Date("2026-02-01T00:00:00Z"), startedById: user.id } });
    const intake = await tx.paymentIntakeEvent.create({
      data: { tenantId, provider: "demo", externalId: key("evt"), eventType: "payment.succeeded", payloadHash: "a".repeat(64), signatureValid: true, status: "ACCEPTED" },
    });
    await tx.reconciliationException.create({ data: { tenantId, runId: run.id, kind: "UNPAID", jobId: job.id, intakeEventId: intake.id, expectedAmountMinor: 100n, recordedAmountMinor: 0n } });
    return {
      tenantId, userId: user.id, otherUserId: otherUser.id, orgUnitId: orgUnit.id, customerId: customer.id, jobId: job.id, otherJobId: otherJob.id,
      outcomeId: outcome.id, materialId: material.id, costVersionId: costVersion.id, policyId: policy.id, requestId: request.id, paymentId: payment.id, ledgerEntryId: entry.id,
    };
  });
}

beforeAll(async () => {
  A = await buildGraph("p4a");
  B = await buildGraph("p4b");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const rejects = (g: Graph, rule: RegExp | string, fn: (tx: TenantTx) => Promise<unknown>) => expect(withTenant(g.tenantId, fn)).rejects.toThrow(rule);

/** A valid ledger entry for tenant graph `g`; `over` overrides columns. */
const entry = (g: Graph, over: Record<string, unknown> = {}) => ({
  tenantId: g.tenantId, type: "CHARGE" as const, source: "JOB" as const, amountMinor: 1000n, currency: "USD", jobId: g.jobId, customerId: g.customerId,
  idempotencyKey: key("e"), actorUserId: g.userId, occurredAt: new Date(), ...over,
});

describe("tenant isolation of every Phase 4 table", () => {
  const TABLES = [
    "Material", "MaterialCostVersion", "LedgerEntry", "Payment", "Refund", "Chargeback", "Adjustment", "ApprovalPolicy", "ApprovalRequest",
    "ApprovalDecision", "ReconciliationRun", "ReconciliationException", "PaymentIntakeEvent",
  ];

  it.each(TABLES)("%s: each tenant sees only its own rows, and nothing without a tenant context", async (table) => {
    const own = (g: Graph) =>
      withTenant(g.tenantId, async (tx) => (await tx.$queryRawUnsafe<{ tenantId: string }[]>(`SELECT "tenantId" FROM "${table}"`)).map((r) => r.tenantId));
    expect(new Set(await own(A))).toEqual(new Set([A.tenantId]));
    expect(new Set(await own(B))).toEqual(new Set([B.tenantId]));
    expect(await prisma.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM "${table}"`)).toEqual([]);
  });

  it("a tenant cannot insert a Phase 4 row under another tenant's id", async () => {
    await rejects(A, /row-level security/, (tx) => tx.material.create({ data: { tenantId: B.tenantId, code: "smuggled", name: "Smuggled" } }));
    await rejects(A, /row-level security/, (tx) => tx.ledgerEntry.create({ data: entry(B) }));
  });
});

describe("composite foreign keys keep every reference inside one tenant", () => {
  it("ledger, payment and approval rows cannot point at another tenant's rows", async () => {
    await rejects(A, /foreign key/i, (tx) => tx.ledgerEntry.create({ data: entry(A, { jobId: B.jobId }) }));
    await rejects(A, /foreign key/i, (tx) => tx.payment.create({ data: { tenantId: A.tenantId, jobId: B.jobId, method: "CASH", amountMinor: 1n, recordedById: A.userId } }));
    await rejects(A, /foreign key/i, (tx) => tx.payment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, method: "CASH", amountMinor: 1n, recordedById: B.userId } }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.approvalRequest.create({
        data: { tenantId: A.tenantId, subjectType: "REFUND", subjectId: "x", policyId: B.policyId, policyCode: "c", policyVersion: 1, requiredApprovals: 1, approverPermission: "a.b" },
      }),
    );
    await rejects(A, /foreign key/i, (tx) => tx.approvalDecision.create({ data: { tenantId: A.tenantId, requestId: B.requestId, deciderId: A.otherUserId, decision: "APPROVE" } }));
  });

  it("a usage's cost version must belong to the usage's material", async () => {
    const other = await withTenant(A.tenantId, (tx) => tx.material.create({ data: { tenantId: A.tenantId, code: key("other"), name: "Other" } }));
    await rejects(A, /foreign key/i, (tx) =>
      tx.jobMaterialUsage.create({
        data: {
          tenantId: A.tenantId, jobId: A.jobId, name: "Pipe", quantity: "1", materialId: other.id, costVersionId: A.costVersionId,
          unitCostMinor: 1250n, extendedCostMinor: 1250n, costCurrency: "USD", costedAt: new Date(),
        },
      }),
    );
  });
});

describe("money is BigInt", () => {
  it("stores and returns amounts beyond the 32-bit range exactly", async () => {
    const big = 9_000_000_000_000n;
    const created = await withTenant(A.tenantId, (tx) =>
      tx.jobOutcome.create({ data: { tenantId: A.tenantId, jobId: A.otherJobId, outcome: "SOLD", chargedAmountMinor: big, collectedAmountMinor: big - 1n, recordedById: A.userId } }),
    );
    expect(created.chargedAmountMinor).toBe(big);
    expect(created.collectedAmountMinor).toBe(big - 1n);
  });
});

describe("ledger", () => {
  it("is append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`UPDATE "LedgerEntry" SET "memo" = 'x' WHERE "id" = ${A.ledgerEntryId}`);
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`DELETE FROM "LedgerEntry" WHERE "id" = ${A.ledgerEntryId}`);
    await rejects(A, /append-only/, (tx) => tx.$executeRawUnsafe(`TRUNCATE "LedgerEntry"`));
  });

  it("enforces the sign by type, never zero, and one actor", async () => {
    await rejects(A, "ledger_entry_sign_by_type", (tx) => tx.ledgerEntry.create({ data: entry(A, { amountMinor: -5n }) }));
    await rejects(A, "ledger_entry_sign_by_type", (tx) =>
      tx.ledgerEntry.create({ data: entry(A, { type: "REFUND", source: "PAYMENT", paymentId: A.paymentId, amountMinor: 5n }) }),
    );
    await rejects(A, "ledger_entry_amount_nonzero", (tx) => tx.ledgerEntry.create({ data: entry(A, { type: "ADJUSTMENT", source: "JOB", amountMinor: 0n }) }));
    await rejects(A, "ledger_entry_one_actor", (tx) => tx.ledgerEntry.create({ data: entry(A, { actorUserId: null }) }));
    await rejects(A, "ledger_entry_one_actor", (tx) => tx.ledgerEntry.create({ data: entry(A, { systemActor: "system:intake" }) }));
    await rejects(A, "ledger_entry_system_actor_format", (tx) => tx.ledgerEntry.create({ data: entry(A, { actorUserId: null, systemActor: "intake" }) }));
    await rejects(A, "ledger_entry_currency_format", (tx) => tx.ledgerEntry.create({ data: entry(A, { currency: "usd" }) }));
  });

  it("requires the source's reference and a matching type", async () => {
    await rejects(A, "ledger_entry_source_reference", (tx) => tx.ledgerEntry.create({ data: entry(A, { type: "PAYMENT", source: "PAYMENT", paymentId: null }) }));
    await rejects(A, "ledger_entry_source_matches_type", (tx) => tx.ledgerEntry.create({ data: entry(A, { type: "PAYMENT", source: "JOB" }) }));
    await rejects(A, "ledger_entry_subject", (tx) => tx.ledgerEntry.create({ data: entry(A, { jobId: null, customerId: null, type: "PAYMENT", source: "PAYMENT", paymentId: A.paymentId }) }));
  });

  it("posts the same idempotency key once per tenant (and the same key in another tenant is fine)", async () => {
    const shared = key("idem");
    await withTenant(A.tenantId, (tx) => tx.ledgerEntry.create({ data: entry(A, { idempotencyKey: shared }) }));
    await rejects(A, /Unique constraint|idempotencyKey/, (tx) => tx.ledgerEntry.create({ data: entry(A, { idempotencyKey: shared }) }));
    await withTenant(B.tenantId, (tx) => tx.ledgerEntry.create({ data: entry(B, { idempotencyKey: shared }) }));
  });

  it("a reversal is the exact negative of one earlier entry, once", async () => {
    const original = await withTenant(A.tenantId, (tx) => tx.ledgerEntry.create({ data: entry(A, { amountMinor: 7777n }) }));
    const reversal = (over: Record<string, unknown> = {}) =>
      entry(A, { type: "REVERSAL", source: "REVERSAL", amountMinor: -7777n, reversesEntryId: original.id, ...over });
    await rejects(A, /exact negative/, (tx) => tx.ledgerEntry.create({ data: reversal({ amountMinor: -7000n }) }));
    await rejects(A, /exact negative/, (tx) => tx.ledgerEntry.create({ data: reversal({ currency: "EUR" }) }));
    await rejects(A, /same job and customer/, (tx) => tx.ledgerEntry.create({ data: reversal({ jobId: A.otherJobId }) }));
    await rejects(A, /exact negative|ledger_entry_reversal_link/, (tx) => tx.ledgerEntry.create({ data: entry(A, { reversesEntryId: original.id }) }));
    await rejects(A, "ledger_entry_reversal_link", (tx) => tx.ledgerEntry.create({ data: entry(A, { type: "REVERSAL", source: "JOB" }) }));
    const created = await withTenant(A.tenantId, (tx) => tx.ledgerEntry.create({ data: reversal() }));
    expect(created.reversesEntryId).toBe(original.id);
    await rejects(A, /ledger_entry_one_reversal|Unique constraint/, (tx) => tx.ledgerEntry.create({ data: reversal() }));
    // A reversal cannot be reversed.
    await rejects(A, /cannot itself be reversed/, (tx) =>
      tx.ledgerEntry.create({ data: entry(A, { type: "REVERSAL", source: "REVERSAL", amountMinor: 7777n, reversesEntryId: created.id }) }),
    );
  });

  it("derives a balance by summing entries (BigInt)", async () => {
    const rows = await withTenant(A.tenantId, (tx) => tx.ledgerEntry.aggregate({ where: { jobId: A.jobId, type: "PAYMENT" }, _sum: { amountMinor: true } }));
    expect(rows._sum.amountMinor).toBe(500_000n);
  });
});

describe("approvals", () => {
  const newRequest = (g: Graph, over: Record<string, unknown> = {}) => ({
    tenantId: g.tenantId, subjectType: "ADJUSTMENT" as const, subjectId: key("subject"), policyId: g.policyId, policyCode: "refund_standard", policyVersion: 1,
    requiredApprovals: 1, approverPermission: "finance_refunds.approve", requestedById: g.userId, ...over,
  });

  it("refuses a decision by the requester, by an excluded editor, or on a request that is no longer pending", async () => {
    const third = await withTenant(A.tenantId, (tx) => tx.user.create({ data: { tenantId: A.tenantId, email: `w-${key("u")}@x.test`, status: "ACTIVE" } }));
    const request = await withTenant(A.tenantId, (tx) => tx.approvalRequest.create({ data: newRequest(A, { excludedApproverIds: [third.id] }) }));
    await rejects(A, /separation of duties/, (tx) => tx.approvalDecision.create({ data: { tenantId: A.tenantId, requestId: request.id, deciderId: A.userId, decision: "APPROVE" } }));
    await rejects(A, /separation of duties/, (tx) => tx.approvalDecision.create({ data: { tenantId: A.tenantId, requestId: request.id, deciderId: third.id, decision: "APPROVE" } }));
    await withTenant(A.tenantId, (tx) => tx.approvalDecision.create({ data: { tenantId: A.tenantId, requestId: request.id, deciderId: A.otherUserId, decision: "APPROVE" } }));
    await rejects(A, /Unique constraint/, (tx) => tx.approvalDecision.create({ data: { tenantId: A.tenantId, requestId: request.id, deciderId: A.otherUserId, decision: "REJECT" } }));
    await withTenant(A.tenantId, (tx) => tx.approvalRequest.update({ where: { id: request.id }, data: { status: "APPROVED", decidedAt: new Date() } }));
    await rejects(A, /not pending/, (tx) => tx.approvalDecision.create({ data: { tenantId: A.tenantId, requestId: request.id, deciderId: third.id, decision: "APPROVE" } }));
  });

  it("decisions are append-only", async () => {
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`UPDATE "ApprovalDecision" SET "comment" = 'x' WHERE "requestId" = ${A.requestId}`);
    await rejects(A, /append-only/, (tx) => tx.$executeRaw`DELETE FROM "ApprovalDecision" WHERE "requestId" = ${A.requestId}`);
  });

  it("allows one pending request per subject, and a policy snapshot cannot change", async () => {
    const subjectId = key("one-pending");
    await withTenant(A.tenantId, (tx) => tx.approvalRequest.create({ data: newRequest(A, { subjectId }) }));
    await rejects(A, /approval_request_one_pending_per_subject|Unique constraint/, (tx) => tx.approvalRequest.create({ data: newRequest(A, { subjectId }) }));
    await rejects(A, /immutable/, (tx) => tx.approvalRequest.update({ where: { id: A.requestId }, data: { requiredApprovals: 2 } }));
    await rejects(A, /immutable/, (tx) => tx.approvalRequest.update({ where: { id: A.requestId }, data: { requestedById: A.otherUserId } }));
  });

  it("request statuses are final and need their fields", async () => {
    const request = await withTenant(A.tenantId, (tx) => tx.approvalRequest.create({ data: newRequest(A) }));
    await rejects(A, "approval_request_cancelled_fields", (tx) => tx.approvalRequest.update({ where: { id: request.id }, data: { status: "CANCELLED" } }));
    await withTenant(A.tenantId, (tx) => tx.approvalRequest.update({ where: { id: request.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "no longer needed" } }));
    await rejects(A, /status transition CANCELLED -> APPROVED/, (tx) => tx.approvalRequest.update({ where: { id: request.id }, data: { status: "APPROVED", decidedAt: new Date() } }));
    await rejects(A, /never deleted/, (tx) => tx.approvalRequest.delete({ where: { id: request.id } }));
  });

  it("policies validate their shape, keep one active version per code and never change content", async () => {
    const policy = (over: Record<string, unknown> = {}) => ({
      tenantId: A.tenantId, code: key("pol"), subjectType: "REFUND" as const, name: "P", approverPermission: "finance_refunds.approve", ...over,
    });
    await rejects(A, "approval_policy_required_approvals", (tx) => tx.approvalPolicy.create({ data: policy({ requiredApprovals: 3 }) }));
    await rejects(A, "approval_policy_threshold_range", (tx) => tx.approvalPolicy.create({ data: policy({ minAmountMinor: 100n, maxAmountMinor: 100n }) }));
    await rejects(A, "approval_policy_approver_permission_format", (tx) => tx.approvalPolicy.create({ data: policy({ approverPermission: "Refund Approver" }) }));
    await rejects(A, "approval_policy_one_active_version", (tx) => tx.approvalPolicy.create({ data: policy({ code: "refund_standard", version: 2 }) }));
    await rejects(A, /immutable/, (tx) => tx.approvalPolicy.update({ where: { id: A.policyId }, data: { requiredApprovals: 2 } }));
    await withTenant(A.tenantId, async (tx) => {
      await tx.approvalPolicy.update({ where: { id: A.policyId }, data: { active: false } });
      await tx.approvalPolicy.create({ data: policy({ code: "refund_standard", version: 2, requiredApprovals: 2 }) });
    });
  });
});

describe("materials and cost versions", () => {
  const version = (g: Graph, over: Record<string, unknown> = {}) => ({
    tenantId: g.tenantId, materialId: g.materialId, versionNumber: 2, unitCostMinor: 1400n, effectiveFrom: new Date("2026-06-01T00:00:00Z"), ...over,
  });

  it("validates material codes and costs", async () => {
    await rejects(A, "material_code_format", (tx) => tx.material.create({ data: { tenantId: A.tenantId, code: "Bad Code", name: "X" } }));
    await rejects(A, /Unique constraint/, (tx) => tx.material.create({ data: { tenantId: A.tenantId, code: "copper-pipe", name: "Dup" } }));
    await rejects(A, "material_cost_version_cost_nonnegative", (tx) => tx.materialCostVersion.create({ data: version(A, { versionNumber: 9, unitCostMinor: -1n }) }));
    await rejects(A, "material_cost_version_period", (tx) => tx.materialCostVersion.create({ data: version(A, { versionNumber: 9, effectiveTo: new Date("2026-01-01T00:00:00Z") }) }));
    await rejects(A, "material_cost_version_approved_at", (tx) => tx.materialCostVersion.create({ data: version(A, { versionNumber: 9, status: "APPROVED" }) }));
  });

  it("never lets approved versions of one material overlap, but a later version can follow once the earlier is closed", async () => {
    const material = await withTenant(A.tenantId, (tx) => tx.material.create({ data: { tenantId: A.tenantId, code: key("mat"), name: "Overlap test" } }));
    const approved = (over: Record<string, unknown>) => ({
      ...version(A, { materialId: material.id, status: "APPROVED", approvedAt: new Date() }), ...over,
    });
    const first = await withTenant(A.tenantId, (tx) => tx.materialCostVersion.create({ data: approved({ versionNumber: 1, effectiveFrom: new Date("2026-01-01T00:00:00Z") }) }));
    await rejects(A, "material_cost_version_no_overlap", (tx) => tx.materialCostVersion.create({ data: approved({ versionNumber: 2, effectiveFrom: new Date("2026-03-01T00:00:00Z") }) }));
    // A PENDING version may overlap while it waits for a decision.
    await withTenant(A.tenantId, (tx) => tx.materialCostVersion.create({ data: version(A, { materialId: material.id, versionNumber: 3, effectiveFrom: new Date("2026-03-01T00:00:00Z") }) }));
    await withTenant(A.tenantId, async (tx) => {
      await tx.materialCostVersion.update({ where: { id: first.id }, data: { effectiveTo: new Date("2026-06-01T00:00:00Z") } });
      await tx.materialCostVersion.create({ data: approved({ versionNumber: 2, effectiveFrom: new Date("2026-06-01T00:00:00Z") }) });
    });
  });

  it("freezes an approved version except for closing it once", async () => {
    const closed = await withTenant(A.tenantId, async (tx) => {
      const material = await tx.material.create({ data: { tenantId: A.tenantId, code: key("freeze"), name: "Freeze" } });
      return tx.materialCostVersion.create({
        data: version(A, { materialId: material.id, versionNumber: 1, status: "APPROVED", approvedAt: new Date(), effectiveFrom: new Date("2026-01-01T00:00:00Z") }),
      });
    });
    await rejects(A, /immutable/, (tx) => tx.materialCostVersion.update({ where: { id: closed.id }, data: { unitCostMinor: 1n } }));
    await rejects(A, /immutable/, (tx) => tx.materialCostVersion.update({ where: { id: closed.id }, data: { effectiveFrom: new Date("2025-01-01T00:00:00Z") } }));
    await withTenant(A.tenantId, (tx) => tx.materialCostVersion.update({ where: { id: closed.id }, data: { effectiveTo: new Date("2026-05-01T00:00:00Z") } }));
    await rejects(A, /cannot be reopened or moved/, (tx) => tx.materialCostVersion.update({ where: { id: closed.id }, data: { effectiveTo: new Date("2026-07-01T00:00:00Z") } }));
    await rejects(A, /status transition APPROVED -> REJECTED/, (tx) => tx.materialCostVersion.update({ where: { id: closed.id }, data: { status: "REJECTED" } }));
    await rejects(A, /never deleted/, (tx) => tx.materialCostVersion.delete({ where: { id: closed.id } }));
  });

  it("a costed material usage is a frozen snapshot, all or nothing", async () => {
    const snapshot = {
      materialId: A.materialId, costVersionId: A.costVersionId, unitCostMinor: 1250n, extendedCostMinor: 3125n, costCurrency: "USD", costedAt: new Date(),
    };
    await rejects(A, "job_material_usage_cost_snapshot", (tx) =>
      tx.jobMaterialUsage.create({ data: { tenantId: A.tenantId, jobId: A.jobId, name: "Pipe", quantity: "2.5", materialId: A.materialId, costVersionId: A.costVersionId, unitCostMinor: 1250n } }),
    );
    const usage = await withTenant(A.tenantId, (tx) => tx.jobMaterialUsage.create({ data: { tenantId: A.tenantId, jobId: A.jobId, name: "Pipe", quantity: "2.5", unit: "m", ...snapshot } }));
    await rejects(A, /snapshot and cannot change/, (tx) => tx.jobMaterialUsage.update({ where: { id: usage.id }, data: { unitCostMinor: 1n } }));
    await rejects(A, /snapshot and cannot change/, (tx) => tx.jobMaterialUsage.update({ where: { id: usage.id }, data: { quantity: "3" } }));
    // An uncosted usage can still be costed later (once).
    const uncosted = await withTenant(A.tenantId, (tx) => tx.jobMaterialUsage.create({ data: { tenantId: A.tenantId, jobId: A.jobId, name: "Tape", quantity: "1" } }));
    await withTenant(A.tenantId, (tx) => tx.jobMaterialUsage.update({ where: { id: uncosted.id }, data: { ...snapshot, extendedCostMinor: 1250n } }));
    // The usage can be posted to the ledger as a MATERIAL_COST entry.
    await withTenant(A.tenantId, (tx) =>
      tx.ledgerEntry.create({ data: entry(A, { type: "MATERIAL_COST", source: "MATERIAL_USAGE", amountMinor: -3125n, materialUsageId: usage.id }) }),
    );
  });
});

describe("payments, refunds, chargebacks and adjustments", () => {
  const payment = (over: Record<string, unknown> = {}) => ({
    tenantId: A.tenantId, jobId: A.jobId, method: "CARD" as const, amountMinor: 100n, recordedById: A.userId, ...over,
  });

  it("validates payments and enforces the status machine", async () => {
    await rejects(A, "payment_amount_positive", (tx) => tx.payment.create({ data: payment({ amountMinor: 0n }) }));
    await rejects(A, "payment_origin_fields", (tx) => tx.payment.create({ data: payment({ recordedById: null }) }));
    await rejects(A, "payment_origin_fields", (tx) => tx.payment.create({ data: payment({ origin: "PROVIDER", provider: "demo", providerRef: "p1" }) }));
    await rejects(A, "payment_provider_pair", (tx) => tx.payment.create({ data: payment({ provider: "demo" }) }));
    await rejects(A, "payment_received_at", (tx) => tx.payment.create({ data: payment({ status: "RECEIVED" }) }));
    const created = await withTenant(A.tenantId, (tx) => tx.payment.create({ data: payment() }));
    await rejects(A, "payment_failed_fields", (tx) => tx.payment.update({ where: { id: created.id }, data: { status: "FAILED", failedAt: new Date() } }));
    await withTenant(A.tenantId, (tx) => tx.payment.update({ where: { id: created.id }, data: { status: "RECEIVED", receivedAt: new Date() } }));
    await rejects(A, /payment status transition RECEIVED -> FAILED/, (tx) => tx.payment.update({ where: { id: created.id }, data: { status: "FAILED", failedAt: new Date(), failureReason: "x" } }));
    await rejects(A, /immutable/, (tx) => tx.payment.update({ where: { id: created.id }, data: { amountMinor: 1n } }));
    await rejects(A, /never deleted/, (tx) => tx.payment.delete({ where: { id: created.id } }));
    await withTenant(A.tenantId, (tx) => tx.payment.update({ where: { id: created.id }, data: { status: "VOIDED", voidedAt: new Date(), voidReason: "entered twice" } }));
  });

  it("a provider payment's (provider, providerRef) is unique per tenant and needs its intake event", async () => {
    const intake = await withTenant(A.tenantId, (tx) =>
      tx.paymentIntakeEvent.create({ data: { tenantId: A.tenantId, provider: "demo", externalId: key("pay-evt"), eventType: "payment.succeeded", payloadHash: "b".repeat(64), signatureValid: true } }),
    );
    const provider = { origin: "PROVIDER" as const, provider: "demo", providerRef: key("ref"), intakeEventId: intake.id, recordedById: null };
    await withTenant(A.tenantId, (tx) => tx.payment.create({ data: payment(provider) }));
    await rejects(A, /payment_provider_ref_unique|Unique constraint/, (tx) => tx.payment.create({ data: payment(provider) }));
  });

  it("refunds, chargebacks and adjustments validate and move only along their machines", async () => {
    await rejects(A, "refund_amount_positive", (tx) => tx.refund.create({ data: { tenantId: A.tenantId, jobId: A.jobId, amountMinor: 0n, reason: "x" } }));
    await rejects(A, "refund_reason_present", (tx) => tx.refund.create({ data: { tenantId: A.tenantId, jobId: A.jobId, amountMinor: 1n, reason: "  " } }));
    const refund = await withTenant(A.tenantId, (tx) => tx.refund.create({ data: { tenantId: A.tenantId, jobId: A.jobId, amountMinor: 50n, reason: "Goodwill" } }));
    await rejects(A, /refund status transition REQUESTED -> POSTED/, (tx) => tx.refund.update({ where: { id: refund.id }, data: { status: "POSTED", postedAt: new Date() } }));
    await withTenant(A.tenantId, async (tx) => {
      await tx.refund.update({ where: { id: refund.id }, data: { status: "APPROVED", decidedAt: new Date() } });
      await tx.refund.update({ where: { id: refund.id }, data: { status: "POSTED", postedAt: new Date() } });
    });
    await rejects(A, /refund status transition POSTED -> CANCELLED/, (tx) => tx.refund.update({ where: { id: refund.id }, data: { status: "CANCELLED" } }));

    await rejects(A, "adjustment_amount_nonzero", (tx) => tx.adjustment.create({ data: { tenantId: A.tenantId, jobId: A.jobId, amountMinor: 0n, reason: "x" } }));
    await rejects(A, "adjustment_subject", (tx) => tx.adjustment.create({ data: { tenantId: A.tenantId, amountMinor: 5n, reason: "x" } }));
    await rejects(A, /immutable/, (tx) => tx.$executeRaw`UPDATE "Adjustment" SET "amountMinor" = 1 WHERE "tenantId" = ${A.tenantId}`);

    await rejects(A, "chargeback_write_off_needs_request", (tx) =>
      tx.chargeback.create({ data: { tenantId: A.tenantId, jobId: A.jobId, amountMinor: 5n, status: "WRITE_OFF_PENDING_APPROVAL" } }),
    );
    const chargeback = await withTenant(A.tenantId, (tx) => tx.chargeback.create({ data: { tenantId: A.tenantId, jobId: A.jobId, amountMinor: 900n } }));
    await rejects(A, /chargeback status transition OPEN -> WRITTEN_OFF/, (tx) => tx.chargeback.update({ where: { id: chargeback.id }, data: { status: "WRITTEN_OFF", resolvedAt: new Date() } }));
    await withTenant(A.tenantId, (tx) => tx.chargeback.update({ where: { id: chargeback.id }, data: { status: "LOST", resolvedAt: new Date() } }));
  });
});

describe("reconciliation and payment intake", () => {
  it("resolves an exception only with a reason, and never deletes", async () => {
    const run = await withTenant(A.tenantId, (tx) => tx.reconciliationRun.create({ data: { tenantId: A.tenantId, periodStart: new Date("2026-03-01T00:00:00Z"), periodEnd: new Date("2026-04-01T00:00:00Z") } }));
    await rejects(A, "reconciliation_run_period", (tx) => tx.reconciliationRun.create({ data: { tenantId: A.tenantId, periodStart: new Date("2026-04-01T00:00:00Z"), periodEnd: new Date("2026-03-01T00:00:00Z") } }));
    const exception = await withTenant(A.tenantId, (tx) => tx.reconciliationException.create({ data: { tenantId: A.tenantId, runId: run.id, kind: "PARTIAL_PAYMENT", jobId: A.jobId } }));
    await rejects(A, "reconciliation_exception_assigned", (tx) => tx.reconciliationException.update({ where: { id: exception.id }, data: { status: "ASSIGNED" } }));
    await rejects(A, "reconciliation_exception_resolved", (tx) =>
      tx.reconciliationException.update({ where: { id: exception.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: A.userId } }),
    );
    await withTenant(A.tenantId, (tx) =>
      tx.reconciliationException.update({ where: { id: exception.id }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedById: A.userId, resolutionReason: "Customer paid the balance in cash" } }),
    );
    await rejects(A, /status transition RESOLVED -> OPEN/, (tx) => tx.reconciliationException.update({ where: { id: exception.id }, data: { status: "OPEN" } }));
    await rejects(A, /never deleted/, (tx) => tx.reconciliationException.delete({ where: { id: exception.id } }));
    await withTenant(A.tenantId, async (tx) => {
      await tx.reconciliationRun.update({ where: { id: run.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    });
  });

  it("logs each external event once per (tenant, provider, externalId); a bad signature can only be rejected", async () => {
    const event = (over: Record<string, unknown> = {}) => ({
      tenantId: A.tenantId, provider: "demo", externalId: key("dup"), eventType: "payment.succeeded", payloadHash: "c".repeat(64), signatureValid: true, ...over,
    });
    const first = event();
    await withTenant(A.tenantId, (tx) => tx.paymentIntakeEvent.create({ data: first }));
    await rejects(A, /Unique constraint/, (tx) => tx.paymentIntakeEvent.create({ data: first }));
    await withTenant(B.tenantId, (tx) => tx.paymentIntakeEvent.create({ data: { ...first, tenantId: B.tenantId } }));
    await rejects(A, "payment_intake_event_hash_format", (tx) => tx.paymentIntakeEvent.create({ data: event({ payloadHash: "xyz" }) }));
    await rejects(A, "payment_intake_event_signature_gate", (tx) => tx.paymentIntakeEvent.create({ data: event({ signatureValid: false, status: "ACCEPTED" }) }));
    await rejects(A, "payment_intake_event_rejection_code", (tx) => tx.paymentIntakeEvent.create({ data: event({ signatureValid: false, status: "REJECTED" }) }));
    const rejected = await withTenant(A.tenantId, (tx) => tx.paymentIntakeEvent.create({ data: event({ signatureValid: false, status: "REJECTED", rejectionCode: "bad_signature" }) }));
    await rejects(A, /immutable/, (tx) => tx.paymentIntakeEvent.update({ where: { id: rejected.id }, data: { payloadHash: "d".repeat(64) } }));
    await rejects(A, /status transition REJECTED -> ACCEPTED/, (tx) => tx.paymentIntakeEvent.update({ where: { id: rejected.id }, data: { status: "ACCEPTED" } }));
    // Validation first, outcome second: RECEIVED moves to ACCEPTED once.
    const pending = await withTenant(A.tenantId, (tx) => tx.paymentIntakeEvent.create({ data: event() }));
    await withTenant(A.tenantId, (tx) => tx.paymentIntakeEvent.update({ where: { id: pending.id }, data: { status: "ACCEPTED", processedAt: new Date() } }));
    await rejects(A, /never deleted/, (tx) => tx.paymentIntakeEvent.delete({ where: { id: pending.id } }));
  });
});
