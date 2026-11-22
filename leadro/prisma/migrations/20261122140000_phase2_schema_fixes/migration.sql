-- CreateEnum
CREATE TYPE "CustomerEmployeePreference" AS ENUM ('PREFERRED', 'AVOID');

-- AlterEnum
ALTER TYPE "QualificationKind" ADD VALUE 'TRAINING';

-- DropForeignKey
ALTER TABLE "EmployeeQualification" DROP CONSTRAINT "EmployeeQualification_certificationId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_leadId_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "JobAssignment" DROP CONSTRAINT "JobAssignment_recommendationId_tenantId_fkey";

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "startLatitude" DECIMAL(9,6),
ADD COLUMN     "startLongitude" DECIMAL(9,6);

-- AlterTable
ALTER TABLE "OrgUnit" ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6);

-- CreateTable
CREATE TABLE "EmployeeJobPermission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "jobTypeId" TEXT,
    "category" TEXT,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(3),
    "grantedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeJobPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPreferredEmployee" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" "CustomerEmployeePreference" NOT NULL DEFAULT 'PREFERRED',
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerPreferredEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeJobPermission_tenantId_employeeId_effectiveTo_idx" ON "EmployeeJobPermission"("tenantId", "employeeId", "effectiveTo");

-- CreateIndex
CREATE INDEX "EmployeeJobPermission_tenantId_jobTypeId_idx" ON "EmployeeJobPermission"("tenantId", "jobTypeId");

-- CreateIndex
CREATE INDEX "EmployeeJobPermission_tenantId_category_idx" ON "EmployeeJobPermission"("tenantId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeJobPermission_id_tenantId_key" ON "EmployeeJobPermission"("id", "tenantId");

-- CreateIndex
CREATE INDEX "CustomerPreferredEmployee_tenantId_employeeId_idx" ON "CustomerPreferredEmployee"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPreferredEmployee_id_tenantId_key" ON "CustomerPreferredEmployee"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerPreferredEmployee_tenantId_customerId_employeeId_key" ON "CustomerPreferredEmployee"("tenantId", "customerId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Certification_id_type_tenantId_key" ON "Certification"("id", "type", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DispatchRecommendation_id_jobId_tenantId_key" ON "DispatchRecommendation"("id", "jobId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_id_customerId_tenantId_key" ON "Lead"("id", "customerId", "tenantId");

-- AddForeignKey
ALTER TABLE "OperationsSettings" ADD CONSTRAINT "OperationsSettings_updatedById_tenantId_fkey" FOREIGN KEY ("updatedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_certificationId_kind_tenantId_fkey" FOREIGN KEY ("certificationId", "kind", "tenantId") REFERENCES "Certification"("id", "type", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_leadId_customerId_tenantId_fkey" FOREIGN KEY ("leadId", "customerId", "tenantId") REFERENCES "Lead"("id", "customerId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAssignment" ADD CONSTRAINT "JobAssignment_recommendationId_jobId_tenantId_fkey" FOREIGN KEY ("recommendationId", "jobId", "tenantId") REFERENCES "DispatchRecommendation"("id", "jobId", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeJobPermission" ADD CONSTRAINT "EmployeeJobPermission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeJobPermission" ADD CONSTRAINT "EmployeeJobPermission_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeJobPermission" ADD CONSTRAINT "EmployeeJobPermission_jobTypeId_tenantId_fkey" FOREIGN KEY ("jobTypeId", "tenantId") REFERENCES "JobType"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeJobPermission" ADD CONSTRAINT "EmployeeJobPermission_grantedById_tenantId_fkey" FOREIGN KEY ("grantedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPreferredEmployee" ADD CONSTRAINT "CustomerPreferredEmployee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPreferredEmployee" ADD CONSTRAINT "CustomerPreferredEmployee_customerId_tenantId_fkey" FOREIGN KEY ("customerId", "tenantId") REFERENCES "Customer"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPreferredEmployee" ADD CONSTRAINT "CustomerPreferredEmployee_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═══════════ HAND-WRITTEN PART ═══════════

-- RLS for the two new tables (same idempotent DO-block as the earlier migrations).
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

-- Origin coordinates for straight-line distance estimates: ranges, and both-or-neither.
ALTER TABLE "OrgUnit" ADD CONSTRAINT org_unit_latitude_range CHECK ("latitude" IS NULL OR ("latitude" >= -90 AND "latitude" <= 90));
ALTER TABLE "OrgUnit" ADD CONSTRAINT org_unit_longitude_range CHECK ("longitude" IS NULL OR ("longitude" >= -180 AND "longitude" <= 180));
ALTER TABLE "OrgUnit" ADD CONSTRAINT org_unit_coordinates_pair CHECK (("latitude" IS NULL) = ("longitude" IS NULL));
ALTER TABLE "Employee" ADD CONSTRAINT employee_start_latitude_range CHECK ("startLatitude" IS NULL OR ("startLatitude" >= -90 AND "startLatitude" <= 90));
ALTER TABLE "Employee" ADD CONSTRAINT employee_start_longitude_range CHECK ("startLongitude" IS NULL OR ("startLongitude" >= -180 AND "startLongitude" <= 180));
ALTER TABLE "Employee" ADD CONSTRAINT employee_start_coordinates_pair CHECK (("startLatitude" IS NULL) = ("startLongitude" IS NULL));

-- Job-category permission: exactly one target, sane dates.
ALTER TABLE "EmployeeJobPermission" ADD CONSTRAINT employee_job_permission_target CHECK (
  ("jobTypeId" IS NOT NULL AND "category" IS NULL) OR ("jobTypeId" IS NULL AND "category" IS NOT NULL AND length(btrim("category")) > 0)
);
ALTER TABLE "EmployeeJobPermission" ADD CONSTRAINT employee_job_permission_dates CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
