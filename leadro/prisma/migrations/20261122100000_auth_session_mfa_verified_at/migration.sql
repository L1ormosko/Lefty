-- When a session passed an MFA challenge. Column only: "Session" keeps its existing RLS policy.
ALTER TABLE "Session" ADD COLUMN "mfaVerifiedAt" TIMESTAMPTZ(3);
