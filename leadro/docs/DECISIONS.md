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
