-- An immutable record of actions that change someone else's standing on the
-- platform. Additive only: no existing table is touched apart from gaining a
-- back-reference that lives entirely in the Prisma client.
CREATE TYPE "AuditAction" AS ENUM (
  'USER_REGISTERED',
  'USER_ACTIVATED',
  'USER_DEACTIVATED',
  'ACCOUNT_ANONYMIZED',
  'ASSET_PUBLISHED',
  'ASSET_UNPUBLISHED',
  'ASSET_DELETED',
  'ASSET_VERIFIED',
  'ASSET_REJECTED',
  'ASSET_SURFACE_MARKED',
  'BOOKING_DECIDED',
  'BOOKING_CANCELLED',
  'SUBSCRIPTION_CHANGED',
  'BACKUP_DOWNLOADED'
);

CREATE TABLE "AuditLog" (
  "id"         TEXT NOT NULL,
  "actorId"    TEXT,
  "action"     "AuditAction" NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId"   TEXT NOT NULL,
  "summary"    TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- The actor reference survives account erasure because accounts are anonymized
-- rather than deleted; SET NULL is the fallback for a genuine hard delete.
ALTER TABLE "AuditLog"
  ADD CONSTRAINT "AuditLog_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");
CREATE INDEX "AuditLog_targetType_targetId_createdAt_idx" ON "AuditLog"("targetType", "targetId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
