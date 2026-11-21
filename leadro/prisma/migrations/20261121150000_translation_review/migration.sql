-- Task 6 (localization, spec 16.6): tenant translation overrides must be human-reviewed before
-- they are served. Existing rows (none in practice) default to unreviewed, i.e. not served.
-- RLS: the table already has ENABLE + FORCE ROW LEVEL SECURITY and the tenant_isolation policy
-- from rls_and_constraints; adding columns does not change that.
ALTER TABLE "TranslationResource"
    ADD COLUMN "reviewed" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "reviewedAt" TIMESTAMPTZ(3),
    ADD COLUMN "reviewedById" TEXT;

-- Composite FK keeps the reviewer inside the same tenant (same pattern as updatedById).
ALTER TABLE "TranslationResource" ADD CONSTRAINT "TranslationResource_reviewedById_tenantId_fkey"
    FOREIGN KEY ("reviewedById", "tenantId") REFERENCES "User"("id", "tenantId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A row is either unreviewed with no reviewer, or reviewed with a review timestamp.
ALTER TABLE "TranslationResource" ADD CONSTRAINT translation_review_consistent
    CHECK (("reviewed" = false AND "reviewedAt" IS NULL AND "reviewedById" IS NULL)
        OR ("reviewed" = true AND "reviewedAt" IS NOT NULL));
