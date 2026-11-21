-- Session may exist before the second factor is proven (login step 1 of 2).
-- "Session" already has ENABLE + FORCE ROW LEVEL SECURITY and the tenant_isolation policy; adding a
-- column does not change that.
ALTER TABLE "Session" ADD COLUMN "mfaPending" BOOLEAN NOT NULL DEFAULT false;
