-- Replay protection for TOTP codes (highest accepted time step) and the data scope an invitation
-- grants with its role. Columns only: "User" and "Invitation" keep their existing RLS policies.
ALTER TABLE "User" ADD COLUMN "mfaLastUsedStep" INTEGER;

ALTER TABLE "Invitation" ADD COLUMN "scopeType" "ScopeType",
ADD COLUMN "scopeLegalEntityId" TEXT,
ADD COLUMN "scopeOrgUnitId" TEXT,
ADD COLUMN "scopeIncludeDescendants" BOOLEAN NOT NULL DEFAULT true;
