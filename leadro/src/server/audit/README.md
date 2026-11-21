# audit

Append-only audit trail (§21). The `AuditEvent` table rejects UPDATE/DELETE/TRUNCATE in the database.

Public API (`index.ts`):
- `recordAudit(tx, event)` — inserts an event with the caller's transaction, so it commits or rolls
  back together with the change. Previous/new values are deep-redacted (`src/lib/redact.ts`).
- `auditContextFields(ctx)` — tenant, actor, source app and correlation id from a `RequestContext`.
- `listAuditEvents(tenantId, { filter, cursor, limit })` — tenant-scoped timeline, newest first,
  cursor pagination (default 50, max 200).

Conventions: `action` is `resource.verb` (`employee.update`); denied/failed attempts are recorded
with outcome `DENIED` / `FAILED`; sensitive actions pass a `reason`.

Invariants:
- Events are written inside `withTenant`; row-level security rejects a mismatching `tenantId`.
- `listAuditEvents` does not check permissions; the route's `authorize` hook must require `audit.read`.
