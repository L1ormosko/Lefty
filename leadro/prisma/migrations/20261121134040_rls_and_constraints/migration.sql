-- Hand-written migration: row-level security, append-only audit, integrity constraints.
-- Everything here is invisible to the Prisma schema, so it lives in SQL and is verified by
-- tests/db/rls.test.ts (which also asserts that no tenant-owned table is missed).

-- ───────────── Row-level security ─────────────
-- Applied to EVERY table that has a "tenantId" column, so a table added later without RLS is
-- caught by the coverage test. The app role owns the tables, hence FORCE.
-- current_setting(..., true) returns NULL (or '' after a transaction-local set_config has ended)
-- when unset; NULLIF maps '' to NULL; "tenantId" = NULL is never true, so a missing context sees
-- and writes nothing (fail closed).
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

-- ───────────── Append-only audit log ─────────────
CREATE OR REPLACE FUNCTION leadro_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_event_no_update_delete
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION leadro_audit_append_only();

CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION leadro_audit_append_only();

-- ───────────── Org tree integrity ─────────────
ALTER TABLE "OrgUnit"
  ADD CONSTRAINT org_unit_not_own_parent CHECK ("parentId" IS NULL OR "parentId" <> "id");

-- Reject cycles of any length (A -> B -> A). The self-parent CHECK above is the cheap fast path.
CREATE OR REPLACE FUNCTION leadro_org_unit_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(id, "parentId") AS (
      SELECT o.id, o."parentId" FROM "OrgUnit" o WHERE o.id = NEW."parentId"
      UNION
      SELECT o.id, o."parentId" FROM "OrgUnit" o JOIN ancestors a ON o.id = a."parentId"
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'OrgUnit hierarchy cycle detected for %', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER org_unit_no_cycle
  BEFORE INSERT OR UPDATE OF "parentId" ON "OrgUnit"
  FOR EACH ROW EXECUTE FUNCTION leadro_org_unit_no_cycle();

-- ───────────── Effective-date sanity ─────────────
ALTER TABLE "OrganizationalAssignment"
  ADD CONSTRAINT org_assignment_dates CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "OrgUnitManager"
  ADD CONSTRAINT org_unit_manager_dates CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "RoleAssignment"
  ADD CONSTRAINT role_assignment_dates CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- An employee has at most one PRIMARY placement at any instant (history rows never overlap).
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "OrganizationalAssignment"
  ADD CONSTRAINT org_assignment_one_primary EXCLUDE USING gist (
    "employeeId" WITH =,
    tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz)) WITH &&
  ) WHERE ("kind" = 'PRIMARY');

-- ───────────── Scope consistency ─────────────
ALTER TABLE "AccessScope"
  ADD CONSTRAINT access_scope_target CHECK (
    ("type" = 'LEGAL_ENTITY' AND "legalEntityId" IS NOT NULL AND "orgUnitId" IS NULL) OR
    ("type" = 'ORG_UNIT'     AND "orgUnitId" IS NOT NULL AND "legalEntityId" IS NULL) OR
    ("type" IN ('TENANT', 'OWN', 'ASSIGNED') AND "legalEntityId" IS NULL AND "orgUnitId" IS NULL)
  );

-- ───────────── Value domains ─────────────
ALTER TABLE "User" ADD CONSTRAINT user_email_lowercase CHECK ("email" = lower("email"));
ALTER TABLE "Invitation" ADD CONSTRAINT invitation_email_lowercase CHECK ("email" = lower("email"));
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_slug_format CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$');
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_locale_supported CHECK ("defaultLocale" IN ('en-US', 'es-US', 'he-IL'));
ALTER TABLE "OrgUnit" ADD CONSTRAINT org_unit_locale_supported CHECK ("defaultLocale" IS NULL OR "defaultLocale" IN ('en-US', 'es-US', 'he-IL'));
ALTER TABLE "User" ADD CONSTRAINT user_locale_supported CHECK ("locale" IS NULL OR "locale" IN ('en-US', 'es-US', 'he-IL'));
ALTER TABLE "TranslationResource" ADD CONSTRAINT translation_locale_supported CHECK ("locale" IN ('en-US', 'es-US', 'he-IL'));
