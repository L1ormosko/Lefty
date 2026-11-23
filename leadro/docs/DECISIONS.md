# Decisions log

Format: decision - rationale - cost if wrong. Newest section last. Spec section references are to
`SPEC.md`.

## Pre-flight rulings (project manager)

1. **Build LEADRO in the `leadro/` subdirectory; never touch VELTO at the repo root.** The repo holds
   an unrelated product and spec 28.2 forbids overwriting working functionality. Cost if wrong:
   move the directory to a new repository (cheap).
2. **Scope of this effort = Phase 0 + Phase 1 only.** The spec 27 roadmap is incremental and spec 28
   forbids one uncontrolled session. Cost: none.
3. **The spec 4.5 matrix is the approved default permission matrix (spec 28.5).** It is the only
   matrix given and is configurable per tenant. Cost: re-map role templates.
4. **Phase 4 financial formulas are NOT implemented.** Spec 28.4 requires an approved compensation
   spec, which was not provided. Cost: none.
5. **Local credential authentication behind an interface instead of a managed IdP.** No IdP
   account or credentials are available; recorded as a deviation from spec 2.4. Cost: adapter swap.
6. **A User belongs to exactly one tenant; login = company code (tenant slug) + email + password.**
   Simplest RLS-compatible identity. Cost: multi-tenant users need a membership table later.
7. **Tenant isolation = Postgres RLS (FORCE) + application checks through `withTenant`.** Spec 3.1
   "database-level controls where supported". Cost: none.

## Task 1 decisions (scaffold, Phase 0 docs, core schema)

8. **Local database: role `leadro` (LOGIN, NOSUPERUSER, NOBYPASSRLS, CREATEDB), DBs `leadro` and
   `leadro_test`, both owned by the role.** Because the app role owns the tables, RLS uses
   `FORCE ROW LEVEL SECURITY` (owners otherwise bypass policies). `CREATEDB` is only for
   `prisma migrate dev`'s shadow database. `scripts/setup-db.sh` is idempotent.
9. **RLS predicate: `"tenantId" = NULLIF(current_setting('app.tenant_id', true), '')`** with USING and
   WITH CHECK. A missing/empty setting is NULL -> no rows, no writes (fail closed). The NULLIF is
   needed because a transaction-local `set_config` leaves `''` (not NULL) on the connection after
   the transaction ends. The migration applies the policy by looping over every table that has a
   `tenantId` column, and a test asserts the full set, so a future table cannot silently miss RLS.
10. **`Tenant` has no RLS** (it is looked up by slug at login and exposes only id, slug, name,
    status, locale/time-zone defaults). **`Permission` is a global catalog without `tenantId` and
    without RLS.** All other 17 tables are tenant-owned and RLS-protected.
11. **Composite foreign keys `(parentId, tenantId) -> (id, tenantId)`** for every reference between
    tenant-owned tables (each carries `@@unique([id, tenantId])`). FK checks bypass RLS, so without
    this a row in tenant A could reference a parent id of tenant B. Consequence: those relations
    use `onDelete: Restrict` (a composite `SET NULL` would try to null `tenantId`); `Session`,
    `PasswordResetToken`, `RolePermission`, `AccessScope` cascade from their parents.
12. **Column naming: Prisma default camelCase (`"tenantId"`), quoted in SQL**, rather than
    `@map("tenant_id")` everywhere. Same semantics as the plan's `tenant_id = current_setting(...)`;
    avoids a mapping on ~70 fields.
13. **Org change history = `OrganizationalAssignment` rows (never overwritten) + `AuditEvent`; no
    separate `OrgChangeHistory` table.** Employee moves close a row and open a new one (the
    historical record reports need, spec 3.4). Structural changes to the tree itself (rename,
    re-parent, deactivate) are captured with previous/new values in `AuditEvent`. A dedicated
    history table would duplicate the audit log; revisit only if "tree as of date D" reporting is
    required (then add temporal versioning of `OrgUnit.parentId`). Cost if wrong: add a table +
    backfill from audit.
14. **One `OrgUnit` table with a `type` enum** (BUSINESS_UNIT, STATE, REGION, CITY, BRANCH,
    DEPARTMENT, TEAM) instead of seven tables: spec 3.3 requires a configurable hierarchy and a
    single recursive tree keeps scope resolution simple. Concepts stay distinct from `Tenant` and
    `LegalEntity` (spec 3.2). Which type may sit under which (e.g. BRANCH under CITY) is validated
    in the organization service, not the DB, because the hierarchy is configurable. The DB
    guarantees no self-parent (CHECK) and no cycles (trigger).
15. **At most one PRIMARY placement per employee at any time** via an exclusion constraint
    (`btree_gist`, a trusted extension the DB owner may create). TEMPORARY/SECONDARY placements may
    overlap so an employee can be on a team without changing the legal employer (spec 3.3).
16. **`Employee.legalEntityId` = legal employer (nullable)**, independent of operational placement.
    `Employee.userId` is optional and unique (1:1 optional with `User`).
17. **`AuditEvent` has no foreign keys to actor/target** (`actorUserId`, `targetId` are plain
    strings). Audit history must outlive and never block changes to what it describes; targets are
    polymorphic. The tenant FK is kept. Append-only trigger rejects UPDATE, DELETE and TRUNCATE.
    Limitation: the table owner could still drop the trigger; the production hardening step (a
    separate owner role for DDL vs. the runtime role, plus `REVOKE`) is deferred and listed in
    `PROJECT_STATE.md`. Cleanup of test data is therefore impossible by design; tests use fresh
    tenants.
18. **Opaque tokens embed the tenant id** (`<tenantId>.<random>`; only a SHA-256 is stored) for
    sessions, invitations and password-reset tokens, so the tenant is known before opening the RLS
    context. Hash columns are globally unique, but they are still protected by RLS.
19. **`AccessScope` is a child of `RoleAssignment`** (user->role + effective dates + grantedBy), as in
    the plan; a CHECK enforces that scope target columns match the scope type.
20. **`RolePermission.conditions` (JSON)** carries the qualifiers behind the matrix's "Limited" /
    "Financial fields" / "Job-related" cells. The condition vocabulary is intentionally left open
    until the consuming modules exist (see `PERMISSIONS.md`).
21. **Locales are `String` + CHECK (`en-US`, `es-US`, `he-IL`)** rather than a Prisma enum, because
    `en-US` is not a valid enum identifier and new locales should need only a migration of a CHECK.
    Time zones are IANA strings, validated in the application layer. All timestamps `timestamptz`.
22. **Test database lifecycle: `prisma migrate deploy` (forward-only), not `migrate reset`.** Prisma
    blocks `migrate reset` for AI agents without explicit user consent, so the suite does not use it.
    Tests are written to coexist with prior data (unique tenant per test file; no empty-database
    assumptions) and the global setup refuses any database not named `*_test`. Wiping the test DB
    is a documented manual step in the README.
23. **Derived role templates.** Regional Manager, Team Leader, Customer Relations and HR Manager
    appear in spec 4.4 but not in the 4.5 matrix; their default grants are derived by analogy
    (`PERMISSIONS.md` section 5). **Needs product confirmation.**
24. **Permission catalog lives in code (`src/server/authz/permission-catalog.ts`) and is seeded into
    `Permission`.** It is the single source; `PERMISSIONS.md` mirrors it.
25. **`tsconfig`/ESLint/Vitest/Tailwind/PostCSS config copied from the root VELTO setup** (same pinned
    versions) so tooling behaves identically across both apps.

## Dependencies (no new dependency beyond the stack)

All versions are pinned exactly and identical to the root VELTO `package.json` where they overlap.

| Package | Why |
|---|---|
| `next`, `react`, `react-dom` | Web app (spec 2.4) |
| `@prisma/client`, `prisma` | ORM + migrations (stack ruling) |
| `zod` | Input validation (spec 20.1) |
| `typescript`, `@types/node`, `@types/react`, `@types/react-dom` | Strict typing |
| `tailwindcss`, `postcss`, `autoprefixer` | Styling (Tailwind 3) |
| `eslint`, `eslint-config-next`, `@eslint/eslintrc` | Linting (flat config, same as VELTO) |
| `vitest` | Tests |
| `tsx` | Runs `prisma/seed.ts` |

Not added (deliberate): `bcryptjs` or another password hasher (arrives with the auth task), any
queue/storage/map/notification SDK (spec 28.3: no fake integrations).

## Task 2 decisions (core request pipeline, audit, logging)

No new dependencies (uses node:crypto, Zod, Prisma already in the stack).

1. **Error codes follow the Task 2 brief**, not the longer table in `API_CONVENTIONS.md`:
   `UNAUTHENTICATED 401`, `FORBIDDEN 403` (docs say `PERMISSION_DENIED`), `NOT_FOUND 404`,
   `VALIDATION_FAILED 400`, `CONFLICT 409`, `INVALID_STATE_TRANSITION 409`, `RATE_LIMITED 429`,
   `INTERNAL 500` (docs say `INTERNAL_ERROR`). `API_CONVENTIONS.md` should be aligned by the manager.
   Idempotency key reuse with a different payload is a plain `CONFLICT` (not `IDEMPOTENCY_KEY_REUSED`).
2. **`withIdempotency(tenantId, key, scope, fn)`**: `scope` is `{ method, path, body }` (hashed with
   sorted keys, SHA-256). The claim row is committed before `fn` runs via `INSERT ... ON CONFLICT DO
   NOTHING`, so exactly one concurrent duplicate runs; the others get a retryable `CONFLICT`
   (they are not blocked waiting). An unfinished claim blocks for only 2 minutes (not 24 h) so a
   crashed process does not lock the client out; a finished record is kept 24 h. If `fn` throws,
   the claim is released (errors are not cached). No schema change was needed.
3. **`defineRoute` order**: correlation id -> `authenticate` -> Zod parse -> `authorize(actor, input)`
   -> handler. Authenticating first keeps the input contract hidden from anonymous callers.
   `authorize` without `authenticate` fails closed (500). `idempotent: true` opts a route into
   `withIdempotency` when an `Idempotency-Key` header is sent; replays carry `Idempotent-Replayed: true`.
4. **Source app** is derived from an informational `x-leadro-client: web|mobile` header (default
   `API`). It is for audit context only, not a security claim.
5. **Shared redaction lives in `src/lib/redact.ts`** (pure) and is used by both audit and logging.
   Matching is by normalised key fragment (`password`, `secret`, `token`, `apikey`, `authorization`,
   `cookie`, `credential`, `privatekey`, `recoverycode`), deliberately over-inclusive.
6. **Tests live in `tests/<module>/`** (not beside the source) because `vitest.config.ts` only
   includes `tests/**/*.test.ts`.
7. **Audit read API** is `listAuditEvents(tenantId, { filter, cursor, limit })`; it does no
   permission check (caller enforces `audit.read`, Task 4). Cursor is keyset on (occurredAt, id).

## Task 7a — design-system primitives

- **New dev dependencies (exact pins):** `@testing-library/react@16.3.3`, `@testing-library/user-event@14.6.13`,
  `@testing-library/jest-dom@6.10.0`, `jsdom@25.0.1` (component tests need a DOM; jsdom 25 is the
  line supported by Vitest 2.1), plus `@testing-library/dom@10.4.1` — a required peer dependency of
  `@testing-library/react@16`, not an independent choice.
- **Vitest environments:** default stays `node` (DB integration tests); component tests opt in with a
  `// @vitest-environment jsdom` first line. `tests/setup-dom.ts` registers jest-dom matchers and
  cleanup only when a DOM exists. `esbuild.jsx = "automatic"` is set because tsconfig uses `jsx: preserve`.
- **Tailwind CSS entry:** `src/app/globals.css` is imported only by `src/app/dev/ui/layout.tsx` so this
  task does not edit the root layout (owned by other tasks). The app shell task should import it from
  the root layout and may then drop the dev import.
- **Overlay `dir` prop:** portals render in `<body>` and inherit `<html dir>`; the optional `dir` prop on
  Dialog/Drawer/ConfirmDialog exists only so the gallery's RTL preview section can show RTL overlays.
- **No icon/class-name libraries:** a tiny inline icon set and `cx()` instead of lucide/clsx.
- **Gallery strings** are hardcoded demo text (dev-only page); components themselves take all text via props.
## Task 6 — Localization engine
- **Catalog keys are dotted `DOMAIN.UPPER_SNAKE`** (manager ruling), flat inside `messages` of each JSON catalog; catalog
  files carry an integer `version` for §16.6 versioning. en-US is the key source of truth; the `MessageKey` type derives from it.
- **Schema change (migration `20261121150000_translation_review`)**: `TranslationResource` gained `reviewed`, `reviewedAt`,
  `reviewedById` (composite FK to User, same tenant) plus CHECK `translation_review_consistent`. Unreviewed overrides are
  never served; editing resets review. No new table, so RLS and the `rls.test.ts` table set are unchanged.
- **No new dependencies**: formatting uses `Intl`; phone display is a small E.164 formatter (NANP pretty-printed, other
  countries left as E.164 because correct grouping needs per-country data).
- **Money formatting** converts integer minor units to an exact decimal string for `Intl.NumberFormat` (no float division).
- **Reviewer may equal editor**: no four-eyes rule is specified in §16.6; add one if the business wants it.
- **`i18n:check` JSX scan is a heuristic**, not a parser; `// i18n-ignore` on a line suppresses a finding. It ignores
  `src/app/dev/**` and test files. The parity check also validates placeholder sets and key format.
- **Translation wording (review round 1)**: he-IL uses impersonal phrasing ("יש ל...") in all messages; COMMON.CONFIRM is
  "כן, להמשיך" to differ from COMMON.APPROVE "אישור"; directories are "מאגר ..."; es-US Financial Overview is "Panorama
  financiero" vs Financial Summary "Resumen financiero". Wording is subject to native-speaker review before release.
- **Approval is bound to reviewed text**: `markOverrideReviewed` takes `reviewedValue` and conflicts if the value changed.
- **Server module uses a local `TranslationOverrideError`** because `src/server/core` (AppError) lands in a parallel task;
  map it to `AppError` when merging.
## Task 3 decisions (authentication)

**New dependency:** `bcryptjs@3.0.2` (exact). Pure-JS bcrypt, ships its own types, no native build.
Requested by the Task 3 brief (cost 12). TOTP and AES-256-GCM use `node:crypto`; no other packages.

1. **Schema change:** `Session.mfaPending boolean default false` (migration
   `20261121150000_auth_session_mfa_pending`). RLS is unchanged (column added to an existing
   protected table). A password-correct login of an MFA user creates a pending session that only the
   MFA endpoints and logout accept; no signed challenge token was needed.
2. **Lockout without a window column:** failures are counted from `AuthenticationEvent`
   (`LOGIN_FAILED` + `MFA_CHALLENGE_FAILED`) newer than the latest of: 15 min ago, `lockedUntil`,
   `lastLoginAt`, `passwordChangedAt`. `failedLoginCount` is kept as a display/convenience mirror.
   `User.status = LOCKED` is not used; `lockedUntil` is the only lock mechanism.
3. **Locked accounts get the same generic 401** as a wrong password (a distinct "locked" answer would
   confirm the account exists). The reason is in the login history.
4. **MFA required when** any non-revoked, in-date assignment of an active role has `requiresMfa`, OR the
   user already enrolled. Users who must enroll log in to an `mfaPending` session and enroll through it.
5. **Rate limiting is in-memory** (fixed window, per process), documented in the auth README. The
   DB-backed lockout is the brute-force control; the limiter blunts floods.
6. **Invitation accept** creates the user when absent or activates an `INVITED` user, links
   `Invitation.employeeId` if the employee has no user, and creates a plain `RoleAssignment` for
   `Invitation.roleId` (no scopes: scoping belongs to authz/user administration). It refuses to
   touch ACTIVE/DEACTIVATED accounts. No session is issued; the user logs in afterwards.
7. **Reset tokens are delivered through an `AuthNotifier` interface.** No mail provider exists
   (§28.3), so the default notifier logs only that a token was issued (never the token).
8. **Cookie flags:** HttpOnly, SameSite=Lax, Secure in every environment except `next dev`.
   Idle timeout 60 min, absolute 12 h (constants in `auth/config.ts`).
9. **`defineRoute` cannot set headers**, so routes that set/clear the cookie are wrapped in
   `withSessionCookie` (auth module) rather than changing core.
10. **TOTP replay** is refused by looking for a successful MFA event with the same time step in the
    last 2 minutes (JSON path query on `AuthenticationEvent.metadata`).
11. **`LEADRO_ENCRYPTION_KEY`** is read lazily: the app boots without it, but every MFA code path
    throws `EncryptionKeyError` (HTTP 500 generic) instead of ever storing plaintext.

### Task 3 fix round 1
12. **Client IP trust:** `LEADRO_TRUSTED_PROXY_HOPS` (default 0 = ignore `x-forwarded-for`, store no IP;
    N = Nth entry from the right). Per-IP limits are skipped (with a log) when no IP is known.
13. **TOTP replay** is now `User.mfaLastUsedStep` + conditional UPDATE (replaces decision 10): atomic,
    and refuses older in-window steps after a newer one.
14. **Session token rotation** when an MFA-pending session is promoted (same row, new token hash).
15. **Invitations** validate inviter/role/employee/scope targets, require a scope with a role
    (columns `scopeType/scopeLegalEntityId/scopeOrgUnitId/scopeIncludeDescendants`, no FKs to avoid
    touching org models), and re-check inviter and role at accept. Migration `*_auth_fix_round_1`
    (columns only, RLS unchanged).
16. **bcrypt outside transactions** in login, invitation accept and password reset.
## Task 4 decisions (authorization engine)

No new dependencies (Zod already present). No schema change and no migration: everything fits the Task 1 schema.

1. **Scopes belong to the assignment, not to the permission.** The schema (and §4.2) attach `AccessScope` to a
   `RoleAssignment`, but the 4.5 matrix gives one role different scopes per module (Dispatcher: employees by
   unit, dispatch "Full scope"). Resolution: a template lists permissions plus `suggestedScopeTypes`; every
   permission of the role uses the assignment's scopes. Dispatcher and Lead Ops therefore default to `ORG_UNIT`
   (their territory/team), which is narrower than the matrix's "Full scope" (least privilege); grant `TENANT`
   at assignment time when a company wants that. A per-permission scope would need a schema change
   (`RolePermission.scopeType`) — deferred, easy to add later.
2. **Public API.** `can(subject, "module.action", resource?)` -> `{ allowed, reason, via }`; `scopeFilter(subject,
   permission, columns, { satisfiedSets? })` -> where-fragment; `explainAccess(subject, permission, resource?)`
   (interpretation of "targetUser|resource": the *subject* is the user being asked about, the route requires
   `permissions.view`); `canViewFields(subject, "employees.financial_fields", resource?)`;
   `requirePermission(permission, resolver?)`; `assertNotSelfApproval`; `provisionRoleTemplates(tx, tenantId)`;
   `assignRole(tx, input)`; `listAuditEventsAsActor(actor, options)`. `subject` is `{ tenantId, userId }` (an `Actor` fits).
3. **Active grant** = assignment not revoked, `effectiveFrom <= now`, `effectiveTo` null or `> now`, role `active`,
   user `ACTIVE` and (if linked) employee not `TERMINATED`. Employee id for OWN/ASSIGNED comes from the DB, not
   from `actor.employeeId`. Every call re-reads the database; nothing is cached (§25.5).
4. **Org tree "as of now"**: scope roots are expanded by a recursive CTE over *active* units. An archived unit is
   dropped and the walk does not pass through it, so its whole subtree grants nothing. An employee is in a unit
   scope if ANY of their active (`effectiveFrom <= now < effectiveTo`) placements is.
5. **"Manager loses organizational assignment"** is modelled as: the role assignment is revoked/expired, its
   scope row is removed, the scoped unit is archived or moved out of the subtree, or the employee's placement
   ends. All take effect on the next request (tests cover each). Scope is not derived from `OrgUnitManager`.
6. **Conditions** (`RolePermission.conditions`): `fields` (only this field set), `excludeFields`, `set` (only records
   of a named set). Unknown keys make the grant unusable (fail closed). `set` is checked against
   `ResourceRef.sets`; for list filters it is ignored unless the caller passes `satisfiedSets`. A "fields"-limited
   grant still passes the capability check `employees.view`; routes use `canViewFields` for sensitive field sets.
7. **Resources.** `ResourceRef` carries attributes the *server* loaded (org unit, employee, legal entity, owner,
   assigned employees, sets). Employee/org-unit/legal-entity ids are verified to exist in the tenant (RLS), so a
   forged or cross-tenant id gives `RESOURCE_NOT_FOUND` even for a TENANT-scoped grant. `{}` is a tenant-level
   record (audit log): only TENANT scopes match. No resource = capability check.
8. **Error mapping in `requirePermission`**: no grant -> 403; out of scope / missing / cross-tenant record -> 404
   (existence not confirmed). Every denial is written to the audit log (`authz.denied`, outcome DENIED), best
   effort, with `sourceApp: API` (the `authorize` hook has no request context).
9. **MFA flag** (`Role.requiresMfa`): templates Owner/CEO, Finance Director and HR Manager always; plus any role
   holding `permissions.manage`, `permissions.assign` or any `*.configure` (the brief said manage/configure; I also
   included `permissions.assign` because it can hand out sensitive roles, which makes the COO template MFA-required).
   The authz engine does not enforce MFA; authentication reads the flag at login. Documented in PERMISSIONS.md.
   **Superseded (follow-up round):** MFA is re-checked on every request (`resolveSession`), and custom roles
   (no template key, clones included) with any sensitive permission/field set also require it. See AUTH.md.
10. **Duplicate active assignments (T1 review minor)**: enforced in the service (`assignRole`), not by a DB
    constraint. Scopes live in a child table, so an exclusion constraint on `RoleAssignment` cannot see them, and
    forbidding any second (user, role) row would block legitimate temporary extra scopes. A per-(tenant, user)
    advisory lock serialises concurrent grants. Anyone who writes `RoleAssignment` rows directly bypasses the
    guard; all application code must go through `assignRole`.
11. **Templates added by analogy** (Regional Manager, Team Leader, Customer Relations, HR Manager) are my
    derivation from 4.4 text; flagged for confirmation. COO's `permissions.assign` carries `{ set:
    "non_sensitive_roles" }`: the permissions module (later) must enforce "non-sensitive roles only".
12. **Audit read gate (T2 note)**: `listAuditEventsAsActor` requires `audit.view` with a TENANT scope; the raw
    `listAuditEvents` stays ungated for internal use.
13. **Employee/org-unit scope column presets** (`employeeScopeColumns`, `orgUnitScopeColumns`) ship with the
    engine; other models define their own `ScopeColumns` when their modules arrive.

### Task 4 fix round 1 (review findings)

14. **Field sets are explicit and opt-in.** `AccessDecision.fieldSets` lists what a grant covers: a plain grant = `base`;
    `includeFields` adds sensitive sets (`financial`, `billing`); `fields: x` = only set `x`. Union over matching grants.
    `projectFields(record, decision, fieldMap)` is the projection helper; routes must use it. `excludeFields` is gone.
    Only Owner/CEO and Finance Director hold financial/billing sets; HR gets base employee fields only (design call: §4.4
    lists employee records, employment info, training, certifications and development, not pay).
15. **Technician loses `financial_reports.view`** (ruling): own summary is self-service, not the module permission.
16. **`requirePermission` order**: capability (403) -> resolver (same transaction, may return `null` = missing) -> check
    against the record; once a record is involved every denial is 404. A resource key present but undefined/null
    (`{ orgUnitId: undefined }`) fails closed as RESOURCE_NOT_FOUND instead of becoming tenant-level.
17. **`scopeFilter` shape**: `{ AND: [{ OR: parts }] }`; use `withinScope(scope, callerWhere)` to combine. No coverage is
    `{ AND: [{ id: { in: [] } }] }` because a nested `OR: []` matches EVERYTHING in Prisma (found by a test).
18. **`explainAccess(actor, targetUserId, permission, resource?)`** is gated inside the function (permissions.view + target and
    record in the actor's scope; 403/404).
19. **`assignRole(tx, actor, input)`** enforces anti-escalation (see PERMISSIONS.md); the actor-less variant is renamed
    `bootstrapRoleAssignment` for seeds/tests only. Coverage rules: TENANT needs tenant-wide; ORG_UNIT needs the unit and its
    active subtree inside the granter's scope; OWN/ASSIGNED need any scope of the granter; LEGAL_ENTITY needs that entity.

## Task 7b — app shell, auth screens, account pages

1. **Session state for pages (`src/app/_lib/page-context.ts`)**: `requireSession()` only answers for MFA-complete sessions, so
   the MFA-pending case is detected by feeding the same cookie to `authenticateMfaRequest`. This avoids touching the auth module
   (no `mfaPending` on `Actor`). Cost: one extra `auth.access_denied` audit row per page load while a session is MFA-pending.
2. **Locale for signed-out pages**: `leadro_locale` cookie -> Accept-Language -> en-US (`locale-negotiation.ts`). Signed in:
   `resolveLocaleContext` (user -> branch -> company -> en-US) with tenant overrides via `getTranslatorForRequest`.
3. **`changeLocaleAction`** is the only own-record write added for the UI: it updates `User.locale` of the session's user (never a
   form-supplied id) and writes a `user.locale_change` audit event in the same transaction. A users-service function could replace it.
4. **Navigation (`(app)/navigation.ts`)**: items carry `isAvailable`; admin items exist with their permission but are hidden until
   Task 8 builds the pages. Admin items use management permissions (`employees.edit`, `localization.edit`) because capability
   checks ignore data scope and Technicians hold `employees.view` / `localization.view` for their own record.
5. **No new dependency**: MFA enrollment shows the manual key and the `otpauth://` URI as text; no QR code is drawn.
6. **React 19 form reset**: login/forgot forms hand back the non-secret fields (`FormState.fields`) so a failed attempt does not
   clear the company code and email. Passwords and codes are never echoed.
7. **Design system**: `cx`, `focusRing` and four status icons were added to `components/ui/index.ts` exports (no behaviour change).

### Task 4 fix round 2

20. **Per-scope field sets.** `ResolvedScope.parts` = one entry per (active grant, scope) with that grant's field sets; the
    scope-blind `fieldSets` union is removed. Archived-unit scopes yield no part (so no field sets). Rows are projected with
    `fieldSetsForRow` / `projectRows`. `can()` was already per matched scope; its `fieldSets` is only meaningful with a resource.
21. **Anti-escalation per held grant**: for each granted scope a single held part must cover the scope AND the role grant's
    field sets (`partCovers` + `fieldSetsCover`). Two parts are never combined (stricter than needed, never looser).
22. **`projectFields` requires a field map**; unmapped fields are dropped. Central maps in `field-maps.ts`; financial/billing
    keys are reserved ahead of their columns so they cannot leak by default.
23. **Target in scope**: `assignRole` checks the target user (employee placement, or tenant-level when none) against the
    granter's `permissions.assign` via `canInTx`, passing `non_sensitive_roles` as the record set when the role is not sensitive.


## Task 5 decisions (organization, employees, users, roles, seed, integration)

### Integration items (Task 3 <-> 4 <-> 2)
- **a. MFA policy**: `auth.userRequiresMfa` now delegates to `authz.holdsMfaRequiringRole`; `activeAssignmentWhere(now)` is the
  single definition of an active assignment for Prisma queries (`load-grants.ts` classifies rows in memory with the same rules).
- **b. Invitations -> authz**: `assignRole` was split into `assertMayGrantRole` (dry run) + write. Creation runs the dry run as
  the inviter (target = linked employee, else the existing INVITED user's employee, else tenant-level, which needs a
  tenant-wide `permissions.assign`). Acceptance calls `assignRole` AS the inviter, so authority is re-validated at that moment;
  failures become the generic "invalid invitation" and roll back (the token is not consumed). The scope target must also still
  be active (a tenant-wide inviter could otherwise grant over an archived unit; that would grant nothing). Inviter-less
  (system) invitations use `bootstrapRoleAssignment`. `AuthNotifier` gained `sendInvitation` (default: logs, no token); the API
  never returns the invitation token (otherwise an administrator could take over the account they invited).
- **c. Context in hooks**: `defineRoute` passes `{ correlationId, sourceApp }` to `authenticate` and the full `RequestContext` to
  `authorize`. `requirePermission` audits denials with that id; `authenticateRequest` uses it for `auth.access_denied`
  (the raw header may be absent or malformed and was never the id the client received).
- **d. Translation overrides**: kept `localization.edit` (save) and `localization.configure` (review, delete) instead of a new
  `translations.manage` permission: the catalog already models edit vs configure, and two permissions keep the review step
  meaningful. New `*AsActor` functions check the permission (tenant-level), audit in the same transaction and map
  `TranslationOverrideError` to `ValidationError` / `NotFoundError` / `ConflictError`. Fix round 1: the reviewer must not be the last editor (`assertNotSelfApproval`), and the ungated functions are no longer exported from `index.ts`.
- **e. API conventions**: the error table now lists exactly `ERROR_CODES` (a test parses the doc and compares codes and HTTP
  statuses). Documented the cursor pagination actually implemented and that only the cookie transport exists.

### Services and API
- **Services re-check, routes gate**: every service function runs `enforceInTx` (permission + data scope) inside its own write
  transaction; the route's `authorize` hook (`requirePermission` / `requireTenantLevelPermission`) is the early, audited gate.
  The duplication is deliberate: services stay safe when called from anywhere and are TOCTOU-proof, routes get audited denials
  (a denial thrown inside the write transaction would roll its own audit row back).
- **Denial semantics**: no grant at all -> 403; a record outside scope -> 404 (existence not confirmed); tenant-level records
  (company settings, roles, legal-entity writes, translations) -> 403 for non-tenant-wide holders; users outside scope -> 404
  even when tenant-level (`enforceOnUser`).
- **Org hierarchy rules** (`src/lib/org-hierarchy.ts`): BUSINESS_UNIT, STATE and REGION may be top-level; STATE under
  BUSINESS_UNIT; REGION under BUSINESS_UNIT/STATE; CITY under STATE/REGION; BRANCH under CITY/REGION; DEPARTMENT under any
  of BU..BRANCH; TEAM under BRANCH/CITY/DEPARTMENT. A default, kept as a constant; making it per-tenant means loading a map
  of the same shape. The rule graph is acyclic (a test asserts it), so type rules alone already prevent cycles; the live-tree
  cycle check and the DB trigger are defence in depth.
- **Tree serialisation** (T1 review minor): a per-tenant `pg_advisory_xact_lock` taken first in create/update/move/archive.
  Employee placement takes `FOR SHARE` on the destination unit row and archive takes `FOR UPDATE` before counting
  placements, so an archive racing a placement cannot leave a person in an archived unit.
- **Placements**: employee history lives in `OrganizationalAssignment` only; transfers close + insert; a new PRIMARY must start
  after the current one started; only SECONDARY/TEMPORARY rows end early. The org tree's own history (which unit had which
  parent in March) is NOT versioned: it is reconstructible from `org_unit.move` audit events only. Reports needing the tree
  as-of a date need a later `OrgUnitParentHistory`; `orgUnitAt` gives the unit, not its ancestry then.
- **Employees**: `terminate` rejects future dates (no scheduled terminations yet), deactivates the login and revokes sessions
  in the same transaction. `email` uniqueness is not enforced on `Employee` (the schema has no constraint; logins are unique).
- **Users**: no user creation endpoint (accounts come from invitations); no reactivate/unlock endpoints yet (deactivation is
  one-way until a product decision); email change is out of scope (it is the login identifier).
- **Roles**: `listRoles` uses `withinScope` with an empty column map, so only a TENANT scope matches: unit-scoped holders get an
  empty page, not an error. Permission history = audit events targeting the role. A clone has no `templateKey`.
- **Pagination**: keyset by row id (`cursor` = base64url id) over a fixed `orderBy` ending in id; one extra row fetched; cursors
  must look like an id (a NUL-byte cursor was a 500 before this was validated).
- **Idempotency-Key** is enabled on creating POSTs (units, legal entities, employees, assignments, roles, clones, grants,
  invitations).
- **Seed**: `prisma/seed.ts` + `prisma/seed/` (two tenants, 12 role templates each, explicit scopes). `SEED_PASSWORD` is required
  (>= 16 chars, no default), is hashed once and never logged; the seed refuses `NODE_ENV=production`. `npm run seed` loads
  `.env` through `tsx --env-file=.env` (Prisma's client does not read it under tsx).
- No new dependencies, no new migrations.
- **`next build` fix in core** (found while building the API; every `/api/v1` route failed Next's route type check):
  `RouteHandler` is now an overloaded interface `(req)` + `(req, routeContext)` and `NextRouteContext.params` is required, because
  Next's validator reads the last signature and rejects an optional second parameter. Direct callers (tests) may still call
  `handler(req)`. `withSessionCookie` forwards accordingly. `npx next build` now passes with all routes.

### Task 5 fix round 1 (review findings)
- **Role edits vs live holders**: `replaceRolePermissions` also runs `assertMayGrantToExistingHolders`: each added/changed grant must be
  grantable (scope + field sets, one held part, like `assignRole`) in the scopes of every non-revoked, unexpired assignment of the role.
- **Legal entity is scope**: creating/re-pointing `legalEntityId` on employees and org units needs the write permission over
  `{ legalEntityId }` (so a unit-scoped manager cannot choose an employer outside their scope; denial is 404). Employee write responses are
  projected with the post-change `employees.view` decision intersected with the write grant's field sets (`projectForViewer`).
- **Archive vs scheduled placements**: the placement count ignores `effectiveFrom`, so future-dated placements block archiving.
- **Seed atomicity**: a failing seed deletes the tenant it created (tenant rows roll back with their transaction), so re-runs are not
  fooled by an empty company.
- **Managers** return a projected view (no `tenantId`). **Invitations/deactivation**: `createInvitation(..., precheck)` runs the caller's
  `users.create` check inside its transaction; `deactivateUserAccountInTx` lets `users.deactivateUser` check and write in one transaction.
- **Termination authority**: `assertMayDisableUser` refuses terminating a user who holds a sensitive role the actor could not revoke (HR cannot
  terminate the Owner). The linked login is deactivated only when the actor also holds `users.archive` over it; otherwise the employee is
  terminated and the audit event carries `loginLeftActiveForUserAdministrator: true`.
- **i18n**: ungated override functions are no longer exported from `index.ts`; the reviewer must not be the last editor.
- **Corrections of the past**: an assignment start/end more than 5 minutes in the past needs a `reason` and is audited with `correction: true`.

### Task 5 fix round 2
- Termination ALWAYS revokes every session of the linked user (no user-administration authority needed; it follows from ending employment) and
  is audited (`revokedSessions`). Nobody can terminate their own employee record.
- The users API exposes `employeeStatus` and `loginPendingDeactivation` (employee TERMINATED and user ACTIVE) and `?pendingDeactivation=true`.
  Visibility choice: such users are treated as tenant-level (termination closes their placements), so only tenant-wide user administrators see
  and can deactivate them; unit-scoped administrators do not (keeping them reachable through their last unit would need history-based scopes in authz).
- Seed cleanup failures are logged (the original error is still rethrown).



## Task 8: Administration screens
- No new dependencies. Pages are server-rendered with URL-driven filters and cursor paging; the shared `DataTable`/`Pagination`/`Field` are client components that need callbacks or render functions, so `AdminTable`, `CursorPager` and `AdminField` (server-friendly equivalents) live under `(app)/admin/_components`. `Dialog`, `ConfirmDialog` are used through `ActionDialog` / `ConfirmActionButton`.
- Navigation: admin items are visible with `<module>.view` over a TENANT, LEGAL_ENTITY or ORG_UNIT scope, or the module admin permission (`canSeeAdminModule`). OWN and ASSIGNED parts do not count (a Technician holds both on everything), which deviates from the brief's literal "non-OWN" so the Technician case is hidden as required.
- Small read services were added where no service existed: `getCompanyOverview` (organization), `listUnitChanges` (organization; audit trail filtered by unit scope, so managers need not hold tenant-wide `audit.view`), `listPlacementHistory` (employees; requires the base field set), `listInvitations` (users; scoped via the invited employee, token never selected), `listOverridesAsActor` (i18n). Each has tests.
- "User responsible" in history screens shows the actor's employee name, else login email, to anyone who may see that unit/employee history.
- Subscription/module status and branch service categories have no data model: the screens say so instead of showing invented data (§28.3).
- Pickers load at most 200 entries (employees, users, units x5 pages); larger tenants need a searchable picker later.
- Invitation resend = a new invitation (the service revokes the earlier link); there is no separate revoke service.

## Task E2E: browser smoke tests
- New devDependency `@playwright/test` pinned to exactly 1.55.1 (same version as the root VELTO app). It turns the earlier one-off manual smoke test into `npm run test:e2e`. No browser download: the suite launches the container's Chromium (`/opt/pw-browsers/chromium`) because the pinned build would look for a different revision.
- The suite builds and starts the production server (`next build` + `next start`) rather than `next dev`, so it exercises what ships (secure cookies, server actions, headers). Cost: about one minute per run.
- Isolation: the database name must end in `_test`; a globalSetup creates two fresh tenants with random company codes, so reruns and parallel agents never collide. Tenants are not deleted afterwards because deleting a tenant cascades into the append-only audit table, which its trigger rejects (untested assumption: deletion was not attempted); they are test-database litter only.
- Secrets: password, TOTP seed and `LEADRO_ENCRYPTION_KEY` are generated per run and passed through environment variables only. Traces default to off because a trace can capture typed passwords.
- The seed re-uses `prisma/seed/seed-tenant.ts` and enrols the CEO in MFA by writing the encrypted seed directly (`@/server/auth/secret-box`, a deep import because `encryptSecret` is not exported from the auth index; test tooling only). Specs derive codes with the app's own `@/lib/totp`.
- UI text is looked up from the i18n catalogs (`e2e/helpers.ts: text`), never hard-coded; the one exception is Next's built-in "This page could not be found." for the 404 check.
- Finding: the brief expected a Technician visiting `/admin/employees` to be refused. By design (SPEC 4.5, the navigation comment) a Technician has `employees.view` over their OWN record, so the page renders with only their own row and no "add" action. The spec asserts that behaviour; access-denied is asserted for company, users, roles and localization.


## Phase 2 Task 1: operational core schema + permission catalog

Foundation for the parallel Phase 2 tasks (customers, qualifications, notifications, leads, jobs, dispatch, UI,
technician app). Model guide, diagram and index table: `docs/ERD.md` "Phase 2". Constraint names are a contract
(asserted in `tests/db/phase2-schema.test.ts`). No new dependencies.

### Schema design
- **One migration** (`20261122121345_phase2_operational_core`): Prisma-generated DDL, then a hand-written block (RLS
  DO-block re-run, CHECKs, partial unique indexes, append-only triggers). `CREATE EXTENSION pg_trgm` (trusted extension)
  for fuzzy customer/lead name search; trigram GIN indexes are declared in the Prisma schema (`ops: raw("gin_trgm_ops")`)
  so `prisma migrate dev` sees no drift (verified: an immediate second `migrate dev` produced an empty migration).
- **Composite tenant-safe FKs everywhere**, plus one stricter pattern: `Job` and `Lead` reference
  `CustomerAddress (id, customerId, tenantId)`, so a job's service address must belong to the job's own customer.
  `Lead.customerAddressId` without a `customerId` is rejected by `lead_address_needs_customer` (a composite FK with a
  NULL column is not checked: MATCH SIMPLE).
- **Current assignee is a query, not a column.** No `assignedTo` on `Lead`/`Job`: the ACTIVE `LeadAssignment` /
  `JobAssignment` row is the single source of truth (no drift between two copies), enforced by partial unique indexes
  (one ACTIVE owner per lead; one ACTIVE `LEAD` per job; an employee/team at most once among a job's ACTIVE rows).
  ASSIGNED scope resolves through those rows; `(tenantId, employeeId, state)` indexes serve "my leads/jobs".
  Prisma cannot express partial indexes, so they live in the SQL (verified that `migrate dev` does not drop them).
- **Money**: `Int` minor units + `char(3)` currency, CHECK >= 0 (Int tops out near 21.4M major units; ample for a
  quote). Final/collected amounts are Phase 4 and not modeled. `quotedAmountMinor`/`currency` on jobs are the
  `financial` field set (`jobs.financial_fields`); on leads they are plain base fields (a sales estimate, not billing).
- **Identifiers and numbers**: ids are cuids; human numbers (`Customer|Lead|Job.number`) come from `NumberSequence`
  (increment with `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`), unique per tenant. Phone: typed + E.164 columns
  (`phone`, `phoneE164`; `contactPhone`, `contactPhoneE164`); email lower-case by CHECK; `normalizedKey` for addresses.
  The services compute the normalized values; the DB only validates shape.
- **Open vocabularies are strings, closed ones are enums.** Statuses and kinds the spec fixes are enums
  (`LeadStatus`, `JobStatus`, `DispatchMode`...). `JobEvent.type`, `Notification.eventType`,
  `NotificationPreference.eventType` are dotted lower-case strings (`job.assigned`, `lead.assigned`) validated by CHECK,
  because later tasks must be able to add event types without a migration (they may not add migrations).
- **Notifications store keys, not text**: `templateKey` + `params`, rendered at read time in the recipient's language
  (EN/ES/HE), so a user who changes language sees old notifications in the new one. `Notification` is per recipient
  (a `User`); `NotificationDelivery` is one row per channel ATTEMPT (`attempt` 1, 2...), carrying provider response,
  failure reason and retry status (spec 14.3). `NOT_CONFIGURED` is a delivery status so unconfigured channels are
  recorded truthfully (spec 28.3). Idempotency: unique `(tenant, recipient, idempotencyKey)`.
- **Time**: instants are `timestamptz`; `Job.appointmentWindow*` (customer-facing arrival window) and
  `scheduledStartAt/EndAt` (dispatcher's slot) are separate; `Job.timeZone` is nullable (fallback: org unit, tenant,
  like `User.timeZone`). `Availability` weekly windows are minutes after LOCAL midnight in an IANA `timeZone`, ISO
  day-of-week 1-7, exceptions are UTC intervals that override weekly windows. The service validates the zone name.
- **Qualifications**: `Skill` (level 1-5 on the employee row) and `Certification` (type CERTIFICATION | LICENSE |
  EQUIPMENT, i.e. "equipment qualification" = authorization to operate a piece of equipment). `EmployeeQualification` is
  skill XOR certification by CHECK; `kind` must match `Certification.type` (service check, not expressible as CHECK).
  A renewal is a new row (history); skills are unique per employee. Eligibility counts a row only when `VERIFIED` and
  not expired; `VERIFIED` requires `verifiedById` + `verifiedAt`. `JobType.requiredEquipment` (string list) is an
  informational "what to bring" list, NOT an eligibility rule. `JobRequirement` snapshots a job's requirements (type
  defaults + manual additions, spec 25.2 "requires additional qualification"): the eligibility engine reads only it.
- **Foresight additions beyond the brief's model list** (so the parallel tasks need no migration):
  `NumberSequence`; `OperationsSettings` (dispatch mode, disabled-transition lists for narrowing-only lifecycles,
  duplicate matcher config, enabled channels, open-attempt window for the spec 25.1 conflict rule, expiry warning days);
  `CustomerNote` (notes with author and time instead of one blob); `JobTypeSkill`, `JobTypeCertification`,
  `JobRequirement` (required skills/certifications as rows, not arrays); `DispatchRecommendation` (the ranked candidates
  with per-factor explanation, blocking reasons, decision: spec 7.4/25.2) and `JobAssignment.method/overrideReason/
  recommendationId` (manual override recorded, CHECK: an override needs a reason).
- **DuplicateFlag** covers LEAD_LEAD, CUSTOMER_CUSTOMER and LEAD_CUSTOMER pairs with real FK columns (so composite FKs
  protect them). Same-type pairs are stored with the ids in sorted order (CHECK) and a unique `pairKey`, so each pair is
  flagged once. Statuses: OPEN, NOT_DUPLICATE, CONFIRMED_DUPLICATE (no MERGED: merging is not in Phase 2).
- **Open contact attempt** (spec 25.1) = a `LeadInteraction` of kind CONTACT_ATTEMPT with `closedAt` null and newer than
  `OperationsSettings.contactAttemptOpenMinutes` (default 30).
- **History tables are append-only** (`LeadStatusHistory`, `JobStatusHistory`, `JobEvent`), like `AuditEvent`, via the
  generic `leadro_append_only()` trigger. Soft-remove everywhere else: `archivedAt`, never hard delete (all FKs RESTRICT).
- **Territories** are org units covered with `includeDescendants`; the dispatch eligibility check is "the job's org unit
  is inside one of the employee's active territories". `Job.orgUnitId` is required (service area) so ORG_UNIT scope and the
  territory check always have a target; `Customer.orgUnitId` / `Lead.orgUnitId` are nullable (unrouted = tenant-level scopes only).
- **Not modeled yet (later phases)**: attachments, complaints, payments/finance, shifts, recovery cases, materials,
  completion form submissions. `JobType.completionFormSchema` is a stored-but-uninterpreted JSON placeholder.

### Permission catalog
- Added modules `qualifications` (view, create, edit, archive, approve, manage), `notifications` (view, edit: OWN only; the
  service filters on the caller, so the grant's scope is irrelevant), `job_types` (view, configure: the catalog and job workflow
  settings; `configure` makes a role require MFA by the existing rule, so only Owner and COO hold it), and `manage` on
  `customers` (duplicate matchers) and `leads` (lead sources, lead workflow). The brief named `job_types.configure`;
  `job_types.view` was added so Dispatcher/Lead Ops/Technician can read the catalog without holding a configure right.
- **Role templates** (rationale in `docs/PERMISSIONS.md` section 5): every template gets `notifications.view/edit`; HR gets
  `qualifications.*` (HR verifies credentials); State/Regional/City managers `qualifications.view/create/edit` (no approve:
  separation from HR) and `job_types.view`; Lead Ops gains `leads.manage` (still no archive); Dispatcher keeps
  `dispatch.*`, plain job grants and read-only qualifications; Technician: plain `view` on customers/leads/jobs/dispatch,
  `leads.edit {fields:"status"}`, `jobs.edit {fields:"execution"}`; Customer Relations gets `jobs.view {set:"customer_history"}`.
- **Fixed a Phase 1 template flaw**: grants `{fields:"operational"}` (Dispatcher jobs), `{fields:"necessary"}` (Technician
  customers) and `{fields:"status"}` on leads.view/ `{fields:"execution"}` on jobs.view limit a READ to one field set, but a
  field map assigns each field exactly one tag and base readers (Owner...) do not hold those tags, so those reads would have
  returned nothing (or required tagging every field twice). Read grants are now plain: the sensitive sets (`financial`,
  `billing`) are opt-in, so "operational/necessary fields" already means "everything except financial/billing". The write
  limits for the Technician stay as field-set conditions on the EDIT grants; Tasks 5/6 define the allowed-field allowlists.
- **Field maps** (`CUSTOMER_FIELD_MAP`, new `LEAD_FIELD_MAP`, `JOB_FIELD_MAP`) classify every stored column; a test fails when
  a column is added without a tag. Money on jobs = `financial`; customer billing columns = `billing` (the "customers.billing"
  sensitive set; its category key is `customers.billing_fields`, unchanged).

### Seed
- `prisma/seed/seed-operations.ts` (`seedOperationalData(tenantId, slug)`, idempotent, also back-fills tenants seeded before
  Phase 2) adds 6 skills, 6 certifications/licenses/equipment qualifications, 6 job types with requirements, 6 lead sources,
  default `OperationsSettings`, and technicians. It is separate from `seedTenant` on purpose: the e2e fixture and the seed
  tests rely on `seedTenant` creating exactly one employee per role template. Extra technicians are employees WITHOUT a login
  (no password to manage): per team 3 profiles (electrician with a license expiring in 25 days, junior with a PENDING
  EPA certificate and short hours, plumber with an EXPIRED license and upcoming time off), and the seeded `technician`
  login gets the senior HVAC profile. Territories cover the technician's city (senior: the whole region); availability is
  weekly windows in the branch time zone. No customers, leads or jobs.


### Phase 2 Task 1, fix round 1
Migration `20261122140000_phase2_schema_fixes` (the first migration was already applied to the shared test DB, so it is untouched). Full description in `docs/ERD.md` "Phase 2 fix round 1".
- **Job-category permissions**: chose a separate table `EmployeeJobPermission` (job type XOR category, time-bounded, granted by a user) over a `JOB_CATEGORY` qualification kind: it is an authorization decision with its own validity and grantor, not a credential with a number/issuer/verification, and keeping it out of `EmployeeQualification` leaves that table's kind/target CHECKs simple. `TRAINING` added to `QualificationKind` (backed by a `Certification` of type TRAINING).
- **Distance origins**: `OrgUnit.latitude/longitude` and `Employee.startLatitude/startLongitude`, validated `Decimal(9,6)`. The existing untyped `OrgUnit.address` JSON stays for display only. Straight-line estimates need origin + `CustomerAddress` coordinates; absent coordinates = "distance unknown".
- **Customer preference** is `CustomerPreferredEmployee` (PREFERRED | AVOID, composite FKs) instead of an id inside `contactPreferences` JSON.
- **Stricter composite FKs**: assignment recommendation must belong to the same job; a job's lead must belong to the job's customer (so conversion links the lead to its customer first); `OperationsSettings.updatedById` is an FK; qualification kind is bound to `Certification.type` by a composite FK to `Certification (id, type, tenantId)` (replaces the former service-only check).
- **Technician write limits** are now defined: `LEAD_STATUS_FIELDS`, `JOB_EXECUTION_FIELDS`, the `*_WRITE_ALLOWLISTS` maps and `assertWritableFields` / `writableFields` in `authz/writable-fields.ts` (field maps classify reads; allowlists define the narrow write sets). Tests in `tests/authz/writable-fields.test.ts`. Tasks 5/6 must call `assertWritableFields` for every lead/job update.
- **JSON / polymorphic reference contract** (ids only, tenant-scoped resolution plus authz re-check, never copy names/PII): in ERD. Also documented: intake must always set `sourceId`; availability windows cannot cross midnight (split night shifts, evaluate per local date incl. DST).
- Seed: branch coordinates and per-technician job-category permissions added (`seedOperationalData`).

### Phase 2 Task 3: qualification engine
No schema change and no new dependency. Rules are pure (`src/lib/eligibility`, `src/lib/zoned-time.ts`); services in `src/server/qualifications`.
- **`isEligible` takes explicit requirements, not a job.** `isEligible(tx, tenantId, employeeId, requirements, { at, window, timeZone })` so dispatch can call it for a job, a job type ("what if") or a candidate pool (`evaluateCandidates`). `requirementsFromInputs` takes the jobs module's `EligibilityInputs` (the jobs task implements `getJobEligibilityInputs`; this module never reads job tables); `requirementsForJobType` adds optional extras (stricter minimum level wins). The service functions do not check permissions (the caller has authorized itself); the HTTP check `POST /qualifications/eligibility` requires `qualifications.view` over the employee.
- **Failures are `{ code, params }`** (10 codes, `QUALIFICATION.FAILURE.<code>` in all catalogs, `kind` params via `QUALIFICATION.KIND.<kind>`). All failing rules are reported, in a fixed order, so the dispatcher sees everything to fix at once. The result also says which optional rules were evaluated (`checked`), so "eligible" never reads as "availability confirmed" when no window was given.
- **Time semantics**: `window` is the span the employee must be able to work, evaluated whole: credentials, job permissions and territories must hold for its entire length (a credential lapsing mid-job fails), availability must cover all of it. A credential dated `expiresAt` is valid through the END of that calendar day in the job's zone (job zone, else nearest branch zone, else company: the Phase 1 `resolveTimeZone`). Weekly windows are read per local date in their own zone: they cover the instants whose local clock lies in `[start, end)`; a skipped wall time (02:30 on spring-forward) starts where the clocks jump, a repeated one maps to its first occurrence. Adjacent windows merge (night shift = Mon 22-24 + Tue 00-06). Exceptions beat weekly windows; an `EXCEPTION_UNAVAILABLE` overlap always blocks. **No availability rows = never available** (an unrecorded schedule is not "free"); no territory rows = outside every territory; no matching job permission = not authorized (ERD: a row must exist).
- **Rows**: several rows per skill/credential are fine (renewals); the best counts; REJECTED and REVOKED count as not held. An EQUIPMENT/TRAINING requirement is a `Certification` of that type (the message names the kind).
- **Verification workflow**: records start PENDING_VERIFICATION; `qualifications.approve` (HR, Owner) verifies/rejects/revokes; nobody verifies their own record (§21.3). A material edit of a verified record, or any edit of a rejected/revoked one, returns it to pending (so editing cannot launder a credential). The status machine is `src/lib/qualification-lifecycle.ts`; the audit event (previous + new status) is the history (no separate StatusHistory table for qualifications). A skill's unique key means a rejected/revoked skill is resubmitted by editing it. `requiresNumber` is enforced at create and verify; verifying an already-expired record is refused.
- **Permissions**: view/create/edit scoped by the EMPLOYEE's scope (a nested `employee` where-fragment from the employee scope columns) and the `base` field set; catalogs need `qualifications.manage` with a TENANT scope; territories need `edit` over the employee AND the org unit; job-category permissions need `approve` (it is an authorization grant, not a record of fact, so managers who hold `edit` cannot self-authorize their reports).
- **Deletion**: territories and job permissions are ended (an ended territory is reopened when re-added, since the unique key is employee + unit; the audit event keeps the earlier period), credentials revoked, catalog entries retired. `Availability` rows are the one exception: plain schedule data with no history need, DELETE is audited with the previous value.
- **Expiring query**: `findExpiringQualifications` (system, no actor, for notifications; default horizon `OperationsSettings.qualificationWarningDays`, 30 when unset) and `GET /qualifications/expiring` (scoped). Only VERIFIED rows of non-terminated employees; "today" is the company's calendar date; a row expiring today is listed with 0 days left. Dedupe key for notifications: `qualificationId` + `expiresOn`.
- **§10.3**: no performance, rating or workload field exists in any eligibility type; a test fails if the eligibility source mentions one.

### Phase 2 Task 3, fix round 1
- **Private fields**: credential `number` is masked (last four) for everyone except the holder and `qualifications.approve` holders; the audit log stores it masked (call-site masking, so `number` elsewhere is not over-redacted). Availability `note` follows the same visibility. `reveal.ts` computes visibility once per page.
- **Jobs boundary**: `requirementsForJob` removed; `requirementsFromInputs(tx, tenantId, EligibilityInputs)` replaces it. `requirementsForJobType` still reads `JobType` tables (job configuration; ownership moves to the jobs module when it exists).
- **Archived territory units** do not cover (treated as ended). **Status gate**: TERMINATED always blocks; ON_LEAVE blocks only work starting at or before the decision time, future leave is an EXCEPTION_UNAVAILABLE row. "Already expired" at verification uses the company calendar date. `UNAVAILABLE_TIME_OFF` has no params. A pending, still-valid renewal turns EXPIRED into `QUALIFICATION_RENEWAL_PENDING`; the EXPIRED message no longer says "expires ... before the work is done" for past dates.
### Phase 2 Task 4: notifications engine (§14)
Code: `src/server/notifications/`, `src/lib/notification-rules.ts`, `/api/v1/notifications/**`, catalog keys `NOTIFICATION.*`.
- **Write in the business transaction, deliver after commit.** `notifyInTx(tx, event)` only inserts `Notification` + attempt-1
  `NotificationDelivery` rows; `deliverAfterCommit` / `deliverPending` send afterwards and never throw into the caller. A rolled
  back business change therefore leaves no notification, and a broken provider can never undo a committed one. Unsent rows stay
  PENDING for the worker (`deliverPendingForAllTenants`); no scheduler is wired in yet (no worker infrastructure exists), the
  function is ready to be called from one.
- **Typed event catalog** (`NOTIFICATION_EVENTS`): event type -> template key, critical flag, link target type. Callers pass only the
  event type, so a template key can never disagree with the event; new events are one row plus six catalog keys. `job.cancelled`,
  `qualification.expired` and `account.security_alert` are critical (mandatory operational/security notices, §14.1).
- **Params contract enforced in code**: names are camelCase, values are numbers, booleans or identifier-like strings
  (`[A-Za-z0-9_.:-]{1,64}`, so no spaces, `@`, `+`): names, emails and phone numbers cannot be stored. Text is rendered at read time
  (`renderNotification` / `renderNotificationForRecipient`) in the RECIPIENT's locale chain with reviewed tenant overrides. The API returns key + params, not text.
- **Idempotency**: unique `(tenant, recipient, idempotencyKey)`, default key `<eventType>:<eventId>`; inserted with
  `createMany(skipDuplicates)` (ON CONFLICT DO NOTHING) so a race cannot abort a business transaction. Only recipients that were
  actually inserted get delivery rows.
- **Channels**: IN_APP always (the row is the inbox), plus the tenant's `OperationsSettings.enabledChannels`. In-app cannot be opted
  out of (it is the record of the event). Non-critical opt-outs create a SKIPPED row (truthful record); critical events ignore
  opt-outs. PUSH/EMAIL/SMS default to `notConfiguredChannel` -> status NOT_CONFIGURED, `provider` null, never SENT (§28.3). A provider is
  installed with `setNotificationChannel`.
- **Retries**: one row per attempt. A retryable FAILED attempt gets `retryStatus = SCHEDULED` + `nextRetryAt` (1 min, then 5 min, 3 attempts);
  the sweep claims it (SCHEDULED -> NONE) and inserts attempt n+1. After the last attempt the row is EXHAUSTED; a non-retryable failure is NONE.
  Workers claim PENDING rows by stamping `attemptedAt` (claims older than 5 min are reclaimed after a crash), so concurrent workers never double-send,
  and channel I/O runs outside any transaction. A thrown channel error is stored as `CHANNEL_ERROR` (provider text may contain addresses; it goes only to the log).
- **Recipient resolution** (`resolveRecipientsByPermission`, `resolveLeadOperationsRecipients`): SQL pre-selects ACTIVE users with an active assignment of an
  active role carrying the permission, then every candidate is confirmed with authz `canInTx(... { orgUnitId })`, so scope rules have one implementation. Lead
  Operations = `leads.assign` over the unit (descendants included); only if nobody holds it, widen to `leads.view` so a lead is never unannounced. Grants qualified
  by a record set do not match a plain unit reference and are not recipients.
- **Not audited**: mark-read and preference changes are per-user conveniences, not business changes; events are audited by the business write that raised them.
- **Preference rows**: absent = enabled; a specific event row beats the `*` row. PUT refuses critical events and IN_APP instead of storing rows that would be ignored.
- Not built (later tasks): the TopNav bell UI, a scheduler for the worker sweep, real providers.

#### Task 4 fix round 1
- **Access is checked twice.** Write time: `notifyInTx` takes `target { targetType, targetId, permission, resource }` and drops (counts, logs) recipients failing `canInTx(permission, resource)`; `resolveRecipientsByPermission` still only checks the org unit, so the target check is what applies record-level conditions. Read time: `registerNotificationTargetResolver(targetType, permission, resolve)` (the permission is part of the registration because the notification row does not store one); list and delivery redact (generic `NOTIFICATION.ITEM_UNAVAILABLE`, no params, no target) when access is lost, the record is gone or the type is unregistered (fail closed). Leads/jobs tasks must register "lead"/"job".
- Event params are now exactly the declared list (undeclared or missing keys throw); `target.targetId` must be identifier-like and `targetType` must match the event.
- `recordOutcome` only updates a row the worker still holds (PENDING with its own `attemptedAt` stamp). Delivery is at-least-once; providers dedupe on `notificationId` + `attempt`.
- Retry scheduling uses `createMany(skipDuplicates)` after claiming the parent: a sweep found leftover rows whose next attempt already existed, and the unique violation would have aborted every retry of that tenant. `deliverPendingForAllTenants` takes optional `tenantIds` (used by tests; each tenant costs two transactions per sweep).
## Phase 2 Task 2: customers module (service, `/api/v1/customers`, duplicate detection)

Code `src/server/customers` (README), routes `src/app/api/v1/customers/**`, reference `docs/API_REFERENCE.md` "Customers". No schema change, no new dependency.

- **Scope resolution for customers** (also in `docs/PERMISSIONS.md` section 8): ORG_UNIT/LEGAL_ENTITY follow `Customer.orgUnitId` (the single service-area unit; per-address units drive jobs, not customer visibility); no unit = tenant-level. ASSIGNED = some non-archived lead/job of the customer has an ACTIVE assignment to the caller. OWN matches nothing. Record-set grants: `job_related` = has a non-archived job (Dispatcher), `lead_related` = has a non-archived lead (Lead Ops); implemented in lists as a union of per-set query fragments (a plain where-fragment cannot carry a set), each variant carrying its own field sets. Any other set matches nothing (fail closed). A denial on a customer record is always a 404: the resource ref always carries `assignedEmployeeIds` and `sets`, so `enforceInTx` never treats it as "tenant-level" (which would answer 403 and confirm existence).
- **ASSIGNED helper lives in customers, not in jobs/leads** (manager contract, reversed ownership because leads/jobs do not exist yet): `assignment-access.ts` exports where-fragments (`leadAssignedToWhere`, `jobAssignedToWhere`, `customerAssignedToWhere`) and the id form (`assignedEmployeeIdsByCustomer`); a test proves both agree. Team expansion = employees with an ACTIVE placement (`activePlacementWhere`) in exactly `JobAssignment.teamOrgUnitId` (teams are leaf units; descendants not expanded). Assignments stay effective until ENDED: leads/jobs services decide when to end them (documented in the README as their obligation). Archived leads/jobs assign nobody.
- **Set-qualified create grants**: Lead Ops holds `customers.create {set:"lead_related"}`, but a customer that does not exist yet belongs to no set. A create is judged as if the new customer belongs to every set (the creator's role is the context). After the write the response is projected from the caller's VIEW decision on the new record (`{ id }` when that grant does not cover it yet), the same pattern as employees.
- **Duplicate detection** (§6.4): runs inside the write transaction after create, update (name/email/phone changed), address add/update and restore. Tenant-wide lookup under RLS; it flags, never merges and never blocks. Matchers are configurable in `OperationsSettings.duplicateMatchers` via `customers.manage` (tenant-wide): phone (E.164 equality), email, address (equal `normalizedKey` on a non-archived address), name (case-insensitive equality, OFF by default: common names collide). Defaults when never configured: phone/email/address on, name off. "Recent history" is a lead-side matcher (leads task). Archived customers are matched too (a returning customer is the classic duplicate). `DuplicateFlag.reason` stays null: `matchedOn` (enum) carries the language-neutral explanation and the UI renders it by key; storing the matched phone/email in a free-text reason would copy PII.
- **Decisions stick**: a pair already `NOT_DUPLICATE` / `CONFIRMED_DUPLICATE` is never reopened or rewritten by later detection; an OPEN pair only has its `matchedOn` refreshed. Pairs are stored once (`customerId < otherCustomerId`, `pairKey = customer:<lo>:<hi>`, `createMany skipDuplicates` so concurrent detections cannot abort the transaction). "Link" in the brief = `CONFIRMED_DUPLICATE` (the schema has no MERGED status; merging is out of Phase 2). A decision may be changed to the other one (audited with the previous status); repeating the current one is 409.
- **Duplicate visibility vs isolation**: flags are created from the whole tenant, but a flag is listed or returned to a caller only when they may view BOTH customers, and resolving needs `customers.edit` over both (else 404). Consequence worth knowing: a City A manager who creates a customer duplicating a City B customer gets no warning (revealing it would leak that customer's existence); the pair appears in the queue of anyone whose scope covers both (state manager, tenant-wide roles). Chosen over leaking because tenant/branch isolation is binding.
- **Phone**: stored as typed (`phone`) plus `phoneE164` (`src/lib/phone.ts`). No `+`: 10 digits or 11 starting with 1 are North America (the launch market, §1.2); `00` prefix = international; anything else is rejected (`400 field phone`) rather than guessing a country. Extensions are cut before normalizing. Partial phone search matches `phoneE164 contains <digits>` for phone-looking terms (3+ digits, digits and `+ ( ) - .` only), plus `#number` for customer numbers.
- **Address key** (`src/lib/address-key.ts`): lower-case, punctuation (`. , # '`) removed, whitespace collapsed, US ZIP+4 = ZIP, other postal codes lose spaces; no abbreviation expansion ("St" != "Street") on purpose: a false match costs reviewer attention, a miss costs only a missed hint. Different apartments (`line2`) are different keys.
- **Billing set**: written only by a grant that names it (`assertWritableFields` against `CUSTOMER_FIELD_MAP`, checked on the keys SENT), read only through projection. The audit log records billing columns by NAME only (`billingFieldsChanged`), because audit readers need not hold a billing grant. Search and filters (`q`, `orgUnitId`, `kind`, `preferredLocale`, `archived`) drop rows the caller sees only through a billing-only grant (Finance), so a filter cannot be used as an oracle for hidden base values.
- **History view**: leads/jobs of the customer, limited to what the caller may view in their own right (`leads.view`; `jobs.view` with `satisfiedSets: ["customer_history"]`, the only caller of that set, so Customer Relations works). Only `id, number, status, createdAt, archivedAt`; no money. `access.{leads,jobs}` says whether the caller holds the permission at all. Scope columns for leads/jobs inside `history.ts` express ORG_UNIT/LEGAL_ENTITY on `Lead.orgUnitId` / `Job.orgUnitId` and reuse the shared ASSIGNED fragments; the leads/jobs tasks may replace them with their own exported columns, but must keep ASSIGNED on the shared helper.
- **Archive, not delete**: `POST /customers/{id}/archive` and `/restore` (both `customers.archive`). Archived customers are read-only until restored. Archiving does not check for open jobs (the job lifecycle is Task 6's); leads/jobs creation must refuse NEW work for an archived customer (README obligation).
- **Addresses**: exactly one active primary (first address, or the one flagged; archiving the primary promotes the oldest remaining; `isPrimary:false` on the primary is refused); serialised per customer by an advisory lock. An address's own service-area unit needs `customers.edit` over that unit judged against the customer's real sets/assignments. Coordinates are optional, paired, `coordinateSource = "manual"` (no geocoder, §28.3), returned as numbers.
- **Notes** are append-only (no edit/delete route): what staff recorded stays on record; the audit event stores the note id, not the text. **Preferred employees** (`CustomerPreferredEmployee`) are a whole-list `PUT` (a customer has few), with a "soft hint, never an eligibility rule" contract for dispatch.
- **`nextNumber(tx, tenantId, "customer"|"lead"|"job")`** added to `core` (one atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, ids from `gen_random_uuid()`); leads/jobs must use it. A rolled-back create leaves a gap, never a repeat. This is the only file outside the customers area that was added (`core/number-sequence.ts` + 2 export lines in `core/index.ts`).
- **API shape notes**: `POST /customers` returns the customer plus `possibleDuplicates` (flags the caller may see); archive/restore accept an empty body; routes use `requirePermission` with `customerResourceRef` as resolver (route-level gate), services re-check with `enforceInTx`.

## Phase 2 Task 5: leads module (service, `/api/v1/leads`, lifecycle, assignment, conversion)

Code: `src/server/leads` (README), `src/lib/lead-lifecycle.ts`, routes `src/app/api/v1/leads/**`, tests `tests/leads/**`. No new dependency, no migration.

- **Status machine** (`src/lib/lead-lifecycle.ts`): default path NEW -> ASSIGNED -> CONTACT_ATTEMPTED -> CONTACTED -> QUALIFIED -> SCHEDULED -> DISPATCHED -> CONVERTED (NEW may go to UNASSIGNED, ASSIGNED may skip to CONTACTED). Each transition is `path` (cannot be disabled) or `optional` (a tenant may list it in `disabledLeadTransitions`; entries that are not optional transitions are ignored, so a tenant can only narrow). LOST / DUPLICATE / CANCELLED close a lead from any open status (LOST not from NEW: triage first); LOST and DUPLICATE can be reopened to UNASSIGNED, CONVERTED and CANCELLED are final. CONVERTED is reachable from QUALIFIED, SCHEDULED, DISPATCHED. LOST and CANCELLED need a reason, DUPLICATE names the original lead.
- **ASSIGNED, CONVERTED and releasing an owner are action-only.** The status endpoint refuses them (400): ASSIGNED needs an owner, CONVERTED needs a job, and releasing an owner must go through `unassign` so the section 25.1 rule cannot be bypassed by a plain status change. NEW leads stay NEW until assigned or triaged to UNASSIGNED; `unassign` returns a lead to UNASSIGNED (the pool).
- **One status writer**: `applyLeadStatus` validates, updates with a guard on the status read (concurrent change = 409), writes `LeadStatusHistory` and audits. Closing (CONVERTED/LOST/DUPLICATE/CANCELLED) or releasing a lead ENDS the owner's assignment, so ASSIGNED scope does not outlive the work (the customers README obligation); archive does the same.
- **Spec 25.1 conflict rule**: an "open contact attempt" is a CONTACT_ATTEMPT without `closedAt` newer than `contactAttemptOpenMinutes` (tenant setting, default 30). Assigning or releasing while an open attempt of ANOTHER employee than the new owner exists is `409 CONFLICT field:confirmOpenContactAttempt` until repeated with `confirmOpenContactAttempt:true` and a reason; the assignment row stores `conflictConfirmed`, the other open attempts get `closedAt` (outcome stays empty, nothing is deleted) and the audit event lists their ids. Replacing an existing owner always needs a reason. An attempt recorded WITH an outcome is already finished; one without stays open until `/close`.
- **Assignee rules** ("lead assigned to unavailable employee / wrong region"): the employee must be ACTIVE (ON_LEAVE or TERMINATED refused), have a current placement and an active login, and must hold `leads.view` over the lead once assigned (so an unrouted, tenant-level lead cannot be handed to a unit-scoped employee). An employee whose placements are neither the lead's unit nor above/below it needs `confirmOutsideServiceArea` plus a reason. Availability windows (shifts) are deliberately not consulted: they are for jobs, not leads.
- **Record set `dispatch_related`** (Dispatcher `leads.view`): leads in QUALIFIED, SCHEDULED, DISPATCHED or CONVERTED, i.e. those that have reached dispatch. Lists use the same union-of-variants approach as customers (`lead-access.ts`); any other set matches nothing. A denial on a lead is always 404 (the resource ref always carries `assignedEmployeeIds` and `sets`).
- **Write limits**: updates call `assertWritableFields(decision, changedFields, LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS)`. PATCH has no status field, so a Technician (`{fields:"status"}`) can change nothing there (403); they move the status through `/status`, where `status` and `closedReason` are allowed but not `duplicateOfLeadId`. Interactions (notes, contact attempts, follow-ups) are written with a grant that may write the base field `notes`, so a status-only grant cannot log customer contact. The status, owner, source and customer link have their own actions and are not PATCH fields.
- **Intake**: needs `leads.create` over the unit (like customers: a set-less create judged as a record with no assignee; no unit = tenant-wide grant, 403 otherwise). Needs only some way to reach the customer. Idempotent twice: the route-level `Idempotency-Key` and `(sourceId, externalId)` (a repeated webhook answers 200 with the existing lead; if the caller may not see that lead it is a 409 and nothing is revealed). `sourceCode` is accepted next to `sourceId` because integrations know the code. The lead address is stored as received; its matching key is built only from a complete address (US assumed, as leads carry no country). The lead number comes from a separate short transaction (same trade-off as customers: a gap is possible, a repeat is not).
- **Duplicates**: tenant matchers from `OperationsSettings.duplicateMatchers` (shared with customers). LEAD_CUSTOMER flags use the customers module's `findDuplicateCustomerCandidates` (archived customers included; the lead's own linked customer excluded); LEAD_LEAD flags consider non-archived leads created in the last 30 days (`RECENT_LEAD_WINDOW_DAYS`, the "recent history" of 6.4; the enum value RECENT_HISTORY is not used because the window is a qualifier, not a field). Pair keys: `lead:<a>:<b>` (sorted ids) and `lead_customer:<lead>:<customer>`. Flags only: no merge, no blocking, decided pairs are never reopened. Every response reveals only duplicates whose other side the caller may view; the review queue lists a flag only when BOTH sides are viewable (so a lead-customer flag is invisible to Lead Operations unless the customer has a lead: `customers.view` for them is `lead_related`). Resolving needs `leads.edit` over the lead(s) (and `customers.view` over the customer). "Confirmed duplicate" records the decision only; the lead is then moved to DUPLICATE or linked. Linking a lead to a customer (`link-customer`) closes the pair's open flag as CONFIRMED_DUPLICATE.
- **Conversion** (`POST /leads/{id}/convert`): one transaction: link customer/address/job type to the lead, `createJobFromLead` (job module), lead -> CONVERTED, audit. Authority: `leads.view` over the lead AND `jobs.create` over its area (so Dispatchers, who hold `jobs.create` and see dispatch-related leads, and the unit managers convert; Lead Operations, who hold no `jobs.create` in the default matrix, hand qualified leads over). The customer is judged as if it already belonged to the sets the new work gives it (`lead_related`, `job_related`), otherwise a Dispatcher's `job_related` grant would hide the very customer the job is for. Missing customer/address/job type are asked for (400), never guessed; archived customer refused (409); converting twice returns the existing job (`replayed`). There is no "create customer from lead" action: create the customer (`POST /customers`, which flags duplicates) and link it.
- **Jobs seam**: `job-conversion-port.ts` holds the agreed `createJobFromLead(tx, actor, input)` contract; it is a throwing stub until the jobs module is merged (wiring steps in the module README; the stub's behavior is pinned by `tests/leads/conversion-port.test.ts`, the real flow by `tests/leads/conversion.test.ts` with a mock that inserts a Job in the same transaction).
- **Notifications**: `lead.assigned` to the new owner (not when assigning to oneself) and `lead.needs_owner` to Lead Operations of the unit on intake (`resolveLeadOperationsRecipients`, creator excluded), both via `notifyInTx` in the business transaction, `deliverAfterCommit` after it. No new event types were needed. The "lead" target resolver (`leads.view`) is registered when the module loads and from the new `src/instrumentation.ts` (`register()` is the one place for such startup registrations; the jobs module adds its own line there; the file is Node-runtime only). `lead.follow_up_due` exists in the catalog but no sweep raises it yet: follow-up due dates are stored and queryable (`followUpDue=true`), the scheduled job that notifies belongs with the Phase 2 workers.
- **ASSIGNED derivation**: stays in `@/server/customers` (`leadAssignedToWhere`, `assignedEmployeeIdsByCustomer`); leads uses the fragment as `ScopeColumns.assigned` and builds `assignedEmployeeIds` from the ACTIVE assignment; `tests/leads/sources-archive.test.ts` pins that the list fragment, the per-lead reference and the customer's assigned employees agree.
- **i18n**: `LEAD.*` keys (statuses, priorities, source types, outcomes, interaction kinds, conflict prompts, duplicate labels) in en-US, es-US and he-IL for the Task 8 screens. API payloads stay language-neutral.

## Phase 2 Task 6: jobs module (service, `/api/v1/jobs`, lifecycle machine)

Code `src/server/jobs` (README), `src/lib/job-lifecycle.ts`, routes `src/app/api/v1/jobs/**`, reference `docs/API_REFERENCE.md` "Jobs". No schema change, no new dependency.

- **Lifecycle machine** (`src/lib/job-lifecycle.ts`, §7.2): one table of edges, each `core` (always on) or `optional` (a tenant may switch it off). Default path and every way OUT of an exceptional status that the job needs to avoid being trapped are core; entering an exceptional status (CANCELLED, ON_HOLD, RESCHEDULED, CUSTOMER_UNAVAILABLE, FAILED, REQUIRES_RETURN_VISIT) and the "undo" edges are optional. A test proves every open status still reaches CLOSED with ALL optional edges off. CLOSED and CANCELLED are terminal (a closed job is followed up by a new job with `parentJobId`, never reopened). Edges that depend on the job (assignee for ASSIGNED and later, scheduled slot for SCHEDULED, review rule at COMPLETED) are pure guards in the same file.
- **Tenant narrowing** is `OperationsSettings.disabledJobTransitions` ("FROM>TO"). `PUT /jobs/workflow-settings` (`job_types.configure`, tenant-wide, MFA by the existing configure rule) refuses names that are not optional edges; the machine also ignores such names already stored, so a tenant can neither add an edge nor remove a core one.
- **A job is born PENDING_ASSIGNMENT**, with two history rows (null > CREATED by the user, CREATED > PENDING_ASSIGNMENT by the system) so the trail is complete and the "unassigned" queue works without a separate flag. The job type's skills and credentials are copied to `JobRequirement` rows (the job keeps its own requirements when the type changes); manual extras (§25.2) can be added at creation only (a later "add requirement" operation is not built).
- **Who may create** (manager contract: no re-implemented scope logic, `assertCustomerActive`, `nextNumber`): `jobs.create` over the service-area unit = the address's unit, else the customer's. An explicit `orgUnitId` is only accepted inside the customer's unit (a dispatcher cannot attach a customer's work to a unit the customer is not part of) and then `jobs.create` is needed over the customer's unit as well. A customer with NO unit (tenant-level) needs a tenant-wide `jobs.create`: otherwise creating a job would make a tenant-level customer visible to a unit manager through the `job_related` set. Creation does not require `customers.view` (a Dispatcher's customer grant is `job_related`, which a customer without jobs cannot satisfy).
- **`createJobFromLead(tx, actor, input, ctx?)`**: runs in the leads module's transaction; authorization stays with the lead service (a Lead Operations manager converts without `jobs.create`). Idempotent per lead: an advisory transaction lock on `(tenant, lead)` serialises two conversions, the existing job is returned with `created: false`, and the unique `(leadId, tenantId)` index is the backstop. The unit falls back address > customer > lead. Return value `{ id, number, created, warnings }` (the brief fixed the arguments, not the result). The optional 4th argument only carries the correlation id and source app into the audit row.
- **Manual assignment with enforced eligibility** (dispatch recommendations are Task 7): `assignJob` runs the qualification engine on the job's own requirement rows (`getJobEligibilityInputs` + `requirementsFromInputs`), at the scheduled slot or else the appointment window. An ineligible target is `409 CONFLICT` with one detail per failure code. A team is eligible when at least one CURRENT member is (a team has no qualifications of its own; the team lead allocates inside it), and an empty team is never assignable.
- **Override permission choice: `jobs.approve`** (not `dispatch.manage`, `dispatch.assign`, or a new `dispatch.approve` key). Reasons: `jobs.approve` is already in the catalog as the "approve an exception on a job" permission; it is NOT in the Dispatcher template, so the person who makes assignments is not the person who excuses a licence or safety rule (separation of duties, §4.4 spirit); Owner/CEO and COO hold it by default and a tenant can grant it to a senior-dispatcher custom role without code changes; `dispatch.manage` means dispatch SETTINGS and the Dispatcher holds it, which would make the override a routine click. Cost if wrong: dispatchers must escalate unusual cases; re-map by granting `jobs.approve` to a custom role. An override needs a reason, is stored on the assignment (method OVERRIDE + `overrideReason`), as a `dispatch.override` event and in the audit log, and can never cover employment failures (terminated, on leave now, empty team): that is a legal fact, not a skill gap.
- **Reassignment** ends the old ACTIVE row (kept, with `endedReason`) and inserts the new one in the same transaction under a job row lock (`SELECT ... FOR UPDATE`; the DB also has one-active-lead and one-active-per-employee partial indexes). Allowed until the technician is on the way (`ASSIGNABLE_STATUSES`); reassigning mid-field-work is Phase 3. Unassign returns the job to PENDING_ASSIGNMENT and clears the scheduled slot (a slot without an owner is meaningless). CLOSED and CANCELLED end the assignments so ASSIGNED access (jobs, and customers derived from them) stops, as the customers README requires; COMPLETED does not (the technician keeps the job through review).
- **Scheduling**: the slot needs an assignee; setting one on ASSIGNED / RESCHEDULED / CUSTOMER_UNAVAILABLE / REQUIRES_RETURN_VISIT moves the job to SCHEDULED, so `scheduledStartAt` and status cannot disagree. §25.2 conflicts (duration vs window or slot, assignee not eligible or available at the new time) are returned as `warnings` and never block ("display the conflict, preserve the job"); only assignment is a hard gate. The "appointment window" is the customer-facing arrival window, so an estimated duration longer than it is common; it is a warning, not an error.
- **Field-level writes**: every write calls `assertWritableFields(decision, keysSent, JOB_FIELD_MAP, JOB_WRITE_ALLOWLISTS)`: PATCH (title, description, instructions, priority, duration, timeZone, money), transition (`status`, `statusReason`), reschedule (window and slot columns) and create. A Technician therefore changes `instructions`, `status` and `statusReason` and nothing else; in Phase 2 an execution-only grant may move a job only to EN_ROUTE (`TECHNICIAN_TARGET_STATUSES`; arrival, start and completion need Phase 3 location and completion data). Assign / unassign use `jobs.assign` and require the base field set. Review decisions need extra permissions: AWAITING_REVIEW > CLOSED `jobs.approve`, back to IN_PROGRESS `jobs.reject`.
- **Reads**: list and single reads use `jobScopeColumns` / `jobAssignedToWhere` from customers; per-row field sets come from the grants that cover THAT row. Filters on base columns hide rows a caller sees only through a financial-only grant (Finance), as in customers. History, events and assignment history need the base field set (Finance sees money, not who did what). `GET /jobs/mine` is the technician view (assigned directly or through a team, soonest first, finished work hidden by default).
- **Assigned-employee derivation**: `loadJobAccessFacts` (per job, with team expansion) lives in jobs; `jobAssignedToWhere` stays in customers. They are two forms of one rule, pinned by `tests/jobs/access.test.ts` (including archived jobs, ended rows, team members who left). The manager asked for one shared helper; customers already shipped its own batch form, so jobs adds the per-job form and the test is the single point that keeps them equal (a later refactor could make customers call `assignedEmployeeIdsByJob`).
- **Notifications**: `job.assigned`, `job.rescheduled` link to the job (recipients without `jobs.view` over it are dropped); a new `job.reassigned` event ("no longer assigned to you", also sent on unassign) and `job.cancelled` carry the job NUMBER only, with no link, because their recipients have just lost access and the link check would silently drop them. The read-time resolver for target type "job" (`jobs.view`) is registered when the jobs module is loaded (`registerJobNotificationTarget`, also exported). **Integration note**: the notifications routes do not import jobs, so a deployment must import `@/server/jobs` (or call `registerJobNotificationTarget()`) at startup; until then job links are shown redacted (fail closed). Delivery after commit via `deliverAfterCommit`.
- **Audit and money**: money columns are recorded by field NAME only (`financialFieldsChanged`), as for customers' billing. Status changes write `job.status_change` in addition to `JobStatusHistory` and a `job.status_changed` event; the history table records who (or SYSTEM) and why.
- **Not built** (later or other tasks): archive endpoint for jobs (cancel instead), adding requirements after creation, recurring agreements and integration origins, crew (CREW role) assignments, travel/arrival field events (Phase 3), dispatch recommendations (Task 7), UI (Tasks 8-9).

## Phase 2 Task 7: dispatch engine (`/api/v1/dispatch`, recommendations, modes)

Code `src/server/dispatch` (README), pure ranking `src/lib/dispatch-scoring.ts`, routes `src/app/api/v1/dispatch/**`, reference `docs/API_REFERENCE.md` "Dispatch". No schema change, no new dependency, no LLM (§28.6).

- **Two stages, kept apart.** (1) HARD eligibility: the qualification engine over every non-terminated employee of the tenant (up to `MAX_POOL` = 500 per pass, ordered by id; employees already holding the job are skipped): employment, verified unexpired skills and credentials, job-category permission, service territory, availability at the slot or window. (2) SOFT ranking of the eligible only. Nobody who fails stage 1 can appear in a ranking, and `approve` / `modify` re-run the hard rules through `assignJob` at decision time.
- **No performance factor** (§7.3, §10.3). Eligibility has none; scoring has exactly four soft factors. A test asserts the stored recommendation contains no rating/speed/revenue/performance field.
- **Factors and weights** (points, deterministic, tunable only in `dispatch-scoring.ts`; max 100):
  - DISTANCE 0..40: haversine km from the employee's start point (`Employee.startLatitude/Longitude`, else the coordinates of their current PRIMARY org unit) to the job's service address; linear from 40 at 0 km to 0 at 50 km. Unknown coordinates score the NEUTRAL half (20) and raise a `DISTANCE_UNKNOWN` conflict, so missing data neither rewards nor punishes. Always labelled a straight-line estimate (`distanceBasis: "STRAIGHT_LINE_ESTIMATE"`, key `DISPATCH.STRAIGHT_LINE_ESTIMATE`), never travel time (§28.3).
  - WORKLOAD 0..30: ACTIVE assignments (employee rows, not team expansion) on jobs in ASSIGNED, SCHEDULED, RESCHEDULED, EN_ROUTE, ARRIVED, IN_PROGRESS, ON_HOLD: 30 with none, minus 6 per open job, 0 from 5 up (`HEAVY_WORKLOAD` conflict).
  - EXPERIENCE 0..20: number of DISTINCT jobs of the SAME job type the employee was assigned that are COMPLETED / AWAITING_REVIEW / CLOSED: 2 points each, capped at 10 jobs. A count of exposure, not a quality score.
  - PREFERENCE -30..+10: customer's list (`CustomerPreferredEmployee`): PREFERRED +10, AVOID -30 (`CUSTOMER_AVOIDS_EMPLOYEE` conflict). Asymmetric on purpose: a preference may tip a close call but must not beat a 30 km detour; avoidance should usually drop someone a place or two without hiding them (the dispatcher decides, and the conflict is displayed).
  - Ties: score, then nearer distance (unknown last), then employee id: same input, same ranking.
- **Why these numbers.** A transparent starting point (distance matters most for a field business, workload next, familiarity third, preference smallest and signed). Tenant-configurable weights are deliberately not built: they would be a second way to bias access to work and need their own review; the constants live in one file with a unit test per rule.
- **Conflicts are warnings, never blocks** (§25.2 "display the conflict"): avoided by customer, heavy workload, distance unknown, far from job (>= 50 km).
- **Stored shape** (`DispatchRecommendation.candidates`, ids and codes only, per the ERD contract): `[{ employeeId, rank, score, factors: [{ key, value, contribution, maxContribution, explanationKey, explanationParams }], conflicts: [{ code, messageKey }] }]`. `blockingReasons` (`{ employeeId: [{ code, params }] }`, codes `QUALIFICATION.FAILURE.*`) is stored ONLY on the "no eligible technician" path (nobody passed): then `candidates` is `[]`, the job stays PENDING_ASSIGNMENT, the recommendation stays PENDING and cannot be approved (`409`). When somebody is eligible the full blocked list is available live from `GET /dispatch/jobs/{id}/candidates` instead of being frozen into every row (it can list the whole workforce). Names are never stored or returned; clients resolve ids through the employees API (which re-checks visibility).
- **Modes** (`OperationsSettings.dispatchMode`, default AI_ASSISTED). MANUAL and AI_ASSISTED run. RULE_BASED_AUTO and OPTIMIZATION are valid enum values but `PUT /dispatch/settings` answers `400` (field `mode`, code `NOT_AVAILABLE`), and generation refuses a stored unsupported mode with `409` rather than falling back silently. MANUAL: generation is `409`; the eligibility overview (`/candidates`) still works so a person can assign by hand with the hard filter visible. Changing the mode needs a tenant-wide `dispatch.manage` (the Dispatcher template is unit-scoped, so a dispatcher cannot change it); reading it needs `dispatch.view` at any scope because the mode is not sensitive and every dispatcher screen depends on it.
- **Permissions**: generate `dispatch.create`, read `dispatch.view`, approve / modify / reject `dispatch.assign`, each checked over the job's service area (out of scope = `404`). Accepting also needs what `assignJob` needs (`jobs.assign`), and an override of an ineligible choice needs `jobs.approve` (Task 6 decision: the Dispatcher template does not hold it; Owner/COO do).
- **Approve / modify are ATOMIC (fix round 1).** One transaction: lock the job (the same row lock `assignJob` uses), re-read the recommendation under it and require PENDING (the claim: a concurrent approve / modify / reject finds it decided; no DECIDING enum value is needed because the job lock serialises every decision on a job), then a staleness check (any assignment of the job created or ended after `generatedAt` is `409` with detail code `STALE_RECOMMENDATION`: generate a new one), then jobs' `assignJobInTx` (hard eligibility, override rights, employee scope, notifications; stamps `recommendationId` and method RECOMMENDATION_APPROVED / _MODIFIED, an OVERRIDE keeps OVERRIDE), then the recommendation is stamped and audited. A failure rolls everything back. The crash-window resume logic and `linkAssignmentToRecommendation` are gone. A manual assignment (`assignJobInTx` without provenance) supersedes every pending recommendation of the job, so approving it afterwards is `409 INVALID_STATE_TRANSITION`.
- **Employee scope (fix round 1).** Candidate lists (eligible AND blocked), blocking reasons and every id in a stored recommendation are limited to employees the caller may see (`employees.view`, any field set), because failures carry HR facts. Out-of-scope relevant people are only COUNTED (`outOfScopeCount`: "N employees outside your scope were not evaluated for you"). Reads re-check the viewer's scope per employee id and drop what they may not see (`hiddenCandidateCount`). Approving needs the top candidate to be visible to the approver; modifying to an out-of-scope employee is `404` (jobs' `assignJob` now applies the same rule to every assignment target: manager ruling, unknown and out-of-scope are indistinguishable).
- **Pool selection (fix round 1)** replaces the old 500-employee cut. SQL pre-filter: non-terminated, in the caller's scope, not already on the job, AND (a service territory covering the job's area OR a permission for the job type / category). Those are the two rules every eligible employee satisfies, so nobody eligible is lost; employees matching neither are not candidates and not listed. The pool is judged in pages of 500 up to `MAX_EVALUATED` = 5000; if people remain, `poolTruncated` is returned and stored and the "no eligible technician" path (blocking reasons) is never taken on a truncated pass.
- **Stored shape (changed in fix round 1)**: `candidates` is an envelope `{ scoringVersion, evaluatedCount, outOfScopeCount, poolTruncated, ranked: [...] }` (the schema comment still says "ranked candidates"; the column is JSON, no migration). `scoringVersion` (now 1) is bumped whenever a weight or rule changes.
- **Experience** counts, for a job that changed hands, only the last assignee; someone reassigned away from it gets no credit.
- **Modify** may choose any employee (another candidate, or outside the list), requires a reason, refuses the top candidate (that is an approval), and records `chosenRank` (null when outside the list) and `overrideUsed` in the audit. **Reject** requires a reason and leaves the job pending. **Supersede**: generating again marks the job's other PENDING recommendations SUPERSEDED under an advisory lock, so only one can be decided; deciding a superseded or already decided one is `409 INVALID_STATE_TRANSITION`.
- **Audit actions**: `dispatch.recommend`, `dispatch.recommendation_approve`, `dispatch.recommendation_modify`, `dispatch.recommendation_reject`, `dispatch.mode_update`. Generation writes no job event (it changes nothing on the job); decisions leave the jobs module's `job.assigned` / `dispatch.override` events.
- **Not built**: automatic assignment and optimization modes, tenant-tunable weights, travel-time providers (no provider is configured; distances are straight-line only), team-level recommendations (employees only), workload by hours (count of open jobs only), a dispatch board / UI (Tasks 8-9), an estimated arrival time and explicit skill-match / availability fields per candidate (§7.4: today eligibility is a yes/no and the failures; the soft factors carry no ETA because there is no travel-time provider).
