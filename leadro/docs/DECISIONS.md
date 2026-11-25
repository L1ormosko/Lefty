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
  event type, so a template key can never disagree with the event; new events are one row plus six catalog keys. `job.cancelled`
  and `account.security_alert` are critical (the Phase 2 events `lead.follow_up_due`, `qualification.expiring` and `qualification.expired` were removed in the final fix wave: nothing ever raised them) (mandatory operational/security notices, §14.1).
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
- **Notifications**: `lead.assigned` to the new owner (not when assigning to oneself) and `lead.needs_owner` to Lead Operations of the unit on intake (`resolveLeadOperationsRecipients`, creator excluded), both via `notifyInTx` in the business transaction, `deliverAfterCommit` after it. No new event types were needed. The "lead" target resolver (`leads.view`) is registered when the module loads and from the new `src/instrumentation.ts` (`register()` is the one place for such startup registrations; the jobs module adds its own line there; the file is Node-runtime only). `lead.follow_up_due` existed in the catalog but no sweep raised it (REMOVED in the final fix wave, together with `qualification.expiring|expired`): follow-up due dates are stored and queryable (`followUpDue=true`), the scheduled job that notifies belongs with the Phase 2 workers.
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

- **Fix round 2.** (1) `outOfScopeCount` = relevant employees minus relevant employees in scope (a tenant-wide scope is the empty filter, so the old `NOT: visible` counted everybody); tenant-wide callers get 0. `notRelevantCount` (visible employees with neither a territory nor a permission) is returned and stored so an empty result explains itself. (2) Generation takes the JOB lock first (the order every job-changing path uses) and reads `clock_timestamp()` from the database for `generatedAt`. Staleness no longer compares clocks: the envelope stores `assignmentSnapshot` (all assignment ids of the job, and which were ACTIVE) read under the lock, and a decision is stale when a row exists that was not in it or a formerly ACTIVE row is no longer active (older rows without a snapshot fall back to timestamps). Application and database clocks can differ, ids cannot. (3) Reads tolerate the pre-envelope bare array, hide `chosenEmployeeId` from viewers who may not see that employee, and approve on a truncated empty pass answers `409` detail `EVALUATION_INCOMPLETE`. Assigning a team through jobs requires every current member to be in the caller's employee scope (otherwise `404`): handing work to a team hands it to all members, and a LEGAL_ENTITY-scoped caller can otherwise reach foreign-entity members through a team.
## Phase 3 Task 1: schema, permission catalog, role templates, seeds

Code: `prisma/migrations/20261123100000_phase3_field_operations`, `src/server/authz/{permission-catalog,role-templates,field-maps}.ts`, `prisma/seed/{field-specs,seed-field-operations}.ts`; reference `docs/ERD.md` "Phase 3", `docs/PERMISSIONS.md`. No new dependency. The migration is generated by `prisma migrate diff` plus a hand-written part (RLS DO-block, partial unique indexes, triggers, CHECKs), applied cleanly on top of the Phase 2 migrations and verified drift-free (`migrate diff` against the migrated database is empty).

- **One shared location table, coordinates nowhere else.** Raw latitude/longitude exist only on `LocationEvent`; `ArrivalVerification` and `LeadRecoveryCase` store distance, accuracy, ids and status. That keeps the sensitive field set to one table and lets the retention job purge coordinates without breaking verification or recovery history. Coordinates are the opt-in `location.coordinate_fields` set (`coordinates` tag, `LOCATION_EVENT_FIELD_MAP`); `location.view` and `location.approve` are `sensitive` permissions. Only the Owner template names the set. Retention is a tenant setting (`locationRetentionDays`, default 90); no scheduler exists, so the purge is a function for a later task (documented in ERD).
- **Location permission shape** (reviewable guess): `location.view` (read events and verifications, no coordinates), `location.create` (technician records own events), `location.approve` (manager verifies or overrides an arrival exception, spec 8.4). Managers and the COO get view + approve without coordinates; Lead Operations gets none (presence arrives as a derived status in the recovery case, spec 26.5); Dispatcher none. If product wants dispatchers to see arrival confidence, grant `location.view` to a custom role.
- **Other modules**: `shifts` (view/create/edit/approve), `job_outcomes` (view/create/edit/configure; configure = lost reasons), `completion_forms` (view/configure), `recovery` (view/create/edit/assign/approve/manage), `follow_ups` (view/create/edit/assign). `recovery.manage` authors and dry-runs rules (Lead Ops holds it); `recovery.approve` activates a high-impact rule (COO/Owner only), mirrored in the database by `recovery_rule_high_impact_approval` (author cannot be the approver). Outcome amounts are base fields of `job_outcomes` (no new financial field set): the technician must write them and Lead Ops must read the opportunity value; a Task 5 projection may narrow this later.
- **`RecoveryRule.status` replaces an `active` flag** (DRAFT, PENDING_APPROVAL, ACTIVE, INACTIVE, SUPERSEDED) so "active" cannot drift from the approval state; `activatedAt`/`approvedBy` are checked against it. One ACTIVE version per `ruleKey` (partial unique index). The seeded example rule is INACTIVE and high impact.
- **Money and the confirmed/estimate split** (spec 9.7): cases have `estimatedValueMinor` apart from `recoveredAmountMinor` / `collectedAmountMinor`; a CHECK forbids confirmed amounts, `recoveredJobId` or `recoveredById` without `recoveredAt`. Recovered work is a real FK to a job of the SAME customer (composite `(recoveredJobId, customerId, tenantId)`), which required a new unique `Job (id, customerId, tenantId)`.
- **Visits**: `JobOutcome` and `JobCompletion` are unique per `(job, visitNumber)` so a job sent back for a return visit (REQUIRES_RETURN_VISIT -> SCHEDULED) can be reported again without replacing history. The services decide how `visitNumber` increments.
- **Idempotency**: `FieldEvent (tenantId, employeeId, clientEventId)` is the offline gate (rejected events are stored so a replay answers identically; `clientEventId` must be a UUID, CHECK). Domain rows that can also be created online carry their own `clientEventId` unique per `(tenantId, jobId, clientEventId)`, the same pattern as `JobEvent`. Free text (notes, outcome notes) lives in domain tables; `FieldEvent.payload` and every Phase 3 JSON column hold ids/codes/numbers only, with the single documented exception `JobCompletion.values` (answers keyed by form field).
- **Completion forms**: one definition per job type XOR per category (spec 8.6 "by job category"; a type-level form wins). The Phase 2 `JobType.completionFormSchema` column stays (no destructive change) but is superseded and unread. Published definitions are immutable (trigger) so a submitted `(definition, version)` pair can never change meaning. Seeds create one ACTIVE v1 form per job type whose fields vary by category (installation: signature, photos, materials required; inspection: notes + follow-up required, no payment fields). Field keys are a closed vocabulary from spec 8.6; labels are i18n keys (`COMPLETION_FORM.FIELD.*`, to be added with the UI).
- **Attachments**: metadata only with `PENDING_UPLOAD`; `STORED` needs `storageKey` and `storageProvider` (CHECK), so no fake storage can be recorded.
- **Follow-up targets**: typed nullable FK columns + `targetType` + a shape CHECK rather than an unconstrained `(type, id)` pair, so every target is a tenant-safe composite FK. Assignee is an `Employee` (like leads and jobs); notification recipients are resolved through the employee's user. `dedupeKey`, `dueSoonNotifiedAt` and `overdueNotifiedAt` exist for idempotent rule-created tasks and the once-only sweep.
- **Settings added to `OperationsSettings`**: geofence radius (150 m), maximum usable accuracy (100 m), presence max age (30 min), location retention (90 days), follow-up due-soon lead time (60 min); `CustomerAddress.geofenceRadiusM` overrides the radius per site. `Job.enRouteAt` / `arrivedAt` are denormalized milestones next to `startedAt`.
- **Integer accuracy**: `accuracyM`, `distanceToJobM`, `geofenceRadiusM` are whole meters (rounded up by the writer); sub-meter precision is meaningless for device GPS.
- **Shared test database**: the permission catalog test counts rows of the global `Permission` table, so running this task's tests against the shared `leadro_test` would add Phase 3 permission rows and break sibling worktrees still on the Phase 2 catalog. This task was verified on a private `*_test` database instead; the merged tree uses the normal one.
- **Not built (other tasks)**: all services, routes, notifications and i18n keys; the retention job; the geofence/presence evaluators; the `JobStatus` transitions for ARRIVED/IN_PROGRESS via the lifecycle module (Task 3).

### Phase 3 Task 1, fix round 1 (migration edited in place; never applied to a shared database)

- **Retention purge is possible**: one strategy, null the coordinates and keep the row (`LocationEvent.coordinatesPurgedAt`). Deleting is impossible by design (RESTRICT FKs from shifts, arrivals, recovery cases) and the derived fields are what those modules need. Both position CHECKs accept a purged row; a purged row cannot carry coordinates. Tested against an event referenced by a shift, an arrival and a case.
- **Rule approval is bound to content**: trigger `recovery_rule_guard` makes `conditions`, `actions`, `trigger`, `priority`, `orgUnitId`, `highImpact`, identity and author immutable once the rule leaves DRAFT, and status forward-only. A high-impact rule must have an author (CHECK) so SoD is decidable; the service derives `highImpact` from the actions. The seeded example rule is authored by the Owner (else the first user).
- **`shifts.approve` has storage**: `Shift.exceptionReviewStatus/reviewedById/reviewedAt/reviewNote` with `shift_exception_review`.
- **Rule runs** (`RecoveryRuleRun`, append-only, unique per rule and outcome) carry cooldown, loop safety and explainability; the case's `(ruleId, ruleVersion)` is now a real composite FK to the rule version.
- **Tighter composite FKs** (same employee / same job): shift events, arrival evidence, presence evidence, completion signature, material completion; `ArrivalVerification.fieldEventId` is a real FK. Presence UNKNOWN requires a reason and no evidence event.
- **`Job.currentVisitNumber`** (default 1) is the visit number new outcomes/completions use; the jobs lifecycle increments it when a job whose current visit has an outcome is sent back to SCHEDULED (REQUIRES_RETURN_VISIT, RESCHEDULED, CUSTOMER_UNAVAILABLE). Not enforced by the database (the jobs module is outside Task 1).
- **`FieldEvent.payloadHash`** (sha256 hex) detects a replay with different content (CONFLICT). **`PaymentStatus.REFUSED`** added. **`LeadRecoveryCase.recoveredLeadId`** (same-customer composite FK) added.
- **Coordinates never in JSON** is a documented rule plus a service-level validator obligation (Tasks 2/4), not a CHECK.
- **Shared-DB story**: the Permission table is global, so `permission-catalog.test.ts` now asserts catalog keys are a SUBSET of stored keys (no exact count), safe when worktrees on different catalogs share `leadro_test`. The migration was verified only on private `*_test` databases (dropped afterwards); after merge, `tests/global-setup.ts` applies it to the shared test database like any migration, and the RLS table-set test (17 Phase 3 tables) will then match everyone's schema. Until merge, a sibling worktree running against a shared DB that already holds this migration would see extra tables it ignores; none of them has done so.

## Phase 3 Task 7: follow-up tasks

Code: `src/server/follow-ups/**`, `src/lib/follow-up-lifecycle.ts`, `src/app/api/v1/follow-ups/**`, events `follow_up.*` in `notifications/events.ts`, catalog keys `FOLLOW_UP.*` and `NOTIFICATION.FOLLOW_UP_*`. No schema change, no new dependency.

- **Two access gates.** A follow-up is readable / writable only if BOTH `follow_ups.<action>` covers the task AND the caller may view the target (`leads.view`, `customers.view`, `jobs.view`, `recovery.view`) through the target module's own rules (`resolveLeadListAccess`, `resolveCustomerListAccess`, `leadResourceRef`, `customerResourceRef`, `jobResourceRef`, `jobScopeColumns` from the module indexes). Lists are ONE query: the task scope fragment AND an OR of per-type relation filters (`lead: { is: <lead coverage> }`, ...), so pagination stays exact (no post-filtering). Consequence: a Dispatcher whose `follow_ups` scope covers a state still sees nothing about a lead that has not reached dispatch; Lead Operations (jobs only through the `recovery_related` set, which `jobResourceRef` does not model) follow up recovery cases and leads, not arbitrary jobs. Denials are 404.
- **Task scope.** `orgUnitId` is a snapshot of the target's service area at creation (the schema has the column; later moves of the target do not move old tasks, the target gate still follows the target's current scope). `ASSIGNED` = assignee, `OWN` = creator (via `createdBy.employee`). A task about a unit-less target is tenant-level. A Technician (OWN + ASSIGNED) therefore sees what they created and what was given to them, only while they can still view the target.
- **"Assignee within the creator's employee scope"** is implemented as `follow_ups.assign` evaluated on `{ employeeId }` (the grant's unit scope must cover the employee's placement), not `employees.view`: managers and Lead Operations hold the first, not necessarily the second, and the permission that exists for exactly this decision is the right one. Assigning to yourself needs only the permission to hold the task. An out-of-scope employee is answered like a missing one (400 "Employee not found" on `assigneeId`), so the field is not a directory oracle. The assignee must also pass both gates themselves, otherwise the task would sit in a queue they cannot open (400).
- **Recovery cases.** The recovery module does not exist in this task's tree. `targets.ts` ships a default access rule for `RECOVERY_CASE` (`recovery.view`; ORG_UNIT / LEGAL_ENTITY on the case's `orgUnitId`, ASSIGNED / OWN on `assignedToId`) and `registerFollowUpTargetAccess` lets the recovery module replace it. **Integration**: after merging Task 6, either keep the default (it matches the stated recovery scope) or register the module's own rules; no other wiring is needed. `createFollowUpTaskInTx` is the entry point for the recovery engine and job outcomes (`origin: RECOVERY_RULE | OUTCOME`, `dedupeKey` for idempotency).
- **Status machine** (`src/lib/follow-up-lifecycle.ts`): OPEN <-> IN_PROGRESS, either -> DONE | CANCELLED (reason), DONE / CANCELLED -> OPEN (reopen). Every transition takes the row lock and re-reads. Reopening clears completion / cancellation columns (the CHECK `follow_up_task_state` requires it) and the sweep stamps. No StatusHistory table exists for follow-ups (the schema has none): the audit trail (`follow_up.status_change`, previous and new status, who, when) is the history. Not tenant-configurable: every edge is core.
- **Offline.** Create, status, complete and cancel accept `clientEventId` + `occurredAt` and go through `offline.ts` (`runFieldWrite`): `FieldEvent` unique per (tenant, employee, clientEventId), `payloadHash` over the canonical content (the CLIENT-supplied `occurredAt` only: a missing one is "now" and must not change the hash between retries), ACCEPTED committed in the same transaction as the write, REJECTED stored for business refusals (validation / conflict / invalid transition) so a replay answers identically, permission failures not stored (retryable after a fix), different content under the same id = 409. A replay returns the task's CURRENT state (re-checked for access), not a stored snapshot. Concurrent twins converge: the loser of the unique index retries into the replay path, and a twin's committed verdict wins over a late rejection. This helper is local to follow-ups; the shifts / outcomes tasks have their own field-event handling, and consolidating is a manager decision. Update and assign are not field actions and take no offline fields.
- **Sweep** (`sweep.ts`): no scheduler exists, so `sweepFollowUps(tenantId, now?)` / `sweepAllFollowUps()` are plain functions. Claim-then-notify: `UPDATE ... WHERE stamp IS NULL` flips `dueSoonNotifiedAt` / `overdueNotifiedAt` atomically (concurrent sweeps cannot double-send), overdue is processed first so a task never gets both, the notification is also idempotent per task and due time. Window = `OperationsSettings.followUpDueSoonMinutes` (default 60). Tasks without an assignee are NOT stamped (nobody to tell) and are picked up by the first sweep after assignment; they are listed by `unassigned=true&overdue=true`. An assignee who lost access to the target is stamped but not notified (no retry loop). Due-date edits and reopening clear the stamps. At most 200 tasks per kind and tenant per run.
- **Notifications.** `follow_up.assigned | due_soon | overdue` link to the task (`targetType: "follow_up"`, `follow_ups.view`); no params (a title is free text and params are ids only). The resolver (`registerFollowUpNotificationTarget`) also requires the recipient to view the TARGET, so a notification about a lead the recipient lost is redacted. It is registered at module load and in `src/server/notification-targets.ts`; a test loads only the notifications route to prove it.
- **Audit** never contains the title, description, note or reason (`hasNote` / `hasReason`, `[text]` for edited text), the same rule as lead interactions.
- **Not built**: a "my follow-ups" shortcut route (use `assigneeEmployeeId=me&status=open`), bulk operations, recurring tasks, comments on tasks, a push of the sweep through an HTTP endpoint, tenant-configurable due-soon windows per priority, and UI.
## Phase 3 Task 2: shifts and location events

Code: `src/server/shifts`, `src/server/location`, `src/lib/{location-rules,shift-rules}.ts`, `src/app/api/v1/{shifts,location-events}/**`; reference `docs/API_REFERENCE.md` "Shifts" and "Location events". No schema change, no new dependency.

- **Module split.** `location` owns every write of `LocationEvent` (`recordLocationEventInTx`), the offline gate (`runFieldEvent`), presence (`latestValidLocation`) and retention; `shifts` calls it. Later tasks (arrival, recovery, field execution) import the same functions from `@/server/location`. `runFieldEvent` lives in `location` because it was needed first there; if a neutral `field-events` module is wanted later it is a pure move (one file).
- **Offline gate.** `FieldEvent` is claimed with `INSERT ... ON CONFLICT DO NOTHING` (`createMany skipDuplicates`), so concurrent copies serialise on the unique index. Same id + same `payloadHash` replays the original answer (the entity is re-read, so a replayed start shows the shift's CURRENT state); same id + different hash is `409` with detail code `CLIENT_EVENT_ID_REUSED` and is not stored; a business refusal (validation / state / conflict) of a new event is stored `REJECTED` (in a second transaction, the first rolled back with the work) and a replay is refused with the same class of error. Permission denials and unexpected errors are not stored (a retry may succeed). The hash covers what the device sent (a defaulted `occurredAt` is excluded so a retry without it still matches) and hashes coordinates one way.
- **`occurredAt` limits**: at most 5 minutes in the future (clock drift) and 7 days in the past; older offline events need a person (`MAX_CLOCK_SKEW_MS`, `MAX_EVENT_AGE_MS`).
- **Shift start/end contract.** A boundary needs a device position (accuracy mandatory) or an exception with a reason; a blank one is `400`. An exception, or a position vaguer than `locationMaxAccuracyM`, sets `exceptionReviewStatus = PENDING` (server raises `POOR_SIGNAL` for the vague one; the position is still stored, but never counts as evidence). A clean end keeps an earlier review decision; a new exception at the end reopens it. Reviewing (`shifts.approve`) is once, with a note, never on one's own shift, and does not alter the shift's times.
- **Start** is idempotent through the one-active-shift index plus a row lock on the employee (`SELECT ... FOR UPDATE`): a running shift is returned `200`. It is refused (`409`) for a non-ACTIVE employee and when `startedAt` precedes the previous shift's end. **End** by id is idempotent (an ended shift is returned unchanged); `POST /shifts/end` without an id ends the caller's current shift and, for 5 minutes after it ended, returns it again (a retry after a lost response); later it is `409`. Ending does not look at open jobs (job state belongs to the jobs module).
- **Manager correction** is `POST /shifts/{id}/end` by someone else with `shifts.edit` over the shift: `reason` mandatory (DB CHECK `shift_end_by_other_needs_reason`), no position or exception accepted (it is not the device's report), audited as `shift.end_by_manager`, location event source `MANAGER`. No other shift fields are editable in this task.
- **Scope.** ORG_UNIT scope follows the placement snapshot (`Shift.orgUnitId`, and `LocationEvent.orgUnitId` likewise), LEGAL_ENTITY the employee's legal employer, OWN the technician. ASSIGNED has no meaning for shifts or events. Projection is per row; shift fields are all `base`.
- **Location reads are sensitive.** `location.view` gives time, kind, source, accuracy, distance, verdict; `latitude` / `longitude` need the `coordinates` set, so only the Owner template sees them; managers never do. A technician holds only `location.create` (no history). Rows seen only through a coordinates-only grant are dropped (a filter must not be an oracle for hidden columns).
- **Technician posting** (`POST /location-events`) accepts only `DEPARTURE` and `NAVIGATION_OPENED` for a job ASSIGNED to the caller, about the caller; shift kinds use the shift endpoints, `ARRIVAL` / `VERIFICATION` belong to arrival verification (Task 3, through `recordLocationEventInTx`). Navigation opened may carry neither position nor reason; a departure needs one. This task never changes a job status; extending the jobs lifecycle for technician transitions is Task 3's (arrival) and Task 4's (start / complete) work.
- **No coordinates elsewhere.** Audit values hold ids, codes and accuracy only; `FieldEvent.payload` is `{ kind, jobId }` and `runFieldEvent` throws on a payload with a coordinate-looking key (`findCoordinateKey`). `recordLocationEventInTx` and `latestValidLocation` are internal: the first returns no coordinates, the second returns them for server-side distance / presence logic only.
- **Retention.** `purgeExpiredCoordinates(tenantId)` nulls coordinates older than `locationRetentionDays` (default 90 without a settings row) and stamps `coordinatesPurgedAt`; idempotent; audited as a system event with counts only. No scheduler (a Phase 8 hardening item).
- **Accuracy** is stored rounded UP to whole meters (never better than reported); coordinates rounded to 6 decimals (the column's precision).
- **Notifications not built.** A "shift exception awaiting review" notification would need a new notification event type in the shared `notifications/events.ts` and a target resolver; with parallel tasks editing those files it is left for the integration step. Managers have the review queue (`GET /shifts?exceptionReview=PENDING`).
- **Follow-ups for the manager.** (1) After merge, `registerNotificationTargets` needs nothing from this task. (2) Task 3 / 6 should call `latestValidLocation` with the tenant's `loadLocationSettings` values. (3) The sync endpoint (batch, per-event results) can call `startShift` / `endShift` / `recordLocationEvent` with each event's `clientEventId`; `FieldEvent.batchId` is supported by `runFieldEvent` but not yet exposed.

### Phase 3 Task 2, fix round 1

- **Presence uses both clocks**: `latestValidLocation` requires `serverTime` AND (when present) `deviceTime` inside `presenceMaxAgeMinutes`; an old offline fix synced now is not "here now" (§26.5). `isFreshEnough` was dropped.
- **Manual events keep the device time**: for an event without a position, `occurredAt` is stored as `deviceTime`; `occurredAt` and a position's `deviceTime` must agree within 5 minutes (else 400).
- **Late boundaries are exceptions**: a shift start/end reported more than 15 minutes (`DELAYED_BOUNDARY_THRESHOLD_MS`, a future `OperationsSettings` field; no schema change now) after it happened gets `DELAYED` (review PENDING) unless the technician stated another reason or the position is vague (`POOR_SIGNAL`).
- Retry window of the id-less end counts from `endRecordedAt` (server time). Employee lock is `FOR NO KEY UPDATE`. ESLint forbids importing `latestValidLocation` / `recordLocationEventInTx` under `src/app/**` (extend the list for any new coordinate-returning internal). Audit values built by shifts/location pass through `withoutCoordinates`. A refusal that cannot be stored is logged.
## Phase 3 Task 5: job outcome reporting (§9.1, §9.2)

Code: `src/server/job-outcomes` (README), `src/lib/job-outcome-rules.ts`, additions in `src/server/jobs/{status,field-port}.ts`, routes `/api/v1/{job-outcomes,lost-reasons}`, `/api/v1/jobs/{id}/outcome(s)`. No schema change, no new dependency.

- **Status through the lifecycle, by direct edges only**: each outcome maps to one existing edge (SOLD / NOT_SOLD from IN_PROGRESS > COMPLETED; ADDITIONAL_APPROVAL_REQUIRED from IN_PROGRESS > REQUIRES_RETURN_VISIT; WORK_NOT_POSSIBLE from ARRIVED / IN_PROGRESS > FAILED; CUSTOMER_UNAVAILABLE and RESCHEDULE_REQUIRED from EN_ROUTE / ARRIVED > CUSTOMER_UNAVAILABLE / RESCHEDULED). The state machine is unchanged. Recording an outcome from ARRIVED does NOT auto-step through IN_PROGRESS: that would fabricate `startedAt`; the technician starts work first (the arrival/start task adds that action). NOT_SOLD is a finished visit (COMPLETED), not a failure. The technician does not use `transition`: `TECHNICIAN_TARGET_STATUSES` stays `["EN_ROUTE"]` and the outcome service applies the consequence through jobs' `changeJobStatus` after `job_outcomes.create` over the job. A tenant that disabled the needed optional edge gets a 409 and nothing is written.
- **Closing guard** lives in `changeJobStatus`, so every path (transition API, review approval, future modules) obeys it: CLOSED needs an outcome for `currentVisitNumber`. Existing Phase 2 lifecycle tests that closed jobs now store a SOLD outcome first (`tests/job-outcomes/fixtures.ts`). A job moved past its visit by hand has no outcome; see the retroactive rule in fix round 1 below (the first version of this text wrongly said only `create` holders could close such a job and that there was no way for managers to help).
- **Visit number**: see fix round 1 (it advances when the technician is on the way again).
- **Idempotency**: `recordJobOutcome` wraps `recordOutcomeInTx` with a `FieldEvent` (`job.outcome`) keyed per (tenant, employee, clientEventId) holding a sha256 payload hash (`hashIdempotentRequest` over the submission, Dates as ISO). Same hash = replay with the original outcome (`200`, `replayed: true`); different hash = 409 `field_event.payload_mismatch`. Callers without an employee (rare) have no FieldEvent; they are still idempotent through `JobOutcome (job, clientEventId)`. The sync task (Task 4) should call `recordOutcomeInTx` inside its own FieldEvent handling; this module's FieldEvent code is deliberately small and local so Task 4 can replace it with its shared gate.
- **Recovery hook**: both a job-event pair (`job.outcome_recorded`, `job.not_converted`; ids and enums only) and an in-process subscription `onJobOutcomeRecorded` that runs inside the recording transaction (a failing subscriber aborts the outcome, tested). "Not converted" = NOT_SOLD and WORK_NOT_POSSIBLE (the two outcomes that carry a lost reason). The registry sits on `globalThis` like the notification target registry (Next bundles instrumentation and routes separately).
- **Notification**: `job.not_converted` (target type `job_outcome`, permission `job_outcomes.view`, resolver = the job's resource reference, registered in `notification-targets.ts`) goes to holders of `job_outcomes.edit` over the job's unit, never the reporter; params carry the job number only. Nobody is told when the visit sold.
- **Money rules** (service-level, mirrored by the DB CHECKs for the parts the DB can say): approved / charged / collected amounts and any payment only on SOLD; the quote may accompany any outcome (it is the recovery estimate base); PARTIAL / PAID need the collected amount and method. Currency defaults to the job's. Money is audited by field name only.
- **Corrections**: `PATCH /job-outcomes/{id}` (`job_outcomes.edit`) needs a `reason`, keeps the same cross-field rules, never changes the outcome type, audits changed field names and writes `job.outcome_corrected`. Lost reasons are retired with `active: false` (an outcome keeps pointing at a retired reason; a correction may keep it but may not newly choose one).
- **Permission shapes**: reading lost reasons needs `job_outcomes.view` (capability; technicians pick from them); writing needs a tenant-wide `job_outcomes.configure`. With no `create` capability a caller gets 403; an assigned-scope miss is 404. Outcomes have no sensitive field set (the amounts are what a visit outcome is), so the field map is all `base`. **SUPERSEDED (final fix wave):** outcome money (quoted / approved / charged / collected, currency, payment) is the opt-in `financial` field set; see `JOB_OUTCOME_FIELD_MAP` and `PERMISSIONS.md` section 4.4.
- **Not built here**: completion form validation (Task 3 owns `JobCompletion`), arrival / start actions, the recovery case itself (Task 6), UI. `Job.currentVisitNumber` is now part of the job API fields.

### Phase 3 Task 5, fix round 1

- **Retroactive outcomes (ruling a)**: a job in COMPLETED, FAILED, REQUIRES_RETURN_VISIT, AWAITING_REVIEW or CUSTOMER_UNAVAILABLE whose current visit has no outcome takes one with NO status change, from a `job_outcomes.create` OR `job_outcomes.edit` holder over the job (managers included). It is audited (`retroactive: true`, reason text) and evented (`retroactive` in `job.outcome_recorded` and in the domain event). Any outcome type is accepted there (the hand-made status says nothing reliable about what happened). A LIVE visit (a normal outcome edge exists) still needs `create`: edit-only callers get 403. The route gate is `job_outcomes.view`; the service decides create vs edit.
- **Visit number (ruling)**: one rule replaces the earlier source/target sets: the number advances when the job enters EN_ROUTE, ARRIVED or IN_PROGRESS from a status outside that group while the current visit already has an outcome, whatever path it took (hold, pool, reschedule). AWAITING_REVIEW > IN_PROGRESS (review rejected) is rework of the same visit and does not advance. Scheduling and assignment no longer advance it, so the ERD sentence "on return to SCHEDULED" is superseded; `ERD.md` is not edited here (Task 1 owns it).
- **Correction history without a table (ruling)**: `job_outcome.correct` audit rows hold the full previous and new values of every changed field (audit is `audit.view`-gated; the redactor only removes secrets, amounts pass). `getOutcomeCorrections` / `GET /job-outcomes/{id}/corrections` reads them for callers with `job_outcomes.edit` plus the financial set. Record-time audit still stores money by field name only.
- **Currency**: always the job's currency; a different one is 400 on record and correct; a correction cannot change it alone.
- **Financial field set (ruling)**: new category `job_outcomes.financial_fields` (tag `financial`), `JOB_OUTCOME_FIELD_MAP`. Granted to Owner (all), COO, State / Regional / City managers (`includeFields`), Technician (reports the money; scope ASSIGNED) and Finance Director (`fields: financial`, view). Not to Team Leader, Dispatcher, Lead Operations: they see outcome, reason, notes, follow-up request. Writes: sending or correcting financial fields without the set is 403; responses and lists project per row; filtered lists hide rows seen only through a financial-only grant. This widens "who names sensitive sets" beyond Owner/Finance; `tests/authz/role-templates.test.ts` now states the exception explicitly (job_outcomes only).
- **Idempotency details**: the payload hash covers the normalized record (defaults applied), so omitting a default and sending it explicitly are the same submission; the whole transaction is wrapped in `conflictOnUniqueViolation` (one clientEventId used on two jobs concurrently: loser gets 409, not 500); a replay re-checks the permission over the job; `occurredAt` may not predate the visit start (or the job's creation when work never started). Concurrent identical submissions are serialized by the job lock (tested).


## Phase 3 Task 4: field execution and offline sync

### Step 1: one offline gate (`src/server/field-events`)
- The gate that lived in `location/field-events.ts` moved unchanged into the neutral module `src/server/field-events` (`runFieldEvent`). Shifts and location import it from there; location no longer exports it.
- **job-outcomes** dropped its hand-rolled `FieldEvent` code: `recordJobOutcome` now calls `runFieldEvent` (type `job.outcome`). The hash is `hashFieldEventContent({type, jobId, submission})`, so one id on two jobs is a 409 as before. The published detail code `field_event.payload_mismatch` is kept through the new optional request field `reusedIdCode` (default `CLIENT_EVENT_ID_REUSED`). New side effect: a refused outcome (validation/state/conflict) is now stored REJECTED and replayed identically. **SUPERSEDED (final fix wave):** a refusal marked `retryable` (an earlier event has not arrived yet; decided by `canStillReach`) is NOT stored, so the same `clientEventId` can succeed later; only non-retryable verdicts are stored. See `field-events` README. Hashes stored by the old code would not match the new ones; nothing is deployed, so no data migration.
- **follow-ups** `offline.ts` is now a thin adapter (future-time rule, content hash, notification delivery) over `runFieldEvent`; behaviour and its tests are unchanged.
- The gate's "id reused for different content" conflict is recognised by instance (not by its detail code), so a custom code is never stored as a refusal.

### Step 2: field execution (notes, materials, attachments, completion forms)
Code: `src/server/field-execution/`, `src/lib/completion-form-rules.ts`, routes under `/api/v1/jobs/{id}/(notes|materials|attachments|completion)` and `/api/v1/completion-forms`.
- **Permissions reuse existing grants (no catalog change)**: writes = `jobs.edit` over the job (the Technician's execution grant is ASSIGNED-scoped; managers hold it by unit), reads = `jobs.view`, completion also needs `completion_forms.view`, definitions need tenant-wide `completion_forms.configure`. An amount on a note (additional-work estimate, approved amount) needs the `financial` set of `job_outcomes.view`, the same rule as outcome money, and is hidden from readers without it.
- **Field phase**: records may be added from EN_ROUTE until CLOSED/CANCELLED (including COMPLETED / AWAITING_REVIEW / hold / failed states, because offline events arrive late); earlier states are `409 job_field.not_in_field_state`.
- **Start work** is the existing transition endpoint: technicians may now move a job to IN_PROGRESS (`TECHNICIAN_TARGET_STATUSES` = EN_ROUTE, IN_PROGRESS; the graph still requires ARRIVED first). **SUPERSEDED (Task 3 / final fix wave):** `TECHNICIAN_TARGET_STATUSES` is EN_ROUTE only; arrival and start of work are the field events `POST /jobs/{id}/arrive` and `/start-work` (`TECHNICIAN_FIELD_EVENT_STEPS`), which also need `jobs.edit` with a writable `status`. Arrival stays Task 3's, completion goes through the outcome. **Pause** is not a technician action: the lifecycle has no resumable pause edge (ON_HOLD only leaves toward the pool) and adding one would change the core machine; not built.
- **Notes**: one table, four kinds (NOTE, WORK_PERFORMED, ADDITIONAL_WORK_REQUESTED, CUSTOMER_APPROVAL with an explicit `customerApproved`). Additional work and approval write a job event with ids only. No notification is sent (no recipient rule was specified).
- **Attachments**: metadata only (`PENDING_UPLOAD`), `StorageProvider` interface with a "not configured" default that throws `409 storage.not_configured`; `POST .../upload` asks the provider for a target. Confirming an upload (PENDING_UPLOAD -> STORED) is deliberately not built: nothing can produce a stored file yet.
- **Completion forms**: the form says which FACTS must exist (outcome and amounts = `JobOutcome`, materials = `JobMaterialUsage`, photos / signature = `JobAttachment`); only `notes` and `followUpRequired` are answers in `JobCompletion.values`. Required money / payment / materials / signature fields are enforced only for a SOLD visit (a "customer not home" visit could never satisfy them); outcome, photos, notes and the follow-up answer are always enforced. Photo METADATA counts (a FAILED one does not). Answers the form does not ask for are refused. One completion per `(job, visit)`; it links the visit's unattached material rows and does not move the job.
- **Definitions**: DRAFT -> publish (ACTIVE, previous ACTIVE retired in the same transaction) -> RETIRED; the version is the highest for the target + 1; published versions are immutable (DB trigger + service 409). A job resolves its form by job type, then by the type's category.
- **Label keys are UPPER_SNAKE** (`COMPLETION_FORM.FIELD.FINAL_CHARGED_AMOUNT`): `i18n:check` rejects camelCase, so the seed (`prisma/seed/field-specs.ts`) now derives them from the field key; catalogs carry `COMPLETION_FORM.FIELD.*` and `FIELD.*` in all three locales.

### Step 3: batch sync (`src/server/field-sync`, `POST /api/v1/field-sync`)
- **Registry**: `registerFieldSyncHandler(type, handler)`; one owner per type (a second registration throws). The module's own types are registered when `field-sync` is imported; arrival (Task 3) registers `job.arrival...` after merge without touching this module. A handler receives `{ actor, ctx, event }` and calls the owner's service with the REST body (the batch event's `clientEventId` / `occurredAt` override the payload), so offline and online share one path and one permission check.
- **Ordering and isolation**: sorted by `occurredAt`, stable by client order; each event runs sequentially in its own transaction(s); every failure becomes that event's result. The response is `200` for any well-formed batch; `index` maps results to what was sent, `sequence` is the order applied.
- **Statuses**: ACCEPTED, REPLAYED (a FieldEvent already ACCEPTED before the call), REJECTED (validation / state; remembered by the gate), CONFLICT, FORBIDDEN (403 and 404: not remembered, retryable, since a job may be assigned later), UNSUPPORTED (unknown type, not stored), FAILED (unexpected, logged, no internals sent).
- **batchId**: stamped on the event's `FieldEvent` row after the handler ran (also on a stored REJECTED row), only while empty, so a replayed event keeps its first batch and no module needed a batch parameter. The id is client-generated (8-100 of `A-Za-z0-9_-`).
- **Scope of built-in types**: `shift.end` ends the caller's own shift only (a manager's correction needs a reason and stays an HTTP action); arrival is not registered here (Task 3). **SUPERSEDED:** the built-ins now include `job.en_route`, `job.arrive`, `job.start_work` and the `follow_up.*` types (see `field-sync/README.md`). No endpoint-level permission: the owning service authorizes each event, and only an employee actor may sync.
- **Limits**: 100 events per batch (the 1 MB body limit also applies); events older than 7 days or beyond 5 minutes ahead are refused per event by the owning service.
## Phase 3 Task 3: arrival verification, start work, navigation events

- **Technician steps (ruling)**: ARRIVED and IN_PROGRESS are reached by technicians ONLY through `/jobs/{id}/arrive` and `/jobs/{id}/start-work` (`TECHNICIAN_FIELD_EVENT_STEPS` in `job-lifecycle.ts`); `TECHNICIAN_TARGET_STATUSES` for the plain transition stays `EN_ROUTE`, so a technician cannot skip the position check or the offline gate. Both edges are `core`. Dispatchers/managers keep moving jobs by `/transition` as before.
- **Pause / resume not offered**: the machine has no `ON_HOLD > IN_PROGRESS` edge, so a technician pause could not be undone. Adding one is a lifecycle decision for the manager.
- **Verdict (ruling)**: straight-line haversine from the device position to `CustomerAddress` lat/lng against `geofenceRadiusM ?? OperationsSettings.arrivalGeofenceRadiusM`. A position with accuracy above `locationMaxAccuracyM` never confirms (stored, UNVERIFIED, POOR_SIGNAL). The accuracy radius is not subtracted from the distance. Inside + accurate = RECORDED / `WITHIN_RADIUS_REPORTED`, never "verified".
- **Arrival never blocks the job**: every confirmed arrival moves the job to ARRIVED (a technician at the door must not be stuck behind bad GPS); doubt becomes `PENDING_MANAGER_REVIEW` + a notification (`job.arrival_unverified`, target = job) to `location.approve` holders over the job's unit. Rejecting an arrival keeps the job status (no way back from ARRIVED) and blocks that technician's `start-work`.
- **Methods**: `trigger: GEOFENCE` (device geofence event, needs a position) stores `source GEOFENCE` / `method GEOFENCE`; the technician button is `TECHNICIAN`. `MANAGER` method is unused for now (a manager only decides an existing arrival).
- **Override scope**: a manager may reject or verify an arrival in RECORDED or PENDING state, once, with a reason; not their own. VERIFIED adds a `VERIFICATION` location event (source MANAGER, no position).
- **Navigation opened**: `/jobs/{id}/navigation-opened` delegates to the location module's technician flow (assignment check, idempotency, no coordinates back).
- **Offline**: arrive and start-work use `runFieldEvent` (types `job.arrive`, `job.start_work`) via `own-field-write.ts`; Task 4's sync can wrap the same services.
- **Not done**: a cross-job manager queue of pending arrivals (`GET /arrivals?status=`); the per-job list exists.
- **Fix round 1 (arrival)**: (1) a fix confirms presence only when its accuracy circle fits inside the radius (accuracy <= radius and distance + accuracy <= radius); otherwise UNVERIFIED / POOR_ACCURACY for manager review (distance beyond the radius stays OUTSIDE_RADIUS). (2) The 5-minute clock tolerance only decides acceptance: stored `arrivedAt` / `startedAt` are `min(device time, now)`. (3) Lower bounds: `arrivedAt` is not before the moment the job went EN_ROUTE; `startedAt` is not before the latest arrival, else the moment the job became ARRIVED. (4) A start-work replay re-checks assignment and `jobs.edit` and answers with the job's CURRENT state (same as the outcome replay). (5) `runFieldEvent` no longer stores a refusal whose error is `retryable`; arrive / start-work mark their state-ordering refusals ("not EN_ROUTE yet", "not ARRIVED yet") retryable, so a device can resend the same `clientEventId` after the earlier event synced. Other stored refusals are unchanged.

## Phase 3 Task 6: Lead Recovery Engine (§9.3 - 9.7)

Code: `src/server/recovery` (README), `src/lib/recovery-rules.ts`, `src/lib/recovery-lifecycle.ts`, routes `/api/v1/lead-recovery/**`. No schema change.

- **Subscription and failure isolation**: the engine registers with `onJobOutcomeRecorded`, so it runs inside the outcome transaction (case, follow-up and
  notification rows commit or roll back with the outcome). It must never fail the outcome: the whole handler and every rule run in a SAVEPOINT; a failing
  rule rolls back to it, is logged and leaves a run row `skippedReason: "error"` (`matched: false`). A stored rule that no longer validates is skipped.
- **Registration**: importing `@/server/recovery` subscribes the engine; `notification-targets.ts` (called by `instrumentation.ts` at server start) also
  calls it, so a deployment where the outcome route loads before any recovery route is still subscribed.
- **Action vocabulary** (closed): the ERD listed four; a fifth, `set_priority`, is added because the brief names "priority" as its own action. No discount
  action exists, and a recursive scan refuses any key or value matching discount / coupon / rebate / markdown / promo (so a future field cannot sneak one in).
- **highImpact is derived**: notify, create_follow_up, a HIGH / URGENT `create_case` or an URGENT `set_priority`. `recommend` and a NORMAL / LOW case do not
  need a second person. SoD: `recovery.approve` and not the author (service + DB CHECK). A high-impact DRAFT must be submitted first; INACTIVE high-impact
  rules are re-approved the same way (the approver is re-stamped).
- **One case per outcome, many rules**: rules run in `priority` order. The first rule with `create_case` creates the case (and its rule / version, priority);
  later rules only annotate it (priority only ever goes up, the first recommendation stands, follow-ups dedupe on `recovery:<caseId>:<ruleId>`, notification
  idempotent per case and rule). A rule without `create_case` and without an existing case records `skippedReason: "no_case"`.
- **Cooldown** is per rule KEY (all versions) and customer, counted from runs that actually did something (not from skipped or non-matching runs).
- **Presence** (§26.5): `latestValidLocation` (both clocks, accuracy) + the job address coordinates, radius = the address override or the tenant's
  `arrivalGeofenceRadiusM`. UNKNOWN reasons: `no_location`, `stale_location`, `inaccurate_location`, `no_coordinates`. Stored as a snapshot; the evidence event id
  and the distance are stored (CHECK requires the evidence) but never returned. The technician is the outcome's employee.
- **Estimate vs confirmed**: the quote becomes the case's initial value AND its starting estimate; only `recoverCase` writes the confirmed amounts (with
  `recoveredAt`). `revenue` in the API keeps the groups apart; the summary never adds them.
- **Recovered work** must be a job / lead of the SAME customer and not the original job (service check plus composite FKs and a CHECK). Existence of such
  a job is checked within the customer only (no `jobs.view` on the new job is required, so Lead Ops can link work another unit scheduled).
- **Fields**: recovery has no sensitive field set in the permission catalog; all fields are `base` and visibility is by row scope. Money on a case is visible
  to anyone who may view the case.
- **Status machine** (`recovery-lifecycle.ts`): NEW -> ASSIGNED | CONTACTING | CLOSED; ASSIGNED -> NEW (unassign) | CONTACTING | CUSTOMER_REACHED |
  FOLLOW_UP_REQUIRED | NOT_RECOVERED | CLOSED; CONTACTING -> CUSTOMER_REACHED | FOLLOW_UP_REQUIRED | RECOVERED | NOT_RECOVERED | CLOSED; CUSTOMER_REACHED ->
  CONTACTING | FOLLOW_UP_REQUIRED | RECOVERED | NOT_RECOVERED; FOLLOW_UP_REQUIRED -> CONTACTING | CUSTOMER_REACHED | RECOVERED | NOT_RECOVERED | CLOSED;
  RECOVERED -> CLOSED; NOT_RECOVERED -> CONTACTING (reopen) | CLOSED; CLOSED final. ASSIGNED is reached only through assignment; RECOVERED only through
  `recover`. Closing or NOT_RECOVERED needs a reason (the final outcome, `closeReason`). The first attempt moves NEW / ASSIGNED to CONTACTING.
- **Notifications**: two new events in the shared registry, `recovery.case_created` (Lead Ops over the case's unit: `recovery.assign`, widening to
  `recovery.view`) and `recovery.case_assigned`, target `recovery_case` with a resolver. The engine cannot call `deliverAfterCommit` (it runs inside the
  outcome transaction); the rows are delivered by the pending sweep (`deliverPendingForAllTenants`).
- **`recovery_related`**: `loadJobAccessFacts` now also reports whether a job has a recovery case; `toJobResourceRef` puts `recovery_related` in `sets`, which
  is what the Lead Ops `jobs.view` grant matches. The ORG_UNIT scope still bounds it. List queries are not extended (Lead Ops reaches a job through its case);
  the set does not depend on the caller's case visibility (a case shares its job's unit, so the unit scope gives the same answer).
- **Number sequence**: `NumberSequenceName` gained `"recovery_case"` (`NumberSequence.name` is free text, no migration).
- **Offline**: case work is back-office; no `clientEventId` on recovery endpoints (technicians have no `recovery.*` grants). Creation endpoints accept the
  standard `Idempotency-Key` header.
- **i18n**: machine codes map to `RECOVERY.*` keys with the code UPPERCASED (`RECOVERY.PRESENCE.REASON.NO_LOCATION`), as the key format requires.
- **Not built**: UI, a scheduler for re-evaluating old outcomes, listing jobs by `recovery_related`.

### Phase 3 Task 6, fix round 1

- **Content-wise SoD**: the approver of a high-impact rule must not be its author, any editor of that version, or its submitter. Read from the audit trail
  (`recovery_rule.create | new_version | update | submit` on the rule id) plus `createdById`; no migration. Deactivating / rejecting is not restricted.
- **Money in dry runs**: case values stay visible to case viewers (§9.4 / §9.7; recorded as a product decision for the owner). A dry run is different: its
  `checks[].actual` for `minValueMinor` / `maxValueMinor` is `null` with `redacted: true` unless the caller holds the `financial` field set of
  `job_outcomes.view` over that job (Lead Ops do not). Whether the rule matched is still shown (a boundary can be probed with definitions; accepted).
- **Version rollback**: refused. A version cannot be activated while a newer non-draft version of the key exists (`409`); to go back, create a new version
  from the old content (`new-version` on the old row) and activate that.
- Summary: confirmed revenue is filtered by `recoveredAt` in the range, estimates by `outcomeAt`. `set_priority` is listed in `actionsTaken` only when it
  changed priority or score. Duplicate `ruleKey` (also under a race) is `409`.
### Task 4, fix round 1 (review)
- **Merged arrival (Task 3)**: `TECHNICIAN_TARGET_STATUSES` stays `["EN_ROUTE"]` (my IN_PROGRESS addition and its test change are reverted); ARRIVED / IN_PROGRESS are reached through `/arrive` and `/start-work`. Arrival's `own-field-write` now imports the neutral gate. Sync types `job.arrive` and `job.start_work` are registered by field-sync, calling arrival's services (one place).
- **What the gate remembers**: only verdicts on the CONTENT (schema, currency mismatch, invalid lost reason, a duplicate outcome for the visit, an event older than a week). Refusals caused by ORDER, STATE or CONFIGURATION are thrown with `retryable: true` and never stored: `job_field.not_in_field_state` (while the job is before the field phase; CLOSED / CANCELLED are stored), `job_outcome.not_reportable` (while the job can still advance), `job_outcome.occurred_too_early`, `completion.not_ready` (EN_ROUTE / ARRIVED), `completion.no_active_form`, `completion.form_invalid`, `completion.field_required` (the outcome or photos may not have synced yet), `completion.signature_unknown`, and a device time ahead of the server clock. Arrival retries only while the job can still reach the required status (arrive: ASSIGNED / SCHEDULED / RESCHEDULED; start work: EN_ROUTE). Sync reports these as `retryable: true`.
- **`job.en_route`**: `POST /jobs/{id}/transition` accepts `clientEventId` / `occurredAt` for `toStatus: EN_ROUTE` only (400 otherwise); it goes through the shared gate, stamps `statusChangedAt` and the status history with the device time (never later than now; `changeJobStatus` option `occurredAt`), and the sync type `job.en_route` calls the same service. Replay answers `replayed: true`.
- **Device-time window**: judged by the gate on first delivery only (after the claim found no row); a late replay of an accepted event still answers. Shifts, location, arrival and field execution skip their own pre-check when a `clientEventId` is present. Ahead of the clock = retryable, older than a week = stored.
- **Gate details**: the batch id comes from an async context (`withFieldEventBatch`) and labels only rows the gate creates; the sync result's REPLAYED comes from the service's `replayed` flag; `resultCode` stores `CODE:detail.code` so a stored refusal replays with the same detail code (existing codes without details are unchanged).
- **Sync statuses**: `NOT_FOUND` -> FORBIDDEN retryable (may be assigned later); `FORBIDDEN` is retryable only when the error says so (an amount without the financial set never is).
- **Completion facts are per visit**: photos, signature and loose materials count only when recorded since the job last went EN_ROUTE; a signature already used by a completion is refused. A form definition for a category needs a job type with that category.
- **`job.outcome` hash**: the gate's content hash for outcomes is now `hashFieldEventContent({type, jobId, submission})` instead of `hashIdempotentRequest({actorUserId, method, path, body})`. FieldEvent rows written by the earlier Phase 3 code would not match a replay; nothing is deployed, so there is no data migration.

## Phase 2+3 final fix wave (whole-branch review)

- **Record numbers are taken in the create transaction** (jobs, customers, leads), as `createJobFromLead` and the recovery engine already did. The earlier "separate short transaction" needed a second pooled connection per request and starved the pool under bursts (P2024); a rolled-back create now rolls its number back with it. `tests/customers/creation-burst.test.ts` creates 40 customers and 40 leads concurrently (more than the default pool).
- **One job list-access helper** (`resolveJobListAccess` in `jobs`): union of the plain grants and the `recovery_related` grant restricted to jobs with a recovery case, so a follow-up list agrees with the single-record check for Lead Operations. The jobs module's own list keeps ignoring `recovery_related` (Lead Ops reach a job through its case).
- **Presence refresh (ruling)**: allowed only within `presenceMaxAgeMinutes` after the case's `outcomeAt` and only from the technician's location events recorded for the case's job; otherwise the snapshot is `UNKNOWN` with reason `refresh_window_closed`. A manager can no longer poll a technician's whereabouts for as long as a case stays open.
- **Customer of a case without a lead** opens for Lead Operations. A role holds ONE grant per permission, so a second `customers.view {set: recovery_related}` grant was impossible; instead the existing `lead_related` set means "the customer has a lead OR a recovery case". Deviation from the brief's wording (a new set), same effect.
- **Outcome money for Lead Operations (ruling)**: the case value stays visible to every case viewer (the END decision for the owner); the rule dry-run keeps its redaction because it can target outcomes without a case. Four "quote" sensitivities are disclosed in `PERMISSIONS.md`.
- **Customer approval and completion (ruling)**: only an employee assigned to the job records a CUSTOMER_APPROVAL note or submits the completion form (`assertWorkedByCaller`); managers still add plain notes and read/correct through audited paths.
- **Arrival needs `jobs.edit`** with a writable `status`, like start-work.
- **`canStillReach(from, to, disabled)`** in `src/lib/job-lifecycle.ts` replaces the hand-written "may the missing earlier event still arrive" lists (arrive, start work, completion, outcome, field records). It is a reachability search over the machine, so a job in ON_HOLD, PENDING_ASSIGNMENT or CREATED now also counts as "can still arrive" (retryable, not stored), where the old lists named only ASSIGNED / SCHEDULED / RESCHEDULED.
- **Offline shells (M2, partial)**: the believable-device-time rule is now ONE function (`assertBelievableEventTime` in `field-events`) used by the gate, arrival, shifts, location and field records; a future time is retryable everywhere. The two job-scoped shells (`arrival/own-field-write.ts`, `field-execution/access.ts`) and the direct `runFieldEvent` use in job outcomes and the jobs transition were NOT merged into one wrapper: their entity and authorization steps differ and merging them was larger than a safe change. Known limitation, listed in the milestone report.
- **Single helpers**: `teamMembers` (customers), `holdsOutcomeFinancialSet` / `decisionHoldsFinancial` (job-outcomes), `caseResourceRefById` (recovery), finished recovery statuses derived from the status machine, field-note money through `JOB_FIELD_NOTE_FIELD_MAP`.
- **Follow-up target registry** lives on `globalThis`; the unregistered recovery-case default fails closed. **Field-sync** gained `follow_up.status | complete | cancel`. **Removed events**: `lead.follow_up_due`, `qualification.expiring`, `qualification.expired` (nothing raised them). **`job.create` audit** records money field names only.
- **mfa replay test** no longer straddles a 30-second TOTP step (pinned step, waits out the last seconds of one).

## Phase 4 Task 1: schema, money as BigInt, catalog, templates, seed

- **Two migrations.** `20261124100000_phase4_financial_core` (all Phase 4 tables, Int -> BigInt for the Phase 2/3 money columns, RLS,
  CHECKs, status machines, append-only and no-delete guards) was applied to the shared `leadro` and `leadro_test` databases before the
  gap check for Tasks 2-6 ran, so it is NOT edited in place. The gap went into `20261125100000_phase4_review_flags`:
  - `FinanceReviewFlag` (Task 5 "finance review flags", spec 11.7 "Flag for finance review"): no existing table fit. Reconciliation
    exceptions need a run, follow-up tasks are operational (customer work, operational roles see them). Permissions reuse
    `finance_reconciliation.*` (see PERMISSIONS.md section 11), so the catalog does not grow.
  - `ReconciliationException.refundId`, `.outcomeId` (Task 6 "refunds without payment" and "outcome/ledger mismatch" need a typed,
    tenant-safe reference rather than an id in `details`; CHECKs require them for those kinds) and `.orgUnitId` (scope filter, like every
    other finance table). Added to the frozen-column trigger.
- **Status history of finance records = the audit trail.** Payment, refund, chargeback, adjustment, approval request, cost version,
  exception and flag status changes write an audit event (previous and new status, actor, reason) in the same transaction; there are no
  `*StatusHistory` tables for them (same as qualifications and follow-ups). The DB status-machine triggers stop illegal moves.
- **BigInt fallout fixed in Phase 2/3 code**: `changedFields` compared values with `JSON.stringify`, so a job PATCH carrying a quote
  answered 500; the field-event content hash did the same, so recording an outcome through the offline gate or field-sync answered 500.
  Both now handle `bigint`; the hash writes bare digits, so events hashed before the migration (amounts were numbers) still replay.
  Phase 2/3 tests now expect decimal strings in API JSON and `bigint` from services (docs/API_CONVENTIONS.md "Money").
- **COO template**: maintains the material catalog without the `cost` field set and without `materials.approve` (the manager's WIP commit
  2ddef29 changed this from the first draft, which gave the COO full materials including costs). Spec 4.5 grants the COO "View" of
  financial reports and no cost data; costs and cost approvals stay with Owner and Finance Director. Cost if wrong: one template line.
- **Seed**: `seedFinanceData` (5 demo materials with an approved version-1 cost effective 2020-01-01, 6 default approval policies) runs per
  seeded tenant and is idempotent. Seeded costs are approved without a request: demonstration data, documented as such.
- **Payment provider configuration has no table.** There is no real provider (spec 28.3), so the intake's provider and secret resolution
  is code (a `PaymentProvider` registry, "not configured" by default). A real provider with per-tenant credentials will need a
  connection table (encrypted secret, like MFA secrets) in a later migration. Unknown tenant or provider = refused before any row is
  written (`PaymentIntakeEvent.tenantId` is required).
- **Not modelled** (no task needs it): "Other Direct Cost" (spec 11.1) and any discount record behind `HIGH_VALUE_DISCOUNT` (the subject is
  the job; Task 3 may leave that subject unregistered). Compensation, commission and payroll remain blocked on the owner's compensation
  specification (spec 28.4).

### Contracts for Phase 4 Tasks 2-6 (no further migration expected)

- **Money**: `bigint` minor units + `currency` everywhere; parse inputs with `moneyAmountSchema` / `signedMoneyAmountSchema`, sum with
  `sumMinor`, store JSON amounts as decimal strings (`serializeJson`); responses are serialized by `defineRoute`.
- **Task 2 (materials)**: cost lives only in `MaterialCostVersion` (`versionNumber` per material, PENDING_APPROVAL -> APPROVED | REJECTED |
  CANCELLED). Approving a version effective at D first closes the open approved version (`effectiveTo = D`, settable once), then sets
  APPROVED + `approvedAt` (+ `approvalRequestId` while still pending; frozen after approval); the GiST constraint refuses overlap. Costing a
  `JobMaterialUsage` sets `materialId`, `costVersionId`, `unitCostMinor`, `extendedCostMinor`, `costCurrency`, `costedAt` together, once
  (trigger freezes them and `quantity`); the derivation of `extendedCostMinor` from `Decimal(12,3)` quantity is Task 2's to decide and document.
  Costs are the `cost` field set of `materials.*`.
- **Task 3 (approvals)**: resolve the active policy by `subjectType` + `currency` + amount in `[minAmountMinor, maxAmountMinor)`; snapshot
  code, version, `requiredApprovals`, `approverPermission`, `expiresAt`, `excludedApproverIds` at creation (frozen); one PENDING per subject
  (partial unique index); decisions append-only, one per decider, SoD trigger; set `decidedAt` / `cancelledAt` + `cancelReason` with the
  status. Subject links: the subject row's `approvalRequestId` (chargeback: `writeOffApprovalRequestId`). Policies change by inserting
  `version + 1` and deactivating the old row (one active per code).
- **Task 4 (ledger, payments)**: every posting through one ledger service with a deterministic `idempotencyKey`; sign by type; `source` +
  its reference column; actor user XOR `system:<name>`; `orgUnitId` / `legalEntityId` copied from the job at posting. Corrections are
  REVERSAL entries (one per entry, same job/customer/currency, negated amount). Payments: PENDING -> RECEIVED | FAILED | VOIDED,
  RECEIVED -> VOIDED; MANUAL needs `recordedById`, PROVIDER needs `provider` + `providerRef` + `intakeEventId`. Intake writes
  `PaymentIntakeEvent` first (unique per tenant/provider/externalId, payload SHA-256 only), signature-invalid can only be REJECTED.
- **Task 5 (refunds, chargebacks, adjustments, flags)**: status machines as in the migration (refund REQUESTED -> PENDING_APPROVAL |
  APPROVED -> POSTED; chargeback OPEN -> DISPUTED -> WON | LOST -> WRITE_OFF_PENDING_APPROVAL -> WRITTEN_OFF; adjustment PENDING_APPROVAL
  -> APPROVED -> POSTED); core columns frozen; postings are REFUND / CHARGEBACK / ADJUSTMENT ledger entries; review flags via
  `FinanceReviewFlag` with a deterministic `idempotencyKey` per triggering event.
- **Task 6 (reconciliation)**: one `ReconciliationRun` per period / legal entity / currency (RUNNING -> COMPLETED | FAILED, totals on the
  run); exceptions carry the typed references above and `orgUnitId`; OPEN <-> ASSIGNED -> RESOLVED with `resolvedById` + reason.

## Phase 4 Task 3: approval engine

- **Registry contract** (`registerApprovalSubject(subjectType, { resolveResource, onApproved, onRejected })`, on `globalThis` like the other
  registries). `onRejected` covers every ending without approval (`outcome`: REJECTED, EXPIRED, CANCELLED), so a subject module writes one handler
  for "the change did not happen". Callbacks run inside the transaction that ends the request: the subject and the request never disagree, and a
  throwing callback rolls the decision back. A subject module that withdraws its own change calls `cancelApprovalForSubjectInTx` and is NOT called
  back (it is the caller). Subject modules (Tasks 2 and 5) register their type at module load and add the call to
  `src/server/notification-targets.ts`. `HIGH_VALUE_DISCOUNT` stays unregistered (no discount record exists, Task 1 note): requesting it is a 500
  (programming error), never a silent approval.
- **Requests are opened only by subject modules** (`createApprovalRequestInTx` inside their transaction; requester = `ctx.actor`, null ctx =
  system). There is no "create request" endpoint: the subject module checks its own permission (`finance_refunds.create`, ...) and decides the
  excluded approvers (editors / submitters). The engine validates that those ids are users of the tenant and merges duplicates; the requester is
  excluded by the trigger and is not repeated in the list.
- **Policy resolution**: amount given -> active policies of the subject type in that currency whose band `[min, max)` covers it; no amount
  (material cost change) -> any active policy of the subject type. Several matches (overlap is refused on write, so only a race or a manual edit)
  -> the strictest (most approvals, then highest lower bound, then id). **No policy, or an amount in a gap between bands, means no approval**
  (`{ required: false }`, the contract's `approvalRequestId = null`); a gap is how a tenant says "small refunds need nobody". But **a currency
  with no policy at all is refused** (`400`, field `currency`) when the subject type has policies in other currencies: approval is never skipped
  because nobody configured EUR. Cost if wrong: one branch in `resolvePolicy`.
- **Scope of a request** = the `orgUnitId` that the subject's `resolveResource` reports at creation (null = tenant-level). Every later check (queue
  SQL filter, get, decide, notifications) uses that snapshot, so the list and the single read always agree even if the subject moves later.
  LEGAL_ENTITY scopes match through the unit's legal entity; OWN / ASSIGNED reach no request (the requester rule covers "my own").
- **Visibility**: every endpoint needs `approvals.view` (capability). Requester, eligible approvers (the snapshotted `approverPermission` over the
  unit) and overseers (`approvals.manage` over the unit) see a request; nobody else (`404`). Deciding additionally needs the approver permission
  (`403` without any grant, `404` outside scope); `approvals.view` alone never decides. Cancelling: requester or overseer.
- **Amounts are hidden from manage-only viewers** (`moneyRedacted: true`, no `amountMinor` / `currency` / `details`): the COO template oversees
  approvals but holds neither the `cost` set nor finance approval permissions (Task 1 ruling); showing a cost-change amount through approvals would
  bypass that. Requester and eligible approvers see the amount.
- **Concurrency**: `SELECT ... FOR UPDATE` on the request row before reading decisions; the status change is additionally guarded by
  `updateMany(where status = PENDING)`. Two approvers of a dual request at the same moment both succeed and it is approved once; two deciders of a
  single request: one wins, the other gets `409 INVALID_STATE_TRANSITION`; the same person twice: one decision (`409 CONFLICT`).
- **Expiry** without a scheduler: a request past `expiresAt` is closed immediately for the queue (SQL filter) and for decide / cancel (the
  service expires it in its own transaction, then answers `409`); `expireDueApprovalRequests(ForAllTenants)` is the worker entry and expires each
  request in its own transaction (one failing subject handler cannot block the batch). Expiry is a SYSTEM audit event.
- **Rejection needs a comment** (`400`), it is the reason the requester and the subject receive. A cancel needs a reason (DB CHECK).
- **Audit actions**: `approval_request.create`, `.decide` (each decision; outcome `DENIED` for a separation-of-duties refusal, written in its own
  transaction after the rollback), `.approved`, `.rejected`, `.expired`, `.cancelled` (`newValue.by = "subject"` when the subject module withdrew);
  `approval_policy.create`, `.new_version`, `.deactivate`. Status history of requests = the audit trail (Task 1 decision).
- **Notifications**: `approval.requested` (eligible approvers, minus requester and excluded) and `approval.decided` (requester, unless they ended it
  themselves). No params: the subject and amount stay out of notification text. Recipients must also hold `approvals.view` over the request
  (the target permission, re-checked at read time). Approvers are resolved by the engine (not `resolveRecipientsByPermission`, which needs a unit)
  so tenant-level requests reach TENANT-scoped approvers.
- **Policies API** (`/approvals/policies`, `approvals.configure` at TENANT): the contract's "new version + deactivate old" lives in `createPolicy`
  (posting an existing code), serialized per code by an advisory lock; overlapping active bands of the same subject type and currency are `409`;
  `approverPermission` must be a catalog `*.approve` key.
- **Idempotency**: `createApprovalRequestInTx` takes the subject module's deterministic `idempotencyKey` (unique per tenant: subject modules
  should prefix it with their subject type); a repeat returns the same request (`replayed: true`); the same key for another subject is `409`.
  The decide / cancel / policy routes accept `Idempotency-Key`.
## Phase 4 Task 4: ledger, revenue, payments, provider intake

- **Revenue is finance-confirmed, not automatic (manager preference, spec 11.5 human oversight).** Recording an outcome posts nothing. SOLD
  outcomes with a charged / collected amount appear in `GET /finance/charges-to-confirm`; a holder of `finance_payments.create` over the
  job (Owner, Finance Director) posts the CHARGE (`POST /finance/outcomes/{id}/charge`) and records the collection as a RECEIVED MANUAL
  payment linked to the outcome (`/collection`), whose PAYMENT entry posts in the same transaction. Both carry `expectedAmountMinor`
  (the amount the confirmer saw): if the outcome was corrected meanwhile the confirmation is `409 revenue.outcome_changed`. `occurredAt`
  of the charge and `receivedAt` of the collection are the visit's `occurredAt`; `recordedAt` is the server clock. Cost if wrong: an
  outcome hook (`onJobOutcomeRecorded`) calling the same two functions with a system actor; no data change.
- **Outcome-derived keys**: `outcome:<outcomeId>:charge:<n>` and `outcome:<outcomeId>:collection:<n>` (payment key), where `n` is 1 + the
  number of earlier charges (reversed) / collection payments (voided or failed) of that outcome. Two people confirming at once compute the
  same `n` and post once; after a correction (reverse the charge, confirm again) the new posting cannot collide with history. At most one
  ACTIVE charge and one active collection per outcome: a different amount while one is active is refused (`revenue.charge_already_posted`,
  `revenue.collection_already_recorded`); the same amount is a replay. A posted amount that no longer matches a corrected outcome shows as
  `MISMATCH` in the queue (`state=all`); Task 6 reconciles it.
- **Confirmation needs the outcome `financial` set too** (`job_outcomes.view` financial over the job, the existing one rule for outcome
  money): the queue leaves such rows out and the confirmation is `403 revenue.financial_set_required`. A finance grant alone never reveals
  a technician's amounts.
- **Permission mapping (no catalog change)**: posting a charge or a collection and recording a payment = `finance_payments.create`;
  reversing a CHARGE, voiding / failing / receiving a payment = `finance_payments.edit` (both correct recorded money); reads of entries and
  balances = `finance_ledger.view`; payments, the confirmation queue, providers = `finance_payments.view`; the intake log =
  `finance_payments.view` at TENANT scope (an event may name no existing job). `finance_ledger.export` is not used yet (no export endpoint).
- **One posting path**: `postLedgerEntryInTx` / `reverseLedgerEntryInTx` (ledger module) do NOT check permissions; every caller enforces
  first. Idempotency is `createMany({ skipDuplicates })` (= `INSERT ... ON CONFLICT DO NOTHING`) followed by a read of the key: a concurrent
  duplicate waits for the first transaction and then finds its row, instead of aborting the caller's transaction on a unique violation.
  The same key with different identity fields is `409 ledger.idempotency_key_reused`. Payments use the same technique on
  `Payment.idempotencyKey`. Entries must be in the job's currency (`ledger.currency_mismatch`).
- **Reversal-only corrections**: the generic `POST /finance/ledger/entries/{id}/reverse` takes CHARGE entries only. PAYMENT entries are
  corrected by voiding the payment (keeps the record and the ledger consistent); REFUND / CHARGEBACK / ADJUSTMENT / MATERIAL_COST by their
  owners' flows (Tasks 5, 2). A reversal copies the original's references and unit / legal-entity snapshot, key `reversal:<entryId>`
  (void: `payment:<id>:void`); a second reversal under another key is `ledger.already_reversed` (unique index), a reversal is never reversed.
- **Balance semantics** (`src/lib/ledger-balances.ts`, per currency, never stored): charged = CHARGE; billed = charged + ADJUSTMENT
  (positive adjustment = the customer owes more, negative = credit); net collected = PAYMENT - refunded - charged back; outstanding = billed
  - net collected; material cost separate. A REVERSAL counts under the type it reverses. Status: REFUNDED (something refunded, nothing
  net collected) > NOT_CHARGED (nothing billed, nothing net collected) / OVERPAID (nothing billed, money in) > UNPAID > PARTIAL > PAID >
  OVERPAID. `NOT_CHARGED` is added to the brief's five statuses. Note for Task 5: a goodwill refund does not by itself reduce what is
  billed; if a refund should also forgive the charge, Task 5 posts a matching negative ADJUSTMENT.
- **Scope**: finance reaches a job through its service-area unit only (`financeJobRef`), never OWN / ASSIGNED (a technician never sees
  finance even if a custom role carried a finance grant with those scopes). Ledger entries (lists, customer and legal-entity totals) are
  scoped by their posting snapshot; a job's balance, the job-balance list and payments follow the job's CURRENT unit (the work item belongs
  to whoever owns the job now). A legal entity's totals need TENANT or that LEGAL_ENTITY scope. A scoped caller asking for a customer with
  no visible entry gets 404. Finance responses carry ids and money only (no job titles, addresses, customer names).
- **Manual payments require `Idempotency-Key`** (400 without): it becomes `Payment.idempotencyKey` = `manual:<userId>:<key>`, so the DB
  guarantees one payment per submission even past the 24 h request store. Reference is required for CHECK, CARD (terminal slip) and
  BANK_TRANSFER. `receivedAt` at most 5 minutes in the future.
- **Provider intake** (`POST /api/v1/finance/intake/{tenantSlug}/{provider}`, no session; `defineRoute` now hands handlers `rawBody`, the
  exact bytes, for the signature): unknown provider (always, in this build) and unknown / inactive tenant answer the same `409
  payment_provider.not_configured` before any write. A bad signature is `401` and is logged as REJECTED under `externalId =
  unverified:<sha256 of body>`: the claimed id is NOT used, so a forger cannot pre-claim a real event id and make the genuine delivery a
  "duplicate". The verified event is committed first (RECEIVED), then processed in a second transaction under `SELECT ... FOR UPDATE`;
  an event left RECEIVED by a crash is processed by the next retry. Validation before any core record: event type (`payment.received` only;
  others REJECTED `unsupported_event_type`, Task 5 may add refund / chargeback events), job exists in the tenant (else UNMATCHED
  `unknown_job`), job currency, provider reference not seen (else DUPLICATE with `duplicateOfId`). Validation verdicts answer 200 (the
  event is on record; a provider retry would not change it); same id with different content is `409 payment_intake.payload_mismatch`.
  Known limitation: with a provider configured, anyone knowing the tenant slug can make the intake write one REJECTED row per distinct
  forged body (rate limiting is Phase 8 hardening).
- **No real provider, no fake one**: the registry is empty; tests define their own HMAC provider. A real integration needs per-tenant
  secrets (connection table, encrypted like MFA secrets: a later migration, as recorded in Task 1).
- **Not built**: exports (`finance_ledger.export`), charges not tied to an outcome (source JOB: Task 5 adjustments cover corrections),
  matching an UNMATCHED intake event to a job by hand (UNMATCHED > ACCEPTED is allowed by the DB), provider payment-failed / refund events,
  notifications to finance about new items in the queue, UI.

## Phase 4 Task 2: materials catalog, versioned costs, job material costing

- **Extended cost rounding (FOR OWNER REVIEW).** `extendedCostMinor = quantity x unitCostMinor`, where `quantity` is the usage's
  `Decimal(12,3)` and `unitCostMinor` the cost version's whole minor units. The product is computed exactly as `bigint` thousandths of a minor
  unit and rounded ONCE, **half-even** (banker's rounding) to whole minor units: 1.5 m x 425 = 637.5 -> 638; 1.5 x 423 = 634.5 -> 634; a
  non-half fraction goes to the nearest unit. Rounding happens per usage line; the job total is the exact sum of the rounded lines. This is the
  only rounding in Phase 4 (the global "no rounding" rule cannot hold for a 3-decimal quantity times a cost); it is plain multiplication,
  no pricing formula. Cost if the owner prefers half-up or per-job rounding: one function in `src/lib/material-cost-rules.ts`, but snapshots
  already taken keep their value (they are frozen), so decide before production data is costed. A product above `MAX_MONEY_MINOR` is not costed.
- **Version at usage time = `occurredAt`** (the device time the Phase 3 gate accepted, `assertBelievableEventTime`), not `recordedAt`: the cost
  in force when the material was used. The version is the APPROVED one whose `[effectiveFrom, effectiveTo)` covers it (same range as the GiST).
- **No stranded snapshots.** A new version must start strictly after the current approved version's start AND after every usage already costed
  with the current version (`409 material.cost_before_costed_usage`). Checked at proposal and again inside the approval transaction; costing and
  approving both take the material row lock, so the invariant "every costed line's version covers its `occurredAt`" holds forever. Backdating
  is allowed up to that point (supplier increases are often retroactive to the 1st). If the check fails at approval time, the decision answers
  409 and rolls back (the engine contract); the approver rejects instead. Corrections of past job costs are Task 5 adjustments, never rewrites.
- **One pending version per material**; the version's effective date does not move with the approval date. Without an active
  `MATERIAL_COST_CHANGE` policy the version is APPROVED at once (`approvalRequestId = null`, audit `by: "no_policy"`). Requests are tenant-level
  (`resolveResource` returns `{}`): materials have no org unit, so approvers need the policy permission at TENANT scope.
- **Who costs and proposes.** Catalog reads are a capability (any `materials.view` scope; the catalog is tenant-wide reference data like lost
  reasons); catalog writes are TENANT-scoped. Writing or reading any cost needs the `cost` set: so the COO (catalog maintainer without the set,
  Task 1 ruling) can create materials but cannot propose a cost, and Finance (view + approve + cost, no create) approves but does not propose.
  Costing a job's materials needs `jobs.view` over the job plus the `cost` set; it writes only a derived snapshot (the version is fixed by the
  date), so it is not an operational permission (spec 26.3). Cost if wrong: one `enforce*` call per service.
- **Linking free-text usage.** Phase 3 lines carry free text + an optional `materialRef`; a line resolves to its `materialId`, else to the
  material whose `code` equals `materialRef` (trimmed, lower-cased), else it can be linked explicitly (`POST /materials/usages/{id}/cost
  { materialId }`). Archived materials still cost past usage. Units must match (trimmed, case-insensitive); there is no conversion.
- **Costing is explicit** (endpoint), not triggered when the technician records the line: the field-execution module stays unchanged, and an
  uncosted line is reported as such (never estimated). The unit of a material is locked once it has a version or linked usage.
- **Not done here**: posting `MATERIAL_COST` ledger entries (`LedgerEntry.materialUsageId`) belongs to the ledger service (Task 4, parallel);
  the snapshot columns are what such a posting would read. No `materials.export` endpoint yet (no export framework exists).
