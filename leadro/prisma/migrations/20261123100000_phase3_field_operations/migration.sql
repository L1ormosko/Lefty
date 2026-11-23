-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "LocationException" AS ENUM ('GPS_DISABLED', 'PERMISSION_DENIED', 'POOR_SIGNAL', 'DEVICE_OFFLINE', 'OUTSIDE_GEOFENCE', 'DELAYED', 'OTHER');

-- CreateEnum
CREATE TYPE "LocationEventKind" AS ENUM ('SHIFT_START', 'SHIFT_END', 'ARRIVAL', 'DEPARTURE', 'NAVIGATION_OPENED', 'VERIFICATION');

-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('DEVICE_GPS', 'GEOFENCE', 'MANUAL', 'MANAGER');

-- CreateEnum
CREATE TYPE "LocationVerification" AS ENUM ('UNVERIFIED', 'WITHIN_RADIUS', 'OUTSIDE_RADIUS', 'MANAGER_VERIFIED');

-- CreateEnum
CREATE TYPE "ArrivalMethod" AS ENUM ('TECHNICIAN', 'GEOFENCE', 'MANAGER');

-- CreateEnum
CREATE TYPE "ArrivalStatus" AS ENUM ('RECORDED', 'PENDING_MANAGER_REVIEW', 'MANAGER_VERIFIED', 'MANAGER_REJECTED');

-- CreateEnum
CREATE TYPE "FieldEventResult" AS ENUM ('ACCEPTED', 'REJECTED', 'CONFLICT');

-- CreateEnum
CREATE TYPE "FormDefinitionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "JobOutcomeType" AS ENUM ('SOLD', 'NOT_SOLD', 'CUSTOMER_UNAVAILABLE', 'RESCHEDULE_REQUIRED', 'WORK_NOT_POSSIBLE', 'ADDITIONAL_APPROVAL_REQUIRED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'CHECK', 'BANK_TRANSFER', 'FINANCING', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'PARTIAL', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "FieldNoteKind" AS ENUM ('NOTE', 'WORK_PERFORMED', 'ADDITIONAL_WORK_REQUESTED', 'CUSTOMER_APPROVAL');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('PHOTO', 'SIGNATURE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "AttachmentStatus" AS ENUM ('PENDING_UPLOAD', 'STORED', 'FAILED');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'INACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('NEW', 'ASSIGNED', 'CONTACTING', 'CUSTOMER_REACHED', 'FOLLOW_UP_REQUIRED', 'RECOVERED', 'NOT_RECOVERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PresenceStatus" AS ENUM ('AT_LOCATION', 'LEFT_LOCATION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FollowUpTargetType" AS ENUM ('LEAD', 'CUSTOMER', 'JOB', 'RECOVERY_CASE');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FollowUpOrigin" AS ENUM ('MANUAL', 'OUTCOME', 'RECOVERY_RULE', 'SYSTEM');

-- AlterTable
ALTER TABLE "CustomerAddress" ADD COLUMN     "geofenceRadiusM" INTEGER;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "arrivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "enRouteAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "OperationsSettings" ADD COLUMN     "arrivalGeofenceRadiusM" INTEGER NOT NULL DEFAULT 150,
ADD COLUMN     "followUpDueSoonMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "locationMaxAccuracyM" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "locationRetentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "presenceMaxAgeMinutes" INTEGER NOT NULL DEFAULT 30;

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "orgUnitId" TEXT,
    "status" "ShiftStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "startRecordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),
    "endRecordedAt" TIMESTAMPTZ(3),
    "deviceId" TEXT,
    "startLocationEventId" TEXT,
    "endLocationEventId" TEXT,
    "startException" "LocationException",
    "startExceptionNote" TEXT,
    "endException" "LocationException",
    "endExceptionNote" TEXT,
    "endedByUserId" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT,
    "jobId" TEXT,
    "orgUnitId" TEXT,
    "kind" "LocationEventKind" NOT NULL,
    "source" "LocationSource" NOT NULL,
    "verification" "LocationVerification" NOT NULL DEFAULT 'UNVERIFIED',
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "accuracyM" INTEGER,
    "distanceToJobM" INTEGER,
    "geofenceRadiusM" INTEGER,
    "deviceTime" TIMESTAMPTZ(3),
    "serverTime" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceId" TEXT,
    "exception" "LocationException",
    "exceptionNote" TEXT,
    "recordedByUserId" TEXT,
    "fieldEventId" TEXT,

    CONSTRAINT "LocationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArrivalVerification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "shiftId" TEXT,
    "method" "ArrivalMethod" NOT NULL,
    "status" "ArrivalStatus" NOT NULL DEFAULT 'RECORDED',
    "arrivedAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locationEventId" TEXT,
    "accuracyM" INTEGER,
    "distanceToJobM" INTEGER,
    "geofenceRadiusM" INTEGER,
    "exceptionReason" "LocationException",
    "exceptionNote" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "verificationNote" TEXT,
    "fieldEventId" TEXT,

    CONSTRAINT "ArrivalVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FieldEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "clientEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "jobId" TEXT,
    "shiftId" TEXT,
    "deviceId" TEXT,
    "batchId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "result" "FieldEventResult" NOT NULL,
    "resultCode" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,

    CONSTRAINT "FieldEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCompletionFormDefinition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobTypeId" TEXT,
    "category" TEXT,
    "version" INTEGER NOT NULL,
    "status" "FormDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "publishedById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobCompletionFormDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobCompletion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "visitNumber" INTEGER NOT NULL DEFAULT 1,
    "employeeId" TEXT NOT NULL,
    "formDefinitionId" TEXT NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "workPerformed" TEXT,
    "followUpRequired" BOOLEAN NOT NULL DEFAULT false,
    "signatureAttachmentId" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "clientEventId" TEXT,

    CONSTRAINT "JobCompletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobMaterialUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "completionId" TEXT,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "materialRef" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "note" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientEventId" TEXT,

    CONSTRAINT "JobMaterialUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobFieldNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "employeeId" TEXT,
    "kind" "FieldNoteKind" NOT NULL DEFAULT 'NOTE',
    "body" TEXT NOT NULL,
    "amountMinor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "customerApproved" BOOLEAN,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientEventId" TEXT,

    CONSTRAINT "JobFieldNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" "AttachmentKind" NOT NULL DEFAULT 'PHOTO',
    "status" "AttachmentStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "caption" TEXT,
    "storageProvider" TEXT,
    "storageKey" TEXT,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT,
    "clientEventId" TEXT,

    CONSTRAINT "JobAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LostReason" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "appliesTo" "JobOutcomeType"[] DEFAULT ARRAY['NOT_SOLD', 'WORK_NOT_POSSIBLE']::"JobOutcomeType"[],
    "recoverable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LostReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "visitNumber" INTEGER NOT NULL DEFAULT 1,
    "employeeId" TEXT,
    "outcome" "JobOutcomeType" NOT NULL,
    "lostReasonId" TEXT,
    "notes" TEXT,
    "quotedAmountMinor" INTEGER,
    "approvedAmountMinor" INTEGER,
    "chargedAmountMinor" INTEGER,
    "collectedAmountMinor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "paymentMethod" "PaymentMethod",
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "customerRequestedFollowUp" BOOLEAN NOT NULL DEFAULT false,
    "preferredFollowUpAt" TIMESTAMPTZ(3),
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,
    "clientEventId" TEXT,

    CONSTRAINT "JobOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "orgUnitId" TEXT,
    "highImpact" BOOLEAN NOT NULL DEFAULT false,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "submittedAt" TIMESTAMPTZ(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMPTZ(3),
    "activatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RecoveryRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadRecoveryCase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "jobOutcomeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "leadId" TEXT,
    "technicianId" TEXT,
    "orgUnitId" TEXT,
    "lostReasonId" TEXT,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'NEW',
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
    "priorityScore" INTEGER,
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMPTZ(3),
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "recommendation" TEXT,
    "outcomeAt" TIMESTAMPTZ(3) NOT NULL,
    "presenceStatus" "PresenceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "presenceEvaluatedAt" TIMESTAMPTZ(3),
    "presenceLocationEventId" TEXT,
    "presenceDistanceM" INTEGER,
    "presenceAccuracyM" INTEGER,
    "presenceReason" TEXT,
    "initialValueMinor" INTEGER,
    "estimatedValueMinor" INTEGER,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "recoveredAt" TIMESTAMPTZ(3),
    "recoveredAmountMinor" INTEGER,
    "collectedAmountMinor" INTEGER,
    "recoveredJobId" TEXT,
    "recoveredById" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadRecoveryCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCaseStatusHistory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "fromStatus" "RecoveryStatus",
    "toStatus" "RecoveryStatus" NOT NULL,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorUserId" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCaseStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryAttempt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "employeeId" TEXT,
    "channel" "ContactChannel" NOT NULL,
    "outcome" "ContactOutcome",
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSeconds" INTEGER,
    "notes" TEXT,
    "offeredAmountMinor" INTEGER,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT,

    CONSTRAINT "RecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "targetType" "FollowUpTargetType" NOT NULL,
    "leadId" TEXT,
    "customerId" TEXT,
    "jobId" TEXT,
    "recoveryCaseId" TEXT,
    "orgUnitId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "WorkPriority" NOT NULL DEFAULT 'NORMAL',
    "origin" "FollowUpOrigin" NOT NULL DEFAULT 'MANUAL',
    "assigneeId" TEXT,
    "assignedAt" TIMESTAMPTZ(3),
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "dedupeKey" TEXT,
    "dueSoonNotifiedAt" TIMESTAMPTZ(3),
    "overdueNotifiedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "completedById" TEXT,
    "completionNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "FollowUpTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shift_tenantId_employeeId_startedAt_idx" ON "Shift"("tenantId", "employeeId", "startedAt");

-- CreateIndex
CREATE INDEX "Shift_tenantId_status_startedAt_idx" ON "Shift"("tenantId", "status", "startedAt");

-- CreateIndex
CREATE INDEX "Shift_tenantId_orgUnitId_startedAt_idx" ON "Shift"("tenantId", "orgUnitId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_id_tenantId_key" ON "Shift"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_id_employeeId_tenantId_key" ON "Shift"("id", "employeeId", "tenantId");

-- CreateIndex
CREATE INDEX "LocationEvent_tenantId_employeeId_serverTime_idx" ON "LocationEvent"("tenantId", "employeeId", "serverTime");

-- CreateIndex
CREATE INDEX "LocationEvent_tenantId_jobId_kind_serverTime_idx" ON "LocationEvent"("tenantId", "jobId", "kind", "serverTime");

-- CreateIndex
CREATE INDEX "LocationEvent_tenantId_shiftId_idx" ON "LocationEvent"("tenantId", "shiftId");

-- CreateIndex
CREATE INDEX "LocationEvent_tenantId_serverTime_idx" ON "LocationEvent"("tenantId", "serverTime");

-- CreateIndex
CREATE UNIQUE INDEX "LocationEvent_id_tenantId_key" ON "LocationEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LocationEvent_id_jobId_tenantId_key" ON "LocationEvent"("id", "jobId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LocationEvent_tenantId_fieldEventId_key" ON "LocationEvent"("tenantId", "fieldEventId");

-- CreateIndex
CREATE INDEX "ArrivalVerification_tenantId_jobId_arrivedAt_idx" ON "ArrivalVerification"("tenantId", "jobId", "arrivedAt");

-- CreateIndex
CREATE INDEX "ArrivalVerification_tenantId_employeeId_arrivedAt_idx" ON "ArrivalVerification"("tenantId", "employeeId", "arrivedAt");

-- CreateIndex
CREATE INDEX "ArrivalVerification_tenantId_status_arrivedAt_idx" ON "ArrivalVerification"("tenantId", "status", "arrivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ArrivalVerification_id_tenantId_key" ON "ArrivalVerification"("id", "tenantId");

-- CreateIndex
CREATE INDEX "FieldEvent_tenantId_employeeId_occurredAt_idx" ON "FieldEvent"("tenantId", "employeeId", "occurredAt");

-- CreateIndex
CREATE INDEX "FieldEvent_tenantId_jobId_occurredAt_idx" ON "FieldEvent"("tenantId", "jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "FieldEvent_tenantId_batchId_idx" ON "FieldEvent"("tenantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldEvent_id_tenantId_key" ON "FieldEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FieldEvent_tenantId_employeeId_clientEventId_key" ON "FieldEvent"("tenantId", "employeeId", "clientEventId");

-- CreateIndex
CREATE INDEX "JobCompletionFormDefinition_tenantId_jobTypeId_status_idx" ON "JobCompletionFormDefinition"("tenantId", "jobTypeId", "status");

-- CreateIndex
CREATE INDEX "JobCompletionFormDefinition_tenantId_category_status_idx" ON "JobCompletionFormDefinition"("tenantId", "category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletionFormDefinition_id_tenantId_key" ON "JobCompletionFormDefinition"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletionFormDefinition_id_version_tenantId_key" ON "JobCompletionFormDefinition"("id", "version", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletionFormDefinition_tenantId_jobTypeId_version_key" ON "JobCompletionFormDefinition"("tenantId", "jobTypeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletionFormDefinition_tenantId_category_version_key" ON "JobCompletionFormDefinition"("tenantId", "category", "version");

-- CreateIndex
CREATE INDEX "JobCompletion_tenantId_employeeId_submittedAt_idx" ON "JobCompletion"("tenantId", "employeeId", "submittedAt");

-- CreateIndex
CREATE INDEX "JobCompletion_tenantId_formDefinitionId_idx" ON "JobCompletion"("tenantId", "formDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletion_id_tenantId_key" ON "JobCompletion"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletion_tenantId_jobId_visitNumber_key" ON "JobCompletion"("tenantId", "jobId", "visitNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JobCompletion_tenantId_jobId_clientEventId_key" ON "JobCompletion"("tenantId", "jobId", "clientEventId");

-- CreateIndex
CREATE INDEX "JobMaterialUsage_tenantId_jobId_occurredAt_idx" ON "JobMaterialUsage"("tenantId", "jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "JobMaterialUsage_tenantId_completionId_idx" ON "JobMaterialUsage"("tenantId", "completionId");

-- CreateIndex
CREATE UNIQUE INDEX "JobMaterialUsage_id_tenantId_key" ON "JobMaterialUsage"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobMaterialUsage_tenantId_jobId_clientEventId_key" ON "JobMaterialUsage"("tenantId", "jobId", "clientEventId");

-- CreateIndex
CREATE INDEX "JobFieldNote_tenantId_jobId_occurredAt_idx" ON "JobFieldNote"("tenantId", "jobId", "occurredAt");

-- CreateIndex
CREATE INDEX "JobFieldNote_tenantId_kind_occurredAt_idx" ON "JobFieldNote"("tenantId", "kind", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobFieldNote_id_tenantId_key" ON "JobFieldNote"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobFieldNote_tenantId_jobId_clientEventId_key" ON "JobFieldNote"("tenantId", "jobId", "clientEventId");

-- CreateIndex
CREATE INDEX "JobAttachment_tenantId_jobId_capturedAt_idx" ON "JobAttachment"("tenantId", "jobId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttachment_id_tenantId_key" ON "JobAttachment"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobAttachment_tenantId_jobId_clientEventId_key" ON "JobAttachment"("tenantId", "jobId", "clientEventId");

-- CreateIndex
CREATE INDEX "LostReason_tenantId_active_sortOrder_idx" ON "LostReason"("tenantId", "active", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "LostReason_id_tenantId_key" ON "LostReason"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LostReason_tenantId_code_key" ON "LostReason"("tenantId", "code");

-- CreateIndex
CREATE INDEX "JobOutcome_tenantId_outcome_occurredAt_idx" ON "JobOutcome"("tenantId", "outcome", "occurredAt");

-- CreateIndex
CREATE INDEX "JobOutcome_tenantId_lostReasonId_idx" ON "JobOutcome"("tenantId", "lostReasonId");

-- CreateIndex
CREATE INDEX "JobOutcome_tenantId_employeeId_occurredAt_idx" ON "JobOutcome"("tenantId", "employeeId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobOutcome_id_tenantId_key" ON "JobOutcome"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobOutcome_id_jobId_tenantId_key" ON "JobOutcome"("id", "jobId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "JobOutcome_tenantId_jobId_visitNumber_key" ON "JobOutcome"("tenantId", "jobId", "visitNumber");

-- CreateIndex
CREATE UNIQUE INDEX "JobOutcome_tenantId_jobId_clientEventId_key" ON "JobOutcome"("tenantId", "jobId", "clientEventId");

-- CreateIndex
CREATE INDEX "RecoveryRule_tenantId_status_trigger_priority_idx" ON "RecoveryRule"("tenantId", "status", "trigger", "priority");

-- CreateIndex
CREATE INDEX "RecoveryRule_tenantId_orgUnitId_idx" ON "RecoveryRule"("tenantId", "orgUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRule_id_tenantId_key" ON "RecoveryRule"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryRule_tenantId_ruleKey_version_key" ON "RecoveryRule"("tenantId", "ruleKey", "version");

-- CreateIndex
CREATE INDEX "LeadRecoveryCase_tenantId_status_priority_outcomeAt_idx" ON "LeadRecoveryCase"("tenantId", "status", "priority", "outcomeAt");

-- CreateIndex
CREATE INDEX "LeadRecoveryCase_tenantId_orgUnitId_status_idx" ON "LeadRecoveryCase"("tenantId", "orgUnitId", "status");

-- CreateIndex
CREATE INDEX "LeadRecoveryCase_tenantId_assignedToId_status_idx" ON "LeadRecoveryCase"("tenantId", "assignedToId", "status");

-- CreateIndex
CREATE INDEX "LeadRecoveryCase_tenantId_jobId_idx" ON "LeadRecoveryCase"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "LeadRecoveryCase_tenantId_customerId_idx" ON "LeadRecoveryCase"("tenantId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadRecoveryCase_id_tenantId_key" ON "LeadRecoveryCase"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadRecoveryCase_tenantId_number_key" ON "LeadRecoveryCase"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "LeadRecoveryCase_tenantId_jobOutcomeId_key" ON "LeadRecoveryCase"("tenantId", "jobOutcomeId");

-- CreateIndex
CREATE INDEX "RecoveryCaseStatusHistory_tenantId_caseId_occurredAt_idx" ON "RecoveryCaseStatusHistory"("tenantId", "caseId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCaseStatusHistory_id_tenantId_key" ON "RecoveryCaseStatusHistory"("id", "tenantId");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_tenantId_caseId_occurredAt_idx" ON "RecoveryAttempt"("tenantId", "caseId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecoveryAttempt_tenantId_employeeId_occurredAt_idx" ON "RecoveryAttempt"("tenantId", "employeeId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryAttempt_id_tenantId_key" ON "RecoveryAttempt"("id", "tenantId");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_status_dueAt_idx" ON "FollowUpTask"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_assigneeId_status_dueAt_idx" ON "FollowUpTask"("tenantId", "assigneeId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_orgUnitId_status_idx" ON "FollowUpTask"("tenantId", "orgUnitId", "status");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_targetType_status_idx" ON "FollowUpTask"("tenantId", "targetType", "status");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_leadId_idx" ON "FollowUpTask"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_customerId_idx" ON "FollowUpTask"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_jobId_idx" ON "FollowUpTask"("tenantId", "jobId");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_recoveryCaseId_idx" ON "FollowUpTask"("tenantId", "recoveryCaseId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpTask_id_tenantId_key" ON "FollowUpTask"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpTask_tenantId_dedupeKey_key" ON "FollowUpTask"("tenantId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Job_id_customerId_tenantId_key" ON "Job"("id", "customerId", "tenantId");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_startLocationEventId_tenantId_fkey" FOREIGN KEY ("startLocationEventId", "tenantId") REFERENCES "LocationEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_endLocationEventId_tenantId_fkey" FOREIGN KEY ("endLocationEventId", "tenantId") REFERENCES "LocationEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_endedByUserId_tenantId_fkey" FOREIGN KEY ("endedByUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_shiftId_employeeId_tenantId_fkey" FOREIGN KEY ("shiftId", "employeeId", "tenantId") REFERENCES "Shift"("id", "employeeId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_recordedByUserId_tenantId_fkey" FOREIGN KEY ("recordedByUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationEvent" ADD CONSTRAINT "LocationEvent_fieldEventId_tenantId_fkey" FOREIGN KEY ("fieldEventId", "tenantId") REFERENCES "FieldEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT "ArrivalVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT "ArrivalVerification_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT "ArrivalVerification_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT "ArrivalVerification_shiftId_employeeId_tenantId_fkey" FOREIGN KEY ("shiftId", "employeeId", "tenantId") REFERENCES "Shift"("id", "employeeId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT "ArrivalVerification_locationEventId_jobId_tenantId_fkey" FOREIGN KEY ("locationEventId", "jobId", "tenantId") REFERENCES "LocationEvent"("id", "jobId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT "ArrivalVerification_verifiedByUserId_tenantId_fkey" FOREIGN KEY ("verifiedByUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldEvent" ADD CONSTRAINT "FieldEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldEvent" ADD CONSTRAINT "FieldEvent_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldEvent" ADD CONSTRAINT "FieldEvent_actorUserId_tenantId_fkey" FOREIGN KEY ("actorUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldEvent" ADD CONSTRAINT "FieldEvent_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldEvent" ADD CONSTRAINT "FieldEvent_shiftId_employeeId_tenantId_fkey" FOREIGN KEY ("shiftId", "employeeId", "tenantId") REFERENCES "Shift"("id", "employeeId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT "JobCompletionFormDefinition_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT "JobCompletionFormDefinition_jobTypeId_tenantId_fkey" FOREIGN KEY ("jobTypeId", "tenantId") REFERENCES "JobType"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT "JobCompletionFormDefinition_publishedById_tenantId_fkey" FOREIGN KEY ("publishedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT "JobCompletionFormDefinition_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletion" ADD CONSTRAINT "JobCompletion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletion" ADD CONSTRAINT "JobCompletion_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletion" ADD CONSTRAINT "JobCompletion_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletion" ADD CONSTRAINT "JobCompletion_formDefinitionId_formVersion_tenantId_fkey" FOREIGN KEY ("formDefinitionId", "formVersion", "tenantId") REFERENCES "JobCompletionFormDefinition"("id", "version", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletion" ADD CONSTRAINT "JobCompletion_signatureAttachmentId_tenantId_fkey" FOREIGN KEY ("signatureAttachmentId", "tenantId") REFERENCES "JobAttachment"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobCompletion" ADD CONSTRAINT "JobCompletion_submittedById_tenantId_fkey" FOREIGN KEY ("submittedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMaterialUsage" ADD CONSTRAINT "JobMaterialUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMaterialUsage" ADD CONSTRAINT "JobMaterialUsage_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMaterialUsage" ADD CONSTRAINT "JobMaterialUsage_completionId_tenantId_fkey" FOREIGN KEY ("completionId", "tenantId") REFERENCES "JobCompletion"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobMaterialUsage" ADD CONSTRAINT "JobMaterialUsage_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFieldNote" ADD CONSTRAINT "JobFieldNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFieldNote" ADD CONSTRAINT "JobFieldNote_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobFieldNote" ADD CONSTRAINT "JobFieldNote_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttachment" ADD CONSTRAINT "JobAttachment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttachment" ADD CONSTRAINT "JobAttachment_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAttachment" ADD CONSTRAINT "JobAttachment_uploadedById_tenantId_fkey" FOREIGN KEY ("uploadedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LostReason" ADD CONSTRAINT "LostReason_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOutcome" ADD CONSTRAINT "JobOutcome_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOutcome" ADD CONSTRAINT "JobOutcome_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOutcome" ADD CONSTRAINT "JobOutcome_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOutcome" ADD CONSTRAINT "JobOutcome_lostReasonId_tenantId_fkey" FOREIGN KEY ("lostReasonId", "tenantId") REFERENCES "LostReason"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOutcome" ADD CONSTRAINT "JobOutcome_recordedById_tenantId_fkey" FOREIGN KEY ("recordedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRule" ADD CONSTRAINT "RecoveryRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRule" ADD CONSTRAINT "RecoveryRule_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRule" ADD CONSTRAINT "RecoveryRule_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryRule" ADD CONSTRAINT "RecoveryRule_approvedById_tenantId_fkey" FOREIGN KEY ("approvedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_jobOutcomeId_jobId_tenantId_fkey" FOREIGN KEY ("jobOutcomeId", "jobId", "tenantId") REFERENCES "JobOutcome"("id", "jobId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_jobId_customerId_tenantId_fkey" FOREIGN KEY ("jobId", "customerId", "tenantId") REFERENCES "Job"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_leadId_customerId_tenantId_fkey" FOREIGN KEY ("leadId", "customerId", "tenantId") REFERENCES "Lead"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_technicianId_tenantId_fkey" FOREIGN KEY ("technicianId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_lostReasonId_tenantId_fkey" FOREIGN KEY ("lostReasonId", "tenantId") REFERENCES "LostReason"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_assignedToId_tenantId_fkey" FOREIGN KEY ("assignedToId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_ruleId_tenantId_fkey" FOREIGN KEY ("ruleId", "tenantId") REFERENCES "RecoveryRule"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_presenceLocationEventId_tenantId_fkey" FOREIGN KEY ("presenceLocationEventId", "tenantId") REFERENCES "LocationEvent"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_recoveredJobId_customerId_tenantId_fkey" FOREIGN KEY ("recoveredJobId", "customerId", "tenantId") REFERENCES "Job"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT "LeadRecoveryCase_recoveredById_tenantId_fkey" FOREIGN KEY ("recoveredById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCaseStatusHistory" ADD CONSTRAINT "RecoveryCaseStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCaseStatusHistory" ADD CONSTRAINT "RecoveryCaseStatusHistory_caseId_tenantId_fkey" FOREIGN KEY ("caseId", "tenantId") REFERENCES "LeadRecoveryCase"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCaseStatusHistory" ADD CONSTRAINT "RecoveryCaseStatusHistory_actorUserId_tenantId_fkey" FOREIGN KEY ("actorUserId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_caseId_tenantId_fkey" FOREIGN KEY ("caseId", "tenantId") REFERENCES "LeadRecoveryCase"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT "RecoveryAttempt_recordedById_tenantId_fkey" FOREIGN KEY ("recordedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_leadId_tenantId_fkey" FOREIGN KEY ("leadId", "tenantId") REFERENCES "Lead"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_jobId_tenantId_fkey" FOREIGN KEY ("jobId", "tenantId") REFERENCES "Job"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_recoveryCaseId_tenantId_fkey" FOREIGN KEY ("recoveryCaseId", "tenantId") REFERENCES "LeadRecoveryCase"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_assigneeId_tenantId_fkey" FOREIGN KEY ("assigneeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_completedById_tenantId_fkey" FOREIGN KEY ("completedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- Hand-written part (Prisma cannot express it): RLS, partial unique indexes, triggers, CHECKs.
-- Constraint and index names below are part of the migration contract (tests/db/phase3-schema.test.ts).
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- ───────────── Row-level security ─────────────
-- Same fail-closed DO-block as Phase 1/2: every table with a "tenantId" column (the 16 new ones included)
-- is ENABLEd + FORCEd and gets the tenant_isolation policy. Re-running it is idempotent.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT NULLIF(current_setting(''app.tenant_id'', true), ''''))) WITH CHECK ("tenantId" = (SELECT NULLIF(current_setting(''app.tenant_id'', true), '''')))',
      t.table_name
    );
  END LOOP;
END
$$;

-- ───────────── Append-only history ─────────────
-- leadro_append_only() was created in the Phase 2 migration.
CREATE TRIGGER recovery_case_status_history_no_update_delete
  BEFORE UPDATE OR DELETE ON "RecoveryCaseStatusHistory"
  FOR EACH ROW EXECUTE FUNCTION leadro_append_only();
CREATE TRIGGER recovery_case_status_history_no_truncate
  BEFORE TRUNCATE ON "RecoveryCaseStatusHistory"
  FOR EACH STATEMENT EXECUTE FUNCTION leadro_append_only();

-- ───────────── Completion form definitions are immutable once published ─────────────
-- Only a DRAFT may change its schema, version or target; status moves DRAFT -> ACTIVE -> RETIRED only.
-- Submitted completions point at (id, version), so a published schema must never change under them.
CREATE OR REPLACE FUNCTION leadro_form_definition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."schema" IS DISTINCT FROM OLD."schema"
       OR NEW."version" <> OLD."version"
       OR NEW."jobTypeId" IS DISTINCT FROM OLD."jobTypeId"
       OR NEW."category" IS DISTINCT FROM OLD."category" THEN
      RAISE EXCEPTION 'a published completion form definition is immutable (id %)', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."status" = 'DRAFT' OR (OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED') THEN
      RAISE EXCEPTION 'completion form definition status cannot move back from % to %', OLD."status", NEW."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER job_completion_form_definition_guard
  BEFORE UPDATE ON "JobCompletionFormDefinition"
  FOR EACH ROW EXECUTE FUNCTION leadro_form_definition_guard();

-- ───────────── Partial unique indexes: "at most one ACTIVE ..." ─────────────
-- An employee has at most one running shift (this also makes "start shift" idempotent).
CREATE UNIQUE INDEX "Shift_one_active_per_employee"
  ON "Shift" ("tenantId", "employeeId") WHERE "status" = 'ACTIVE';
-- A job type / a category has at most one ACTIVE completion form version.
CREATE UNIQUE INDEX "JobCompletionFormDefinition_one_active_per_job_type"
  ON "JobCompletionFormDefinition" ("tenantId", "jobTypeId") WHERE "status" = 'ACTIVE' AND "jobTypeId" IS NOT NULL;
CREATE UNIQUE INDEX "JobCompletionFormDefinition_one_active_per_category"
  ON "JobCompletionFormDefinition" ("tenantId", "category") WHERE "status" = 'ACTIVE' AND "category" IS NOT NULL;
-- A recovery rule key has at most one ACTIVE version.
CREATE UNIQUE INDEX "RecoveryRule_one_active_per_key"
  ON "RecoveryRule" ("tenantId", "ruleKey") WHERE "status" = 'ACTIVE';
-- Sweeps scan only unfinished work.
CREATE INDEX "FollowUpTask_open_due_idx"
  ON "FollowUpTask" ("tenantId", "dueAt") WHERE "status" IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX "ArrivalVerification_pending_review_idx"
  ON "ArrivalVerification" ("tenantId", "arrivedAt") WHERE "status" = 'PENDING_MANAGER_REVIEW';

-- ───────────── Value domains ─────────────
ALTER TABLE "LostReason" ADD CONSTRAINT lost_reason_code_format CHECK ("code" ~ '^[a-z0-9][a-z0-9_-]{0,62}$');
ALTER TABLE "LostReason" ADD CONSTRAINT lost_reason_name_present CHECK (length(btrim("name")) > 0);
ALTER TABLE "LostReason" ADD CONSTRAINT lost_reason_applies_to_present CHECK (cardinality("appliesTo") > 0);

ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_key_format CHECK ("ruleKey" ~ '^[a-z0-9][a-z0-9_.-]{0,62}$');
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_trigger_format CHECK ("trigger" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$');
ALTER TABLE "FieldEvent" ADD CONSTRAINT field_event_type_format CHECK ("type" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$');
ALTER TABLE "FieldEvent" ADD CONSTRAINT field_event_client_event_id_uuid
  CHECK ("clientEventId" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE "JobOutcome" ADD CONSTRAINT job_outcome_currency_format CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "JobFieldNote" ADD CONSTRAINT job_field_note_currency_format CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_currency_format CHECK ("currency" ~ '^[A-Z]{3}$');

-- ───────────── Operations settings (Phase 3 knobs) ─────────────
ALTER TABLE "OperationsSettings" ADD CONSTRAINT operations_settings_location_ranges CHECK (
  "arrivalGeofenceRadiusM" BETWEEN 10 AND 5000
  AND "locationMaxAccuracyM" BETWEEN 1 AND 10000
  AND "presenceMaxAgeMinutes" BETWEEN 1 AND 1440
  AND "locationRetentionDays" BETWEEN 1 AND 3650
  AND "followUpDueSoonMinutes" >= 0
);
ALTER TABLE "CustomerAddress" ADD CONSTRAINT customer_address_geofence_radius
  CHECK ("geofenceRadiusM" IS NULL OR "geofenceRadiusM" BETWEEN 10 AND 5000);

-- ───────────── Shifts ─────────────
ALTER TABLE "Shift" ADD CONSTRAINT shift_state_ended CHECK (
  ("status" = 'ACTIVE' AND "endedAt" IS NULL AND "endRecordedAt" IS NULL AND "endException" IS NULL AND "endLocationEventId" IS NULL) OR
  ("status" = 'ENDED' AND "endedAt" IS NOT NULL AND "endRecordedAt" IS NOT NULL)
);
ALTER TABLE "Shift" ADD CONSTRAINT shift_dates CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");
-- Ended or corrected by someone else: say why (separation of duties / audit trail).
ALTER TABLE "Shift" ADD CONSTRAINT shift_end_by_other_needs_reason
  CHECK ("endedByUserId" IS NULL OR length(btrim(coalesce("endReason", ''))) > 0);
ALTER TABLE "Shift" ADD CONSTRAINT shift_other_exception_needs_note CHECK (
  ("startException" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("startExceptionNote", ''))) > 0) AND
  ("endException" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("endExceptionNote", ''))) > 0)
);

-- ───────────── Location events (sensitive, spec 17) ─────────────
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_latitude_range CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_longitude_range CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_coordinates_pair CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
-- Spec 17.2: every position carries its accuracy; accuracy is a non-negative radius in meters.
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_accuracy_with_coordinates
  CHECK ("latitude" IS NULL OR "accuracyM" IS NOT NULL);
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_accuracy_range CHECK ("accuracyM" IS NULL OR "accuracyM" BETWEEN 0 AND 100000);
-- Device-sourced events must say what the device clock read (the server time is always recorded).
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_device_time_required
  CHECK ("source" NOT IN ('DEVICE_GPS', 'GEOFENCE') OR "deviceTime" IS NOT NULL);
-- No position needs an explanation: an exception (GPS off, denied, offline ...), a manual / manager entry, or a pure navigation event.
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_position_or_reason CHECK (
  "latitude" IS NOT NULL OR "exception" IS NOT NULL OR "source" IN ('MANUAL', 'MANAGER') OR "kind" = 'NAVIGATION_OPENED'
);
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_manager_recorder
  CHECK ("source" <> 'MANAGER' OR "recordedByUserId" IS NOT NULL);
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_job_kinds_need_job
  CHECK ("kind" NOT IN ('ARRIVAL', 'DEPARTURE', 'NAVIGATION_OPENED') OR "jobId" IS NOT NULL);
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_shift_kinds_need_shift
  CHECK ("kind" NOT IN ('SHIFT_START', 'SHIFT_END') OR "shiftId" IS NOT NULL);
-- A distance and the radius it was judged against come together; a radius verdict needs both and a position.
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_distance_pair
  CHECK (("distanceToJobM" IS NULL) = ("geofenceRadiusM" IS NULL));
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_distance_range
  CHECK (("distanceToJobM" IS NULL OR "distanceToJobM" >= 0) AND ("geofenceRadiusM" IS NULL OR "geofenceRadiusM" BETWEEN 1 AND 5000));
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_radius_verdict_needs_data CHECK (
  "verification" NOT IN ('WITHIN_RADIUS', 'OUTSIDE_RADIUS')
  OR ("latitude" IS NOT NULL AND "distanceToJobM" IS NOT NULL AND "jobId" IS NOT NULL)
);
ALTER TABLE "LocationEvent" ADD CONSTRAINT location_event_other_exception_needs_note
  CHECK ("exception" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("exceptionNote", ''))) > 0);

-- ───────────── Arrival verification ─────────────
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT arrival_verification_geofence_needs_event
  CHECK ("method" <> 'GEOFENCE' OR ("locationEventId" IS NOT NULL AND "accuracyM" IS NOT NULL));
-- A manager's own entry is a verification by definition; a manager decision (verify or reject) records who, when and why.
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT arrival_verification_manager_method
  CHECK ("method" <> 'MANAGER' OR "status" = 'MANAGER_VERIFIED');
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT arrival_verification_decision CHECK (
  ("status" IN ('MANAGER_VERIFIED', 'MANAGER_REJECTED')
     AND "verifiedByUserId" IS NOT NULL AND "verifiedAt" IS NOT NULL AND length(btrim(coalesce("verificationNote", ''))) > 0) OR
  ("status" IN ('RECORDED', 'PENDING_MANAGER_REVIEW') AND "verifiedByUserId" IS NULL AND "verifiedAt" IS NULL)
);
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT arrival_verification_pending_needs_exception
  CHECK ("status" <> 'PENDING_MANAGER_REVIEW' OR "exceptionReason" IS NOT NULL);
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT arrival_verification_ranges CHECK (
  ("accuracyM" IS NULL OR "accuracyM" BETWEEN 0 AND 100000)
  AND ("distanceToJobM" IS NULL OR "distanceToJobM" >= 0)
  AND ("geofenceRadiusM" IS NULL OR "geofenceRadiusM" BETWEEN 1 AND 5000)
);
ALTER TABLE "ArrivalVerification" ADD CONSTRAINT arrival_verification_other_exception_needs_note
  CHECK ("exceptionReason" IS DISTINCT FROM 'OTHER' OR length(btrim(coalesce("exceptionNote", ''))) > 0);

-- ───────────── Field events ─────────────
ALTER TABLE "FieldEvent" ADD CONSTRAINT field_event_result_code
  CHECK (("result" = 'ACCEPTED' AND "resultCode" IS NULL) OR ("result" <> 'ACCEPTED' AND length(btrim(coalesce("resultCode", ''))) > 0));
ALTER TABLE "FieldEvent" ADD CONSTRAINT field_event_entity_pair CHECK (("entityType" IS NULL) = ("entityId" IS NULL));

-- ───────────── Completion forms and submissions ─────────────
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT job_completion_form_target CHECK (
  ("jobTypeId" IS NOT NULL AND "category" IS NULL) OR ("jobTypeId" IS NULL AND "category" IS NOT NULL AND length(btrim("category")) > 0)
);
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT job_completion_form_version_positive CHECK ("version" >= 1);
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT job_completion_form_published
  CHECK ("status" = 'DRAFT' OR "publishedAt" IS NOT NULL);
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT job_completion_form_schema_shape
  CHECK (jsonb_typeof("schema") = 'object' AND jsonb_typeof("schema" -> 'fields') = 'array');
ALTER TABLE "JobCompletionFormDefinition" ADD CONSTRAINT job_completion_form_name_present CHECK (length(btrim("name")) > 0);

ALTER TABLE "JobCompletion" ADD CONSTRAINT job_completion_visit_positive CHECK ("visitNumber" >= 1);
ALTER TABLE "JobCompletion" ADD CONSTRAINT job_completion_values_shape CHECK (jsonb_typeof("values") = 'object');

ALTER TABLE "JobMaterialUsage" ADD CONSTRAINT job_material_usage_quantity_positive CHECK ("quantity" > 0);
ALTER TABLE "JobMaterialUsage" ADD CONSTRAINT job_material_usage_name_present CHECK (length(btrim("name")) > 0 AND length(btrim("unit")) > 0);

ALTER TABLE "JobFieldNote" ADD CONSTRAINT job_field_note_body_present CHECK (length(btrim("body")) > 0);
ALTER TABLE "JobFieldNote" ADD CONSTRAINT job_field_note_amount CHECK (
  "amountMinor" IS NULL OR ("amountMinor" >= 0 AND "kind" IN ('ADDITIONAL_WORK_REQUESTED', 'CUSTOMER_APPROVAL'))
);
ALTER TABLE "JobFieldNote" ADD CONSTRAINT job_field_note_approval_flag
  CHECK ("customerApproved" IS NULL OR "kind" = 'CUSTOMER_APPROVAL');

-- No storage provider: a row is only STORED with a key and the provider that holds it.
ALTER TABLE "JobAttachment" ADD CONSTRAINT job_attachment_stored_needs_key
  CHECK ("status" <> 'STORED' OR ("storageKey" IS NOT NULL AND "storageProvider" IS NOT NULL));
ALTER TABLE "JobAttachment" ADD CONSTRAINT job_attachment_size_range CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 104857600);
ALTER TABLE "JobAttachment" ADD CONSTRAINT job_attachment_checksum_format
  CHECK ("checksumSha256" IS NULL OR "checksumSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "JobAttachment" ADD CONSTRAINT job_attachment_content_type_format
  CHECK ("contentType" ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$');
ALTER TABLE "JobAttachment" ADD CONSTRAINT job_attachment_file_name_present CHECK (length(btrim("fileName")) > 0);

-- ───────────── Outcomes ─────────────
ALTER TABLE "JobOutcome" ADD CONSTRAINT job_outcome_visit_positive CHECK ("visitNumber" >= 1);
ALTER TABLE "JobOutcome" ADD CONSTRAINT job_outcome_amounts_non_negative CHECK (
  ("quotedAmountMinor" IS NULL OR "quotedAmountMinor" >= 0) AND
  ("approvedAmountMinor" IS NULL OR "approvedAmountMinor" >= 0) AND
  ("chargedAmountMinor" IS NULL OR "chargedAmountMinor" >= 0) AND
  ("collectedAmountMinor" IS NULL OR "collectedAmountMinor" >= 0)
);
-- Spec 9.1: unsuccessful outcomes need a reason; a SOLD outcome has none. (Customer unavailable / reschedule
-- are their own reason; whether a tenant also wants one there is a service-level setting.)
ALTER TABLE "JobOutcome" ADD CONSTRAINT job_outcome_reason_rules CHECK (
  ("outcome" IN ('NOT_SOLD', 'WORK_NOT_POSSIBLE') AND "lostReasonId" IS NOT NULL) OR
  ("outcome" = 'SOLD' AND "lostReasonId" IS NULL) OR
  ("outcome" IN ('CUSTOMER_UNAVAILABLE', 'RESCHEDULE_REQUIRED', 'ADDITIONAL_APPROVAL_REQUIRED'))
);
ALTER TABLE "JobOutcome" ADD CONSTRAINT job_outcome_payment_collected CHECK (
  "paymentStatus" NOT IN ('PARTIAL', 'PAID') OR ("collectedAmountMinor" IS NOT NULL AND "paymentMethod" IS NOT NULL)
);

-- ───────────── Recovery rules ─────────────
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_ranges
  CHECK ("version" >= 1 AND "priority" BETWEEN 0 AND 10000 AND "cooldownMinutes" >= 0);
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_json_shape
  CHECK (jsonb_typeof("conditions") = 'object' AND jsonb_typeof("actions") = 'array');
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_name_present CHECK (length(btrim("name")) > 0);
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_pending_submitted
  CHECK ("status" <> 'PENDING_APPROVAL' OR "submittedAt" IS NOT NULL);
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_active_activated
  CHECK ("status" <> 'ACTIVE' OR "activatedAt" IS NOT NULL);
-- Separation of duties (spec 21.3): a high-impact rule is only ACTIVE after someone OTHER than its author approved it.
ALTER TABLE "RecoveryRule" ADD CONSTRAINT recovery_rule_high_impact_approval CHECK (
  NOT ("highImpact" AND "status" = 'ACTIVE')
  OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND ("createdById" IS NULL OR "approvedById" <> "createdById"))
);

-- ───────────── Recovery cases ─────────────
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_number_positive CHECK ("number" > 0);
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_amounts_non_negative CHECK (
  ("initialValueMinor" IS NULL OR "initialValueMinor" >= 0) AND
  ("estimatedValueMinor" IS NULL OR "estimatedValueMinor" >= 0) AND
  ("recoveredAmountMinor" IS NULL OR "recoveredAmountMinor" >= 0) AND
  ("collectedAmountMinor" IS NULL OR "collectedAmountMinor" >= 0) AND
  ("presenceDistanceM" IS NULL OR "presenceDistanceM" >= 0) AND
  ("presenceAccuracyM" IS NULL OR "presenceAccuracyM" >= 0) AND
  "attemptCount" >= 0
);
-- Spec 9.7: confirmed revenue (recovered / collected amounts, the recovered job) exists only with a recovery time,
-- and a RECOVERED case has one. Estimates live in their own column.
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_confirmed_needs_time CHECK (
  ("recoveredAmountMinor" IS NULL AND "collectedAmountMinor" IS NULL AND "recoveredJobId" IS NULL AND "recoveredById" IS NULL) OR "recoveredAt" IS NOT NULL
);
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_recovered_has_time
  CHECK ("status" <> 'RECOVERED' OR "recoveredAt" IS NOT NULL);
-- NOT_RECOVERED and CLOSED are the finished states; nothing else has a closing time.
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_closed_state
  CHECK (("status" IN ('NOT_RECOVERED', 'CLOSED')) = ("closedAt" IS NOT NULL));
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_assigned_has_owner
  CHECK ("status" <> 'ASSIGNED' OR "assignedToId" IS NOT NULL);
-- Presence (spec 26.5): AT / LEFT need the location they were derived from, its accuracy and the evaluation time.
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_presence_evidence CHECK (
  "presenceStatus" = 'UNKNOWN'
  OR ("presenceLocationEventId" IS NOT NULL AND "presenceAccuracyM" IS NOT NULL AND "presenceEvaluatedAt" IS NOT NULL)
);
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_not_own_recovery CHECK ("recoveredJobId" IS NULL OR "recoveredJobId" <> "jobId");
ALTER TABLE "LeadRecoveryCase" ADD CONSTRAINT lead_recovery_case_rule_version_pair CHECK (("ruleId" IS NULL) = ("ruleVersion" IS NULL));

ALTER TABLE "RecoveryCaseStatusHistory" ADD CONSTRAINT recovery_case_status_history_changed
  CHECK ("fromStatus" IS NULL OR "fromStatus" <> "toStatus");
ALTER TABLE "RecoveryAttempt" ADD CONSTRAINT recovery_attempt_ranges CHECK (
  ("durationSeconds" IS NULL OR "durationSeconds" >= 0) AND ("offeredAmountMinor" IS NULL OR "offeredAmountMinor" >= 0)
);

-- ───────────── Follow-up tasks ─────────────
-- Exactly the target column that matches targetType is set.
ALTER TABLE "FollowUpTask" ADD CONSTRAINT follow_up_task_target_shape CHECK (
  ("targetType" = 'LEAD' AND "leadId" IS NOT NULL AND "customerId" IS NULL AND "jobId" IS NULL AND "recoveryCaseId" IS NULL) OR
  ("targetType" = 'CUSTOMER' AND "customerId" IS NOT NULL AND "leadId" IS NULL AND "jobId" IS NULL AND "recoveryCaseId" IS NULL) OR
  ("targetType" = 'JOB' AND "jobId" IS NOT NULL AND "leadId" IS NULL AND "customerId" IS NULL AND "recoveryCaseId" IS NULL) OR
  ("targetType" = 'RECOVERY_CASE' AND "recoveryCaseId" IS NOT NULL AND "leadId" IS NULL AND "customerId" IS NULL AND "jobId" IS NULL)
);
ALTER TABLE "FollowUpTask" ADD CONSTRAINT follow_up_task_state CHECK (
  ("status" IN ('OPEN', 'IN_PROGRESS') AND "completedAt" IS NULL AND "cancelledAt" IS NULL) OR
  ("status" = 'DONE' AND "completedAt" IS NOT NULL AND "cancelledAt" IS NULL) OR
  ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "completedAt" IS NULL AND length(btrim(coalesce("cancelReason", ''))) > 0)
);
ALTER TABLE "FollowUpTask" ADD CONSTRAINT follow_up_task_title_present CHECK (length(btrim("title")) > 0);
ALTER TABLE "FollowUpTask" ADD CONSTRAINT follow_up_task_dedupe_key_present CHECK ("dedupeKey" IS NULL OR length("dedupeKey") > 0);
