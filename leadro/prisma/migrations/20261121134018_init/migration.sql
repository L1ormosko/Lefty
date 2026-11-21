-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrgUnitType" AS ENUM ('BUSINESS_UNIT', 'STATE', 'REGION', 'CITY', 'BRANCH', 'DEPARTMENT', 'TEAM');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "AssignmentKind" AS ENUM ('PRIMARY', 'SECONDARY', 'TEMPORARY');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "PermissionAction" AS ENUM ('VIEW', 'CREATE', 'EDIT', 'ARCHIVE', 'ASSIGN', 'APPROVE', 'REJECT', 'EXPORT', 'MANAGE', 'CONFIGURE');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('TENANT', 'LEGAL_ENTITY', 'ORG_UNIT', 'OWN', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "AuthEventType" AS ENUM ('LOGIN_SUCCEEDED', 'LOGIN_FAILED', 'LOGOUT', 'SESSION_REVOKED', 'ACCOUNT_LOCKED', 'ACCOUNT_UNLOCKED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED', 'PASSWORD_CHANGED', 'INVITATION_ACCEPTED', 'MFA_CHALLENGE_SUCCEEDED', 'MFA_CHALLENGE_FAILED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILED');

-- CreateEnum
CREATE TYPE "SourceApp" AS ENUM ('WEB', 'MOBILE', 'API', 'SYSTEM');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultLocale" TEXT NOT NULL DEFAULT 'en-US',
    "defaultTimeZone" TEXT NOT NULL DEFAULT 'America/New_York',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalEntity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LegalEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgUnit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "OrgUnitType" NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parentId" TEXT,
    "legalEntityId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "address" JSONB,
    "timeZone" TEXT,
    "defaultLocale" TEXT,
    "operatingHours" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrgUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "legalEntityId" TEXT,
    "employeeNumber" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "jobTitle" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "hireDate" DATE,
    "terminationDate" DATE,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgUnitManager" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUnitManager_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationalAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "orgUnitId" TEXT NOT NULL,
    "kind" "AssignmentKind" NOT NULL DEFAULT 'PRIMARY',
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(3),
    "reason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationalAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'INVITED',
    "locale" TEXT,
    "timeZone" TEXT,
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecretEncrypted" TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "passwordChangedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "templateKey" TEXT,
    "isSystemTemplate" BOOLEAN NOT NULL DEFAULT false,
    "requiresMfa" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" "PermissionAction" NOT NULL,
    "description" TEXT,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "conditions" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMPTZ(3),
    "grantedById" TEXT,
    "reason" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessScope" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleAssignmentId" TEXT NOT NULL,
    "type" "ScopeType" NOT NULL,
    "legalEntityId" TEXT,
    "orgUnitId" TEXT,
    "includeDescendants" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthenticationEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "emailAttempted" TEXT,
    "type" "AuthEventType" NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "correlationId" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthenticationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT,
    "roleId" TEXT,
    "employeeId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "previousValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "sourceApp" "SourceApp" NOT NULL DEFAULT 'API',
    "correlationId" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranslationResource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "TranslationResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "LegalEntity_tenantId_idx" ON "LegalEntity"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalEntity_id_tenantId_key" ON "LegalEntity"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalEntity_tenantId_name_key" ON "LegalEntity"("tenantId", "name");

-- CreateIndex
CREATE INDEX "OrgUnit_tenantId_parentId_idx" ON "OrgUnit"("tenantId", "parentId");

-- CreateIndex
CREATE INDEX "OrgUnit_tenantId_type_idx" ON "OrgUnit"("tenantId", "type");

-- CreateIndex
CREATE INDEX "OrgUnit_tenantId_legalEntityId_idx" ON "OrgUnit"("tenantId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUnit_id_tenantId_key" ON "OrgUnit"("id", "tenantId");

-- CreateIndex
CREATE INDEX "Employee_tenantId_status_idx" ON "Employee"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Employee_tenantId_legalEntityId_idx" ON "Employee"("tenantId", "legalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_id_tenantId_key" ON "Employee"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_tenantId_key" ON "Employee"("userId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_tenantId_employeeNumber_key" ON "Employee"("tenantId", "employeeNumber");

-- CreateIndex
CREATE INDEX "OrgUnitManager_tenantId_orgUnitId_idx" ON "OrgUnitManager"("tenantId", "orgUnitId");

-- CreateIndex
CREATE INDEX "OrgUnitManager_tenantId_employeeId_idx" ON "OrgUnitManager"("tenantId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUnitManager_id_tenantId_key" ON "OrgUnitManager"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUnitManager_orgUnitId_employeeId_effectiveFrom_key" ON "OrgUnitManager"("orgUnitId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "OrganizationalAssignment_tenantId_employeeId_effectiveFrom_idx" ON "OrganizationalAssignment"("tenantId", "employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "OrganizationalAssignment_tenantId_orgUnitId_idx" ON "OrganizationalAssignment"("tenantId", "orgUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationalAssignment_id_tenantId_key" ON "OrganizationalAssignment"("id", "tenantId");

-- CreateIndex
CREATE INDEX "User_tenantId_status_idx" ON "User"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "User_id_tenantId_key" ON "User"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "Role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_id_tenantId_key" ON "Role"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_name_key" ON "Role"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_module_action_key" ON "Permission"("module", "action");

-- CreateIndex
CREATE INDEX "RolePermission_tenantId_idx" ON "RolePermission"("tenantId");

-- CreateIndex
CREATE INDEX "RoleAssignment_tenantId_userId_idx" ON "RoleAssignment"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "RoleAssignment_tenantId_roleId_idx" ON "RoleAssignment"("tenantId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleAssignment_id_tenantId_key" ON "RoleAssignment"("id", "tenantId");

-- CreateIndex
CREATE INDEX "AccessScope_tenantId_roleAssignmentId_idx" ON "AccessScope"("tenantId", "roleAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessScope_id_tenantId_key" ON "AccessScope"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_tenantId_userId_idx" ON "Session"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_tenantId_key" ON "Session"("id", "tenantId");

-- CreateIndex
CREATE INDEX "AuthenticationEvent_tenantId_userId_occurredAt_idx" ON "AuthenticationEvent"("tenantId", "userId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuthenticationEvent_tenantId_type_occurredAt_idx" ON "AuthenticationEvent"("tenantId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthenticationEvent_id_tenantId_key" ON "AuthenticationEvent"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_tenantId_email_idx" ON "Invitation"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_id_tenantId_key" ON "Invitation"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_tenantId_userId_idx" ON "PasswordResetToken"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_id_tenantId_key" ON "PasswordResetToken"("id", "tenantId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_occurredAt_idx" ON "AuditEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_targetType_targetId_idx" ON "AuditEvent"("tenantId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_actorUserId_occurredAt_idx" ON "AuditEvent"("tenantId", "actorUserId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_action_idx" ON "AuditEvent"("tenantId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_id_tenantId_key" ON "AuditEvent"("id", "tenantId");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_id_tenantId_key" ON "IdempotencyRecord"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_tenantId_key_key" ON "IdempotencyRecord"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationResource_id_tenantId_key" ON "TranslationResource"("id", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TranslationResource_tenantId_locale_key_key" ON "TranslationResource"("tenantId", "locale", "key");

-- AddForeignKey
ALTER TABLE "LegalEntity" ADD CONSTRAINT "LegalEntity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_parentId_tenantId_fkey" FOREIGN KEY ("parentId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_legalEntityId_tenantId_fkey" FOREIGN KEY ("legalEntityId", "tenantId") REFERENCES "LegalEntity"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_legalEntityId_tenantId_fkey" FOREIGN KEY ("legalEntityId", "tenantId") REFERENCES "LegalEntity"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitManager" ADD CONSTRAINT "OrgUnitManager_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitManager" ADD CONSTRAINT "OrgUnitManager_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgUnitManager" ADD CONSTRAINT "OrgUnitManager_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationalAssignment" ADD CONSTRAINT "OrganizationalAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationalAssignment" ADD CONSTRAINT "OrganizationalAssignment_employeeId_tenantId_fkey" FOREIGN KEY ("employeeId", "tenantId") REFERENCES "Employee"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationalAssignment" ADD CONSTRAINT "OrganizationalAssignment_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationalAssignment" ADD CONSTRAINT "OrganizationalAssignment_createdById_tenantId_fkey" FOREIGN KEY ("createdById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_tenantId_fkey" FOREIGN KEY ("roleId", "tenantId") REFERENCES "Role"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_tenantId_fkey" FOREIGN KEY ("roleId", "tenantId") REFERENCES "Role"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_grantedById_tenantId_fkey" FOREIGN KEY ("grantedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_revokedById_tenantId_fkey" FOREIGN KEY ("revokedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessScope" ADD CONSTRAINT "AccessScope_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessScope" ADD CONSTRAINT "AccessScope_roleAssignmentId_tenantId_fkey" FOREIGN KEY ("roleAssignmentId", "tenantId") REFERENCES "RoleAssignment"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessScope" ADD CONSTRAINT "AccessScope_legalEntityId_tenantId_fkey" FOREIGN KEY ("legalEntityId", "tenantId") REFERENCES "LegalEntity"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessScope" ADD CONSTRAINT "AccessScope_orgUnitId_tenantId_fkey" FOREIGN KEY ("orgUnitId", "tenantId") REFERENCES "OrgUnit"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthenticationEvent" ADD CONSTRAINT "AuthenticationEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthenticationEvent" ADD CONSTRAINT "AuthenticationEvent_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedById_tenantId_fkey" FOREIGN KEY ("invitedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_tenantId_fkey" FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranslationResource" ADD CONSTRAINT "TranslationResource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranslationResource" ADD CONSTRAINT "TranslationResource_updatedById_tenantId_fkey" FOREIGN KEY ("updatedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;
