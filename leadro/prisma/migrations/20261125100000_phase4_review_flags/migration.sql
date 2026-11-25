-- Phase 4 follow-up (Task 1 completion): finance review flags (spec 11.7 "Flag for finance review", 25.4) and the
-- references reconciliation exceptions need (refund, outcome, scope unit). A second migration because
-- 20261124100000_phase4_financial_core had already been applied to the shared databases.
-- CreateEnum
CREATE TYPE "FinanceReviewFlagStatus" AS ENUM ('OPEN', 'ASSIGNED', 'RESOLVED');

-- AlterTable
ALTER TABLE "ReconciliationException" ADD COLUMN     "orgUnitId" TEXT,
ADD COLUMN     "outcomeId" TEXT,
ADD COLUMN     "refundId" TEXT;

-- CreateTable
CREATE TABLE "FinanceReviewFlag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "note" TEXT,
    "details" JSONB,
    "status" "FinanceReviewFlagStatus" NOT NULL DEFAULT 'OPEN',
    "jobId" TEXT,
    "customerId" TEXT,
    "outcomeId" TEXT,
    "paymentId" TEXT,
    "refundId" TEXT,
    "chargebackId" TEXT,
    "adjustmentId" TEXT,
    "ledgerEntryId" TEXT,
    "orgUnitId" TEXT,
    "idempotencyKey" TEXT,
    "raisedById" TEXT,
    "systemActor" TEXT,
    "raisedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "resolvedById" TEXT,
    "resolutionReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FinanceReviewFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FinanceReviewFlag_tenantId_status_raisedAt_idx" ON "FinanceReviewFlag"("tenantId", "status", "raisedAt");

-- CreateIndex
CREATE INDEX "FinanceReviewFlag_tenantId_orgUnitId_status_idx" ON "FinanceReviewFlag"("tenantId", "orgUnitId", "status");

-- CreateIndex
CREATE INDEX "FinanceReviewFlag_tenantId_jobId_idx" ON "FinanceReviewFlag"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "FinanceReviewFlag_tenantId_assignedToId_status_idx" ON "FinanceReviewFlag"("tenantId", "assignedToId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReviewFlag_id_tenantId_key" ON "FinanceReviewFlag"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FinanceReviewFlag_tenantId_idempotencyKey_key" ON "FinanceReviewFlag"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ReconciliationException_tenantId_orgUnitId_status_idx" ON "ReconciliationException"("tenantId", "orgUnitId", "status");

-- AddForeignKey
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_refundId_tenantId_fkey" FOREIGN KEY ("refundId", "tenantId") REFERENCES "Refund"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_outcomeId_tenantId_fkey" FOREIGN KEY ("outcomeId", "tenantId") REFERENCES "JobOutcome"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationException" ADD CONSTRAINT "ReconciliationException_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_outcomeId_tenantId_fkey" FOREIGN KEY ("outcomeId", "tenantId") REFERENCES "JobOutcome"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_paymentId_tenantId_fkey" FOREIGN KEY ("paymentId", "tenantId") REFERENCES "Payment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_refundId_tenantId_fkey" FOREIGN KEY ("refundId", "tenantId") REFERENCES "Refund"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_chargebackId_tenantId_fkey" FOREIGN KEY ("chargebackId", "tenantId") REFERENCES "Chargeback"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_adjustmentId_tenantId_fkey" FOREIGN KEY ("adjustmentId", "tenantId") REFERENCES "Adjustment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_ledgerEntryId_tenantId_fkey" FOREIGN KEY ("ledgerEntryId", "tenantId") REFERENCES "LedgerEntry"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_raisedById_tenantId_fkey" FOREIGN KEY ("raisedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_assignedToId_tenantId_fkey" FOREIGN KEY ("assignedToId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT "FinanceReviewFlag_resolvedById_tenantId_fkey" FOREIGN KEY ("resolvedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- Hand-written part: RLS, CHECKs, triggers. Names are part of the migration contract (tests/db/phase4-schema.test.ts).
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Row-level security (same policy as every tenant table) ─────────────
ALTER TABLE "FinanceReviewFlag" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FinanceReviewFlag" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FinanceReviewFlag";
CREATE POLICY tenant_isolation ON "FinanceReviewFlag"
  USING ("tenantId" = (SELECT NULLIF(current_setting('app.tenant_id', true), '')))
  WITH CHECK ("tenantId" = (SELECT NULLIF(current_setting('app.tenant_id', true), '')));

-- ───────────── Finance review flags ─────────────
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_reason_code_format
  CHECK (length("reasonCode") <= 100 AND "reasonCode" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$');
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_one_actor
  CHECK (("raisedById" IS NOT NULL) <> ("systemActor" IS NOT NULL));
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_system_actor_format
  CHECK ("systemActor" IS NULL OR "systemActor" ~ '^system:[a-z0-9][a-z0-9_.-]{0,62}$');
-- Free text comes from people only; a machine actor puts ids and codes in `details`.
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_note_by_person
  CHECK ("note" IS NULL OR "raisedById" IS NOT NULL);
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_subject CHECK (
  "jobId" IS NOT NULL OR "customerId" IS NOT NULL OR "outcomeId" IS NOT NULL OR "paymentId" IS NOT NULL
  OR "refundId" IS NOT NULL OR "chargebackId" IS NOT NULL OR "adjustmentId" IS NOT NULL OR "ledgerEntryId" IS NOT NULL
);
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_idempotency_key_present
  CHECK ("idempotencyKey" IS NULL OR length(btrim("idempotencyKey")) BETWEEN 1 AND 200);
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_assigned
  CHECK ("status" <> 'ASSIGNED' OR ("assignedToId" IS NOT NULL AND "assignedAt" IS NOT NULL));
ALTER TABLE "FinanceReviewFlag" ADD CONSTRAINT finance_review_flag_resolved CHECK (
  "status" <> 'RESOLVED'
  OR ("resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND length(btrim(coalesce("resolutionReason", ''))) > 0)
);
CREATE TRIGGER finance_review_flag_status
  BEFORE UPDATE ON "FinanceReviewFlag"
  FOR EACH ROW EXECUTE FUNCTION leadro_status_transitions('OPEN>ASSIGNED', 'OPEN>RESOLVED', 'ASSIGNED>OPEN', 'ASSIGNED>RESOLVED');
-- What was flagged, why and by whom never changes; only assignment and resolution move.
CREATE TRIGGER finance_review_flag_immutable
  BEFORE UPDATE ON "FinanceReviewFlag"
  FOR EACH ROW EXECUTE FUNCTION leadro_immutable_columns(
    'tenantId', 'reasonCode', 'note', 'details', 'jobId', 'customerId', 'outcomeId', 'paymentId', 'refundId', 'chargebackId',
    'adjustmentId', 'ledgerEntryId', 'orgUnitId', 'idempotencyKey', 'raisedById', 'systemActor', 'raisedAt', 'createdAt');
CREATE TRIGGER finance_review_flag_no_delete BEFORE DELETE ON "FinanceReviewFlag" FOR EACH ROW EXECUTE FUNCTION leadro_no_delete();

-- ───────────── Reconciliation exceptions: the new references ─────────────
ALTER TABLE "ReconciliationException" ADD CONSTRAINT reconciliation_exception_refund_reference
  CHECK ("kind" <> 'REFUND_WITHOUT_PAYMENT' OR "refundId" IS NOT NULL);
ALTER TABLE "ReconciliationException" ADD CONSTRAINT reconciliation_exception_outcome_reference
  CHECK ("kind" <> 'OUTCOME_LEDGER_MISMATCH' OR "outcomeId" IS NOT NULL);
-- The finding is frozen once recorded: the new columns join the immutable set.
DROP TRIGGER reconciliation_exception_immutable ON "ReconciliationException";
CREATE TRIGGER reconciliation_exception_immutable
  BEFORE UPDATE ON "ReconciliationException"
  FOR EACH ROW EXECUTE FUNCTION leadro_immutable_columns(
    'tenantId', 'runId', 'kind', 'jobId', 'paymentId', 'intakeEventId', 'refundId', 'outcomeId', 'orgUnitId', 'currency',
    'expectedAmountMinor', 'recordedAmountMinor', 'createdAt');
