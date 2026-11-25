# API Reference (Phase 0-1)

Per-endpoint reference for every route under `src/app/api/v1/**/route.ts` (41 route files, 54
operations). It is written from the code (route files, Zod schemas and the services they call), not
from the spec, and it closes the "API behaviour is documented" gap of spec 26.7. The envelope, error
codes, pagination and idempotency rules are defined once in [`API_CONVENTIONS.md`](./API_CONVENTIONS.md);
this file does not repeat them, it only states what is specific to each endpoint.

A test (`tests/docs/api-reference.test.ts`) fails when a route file or an exported method has no
`### METHOD /api/v1/...` heading below, so this file cannot silently drift. It checks that the
operation is listed, not that its description is still correct: when you change a route, update its
entry in the same commit.

## How to read this

Each entry has the same fields:

- **Auth**: `public` (no session), `session` (a complete session cookie), or `session, MFA-pending
  allowed` (also accepts a session that has not finished MFA yet).
- **Permission**: the catalog permission, plus how the data scope is applied (see "Permission and
  scope rules").
- **Request**: path params, query, JSON body. Types are the Zod types; "strict" means unknown keys are
  rejected with `VALIDATION_FAILED`.
- **Idempotency**: whether `Idempotency-Key` is honoured.
- **Response**: the success status and `data` shape. Timestamps are ISO-8601 datetimes
  (`2026-11-21T13:40:18.000Z`); calendar dates without a time (employee `hireDate` and
  `terminationDate`) are `YYYY-MM-DD` (`2026-03-02`).
- **Errors**: only the codes beyond the common ones below.
- **Audit**: the `AuditEvent.action` values written. `outcome` is `SUCCESS` unless stated.

### Common to every endpoint

- **Bodies must be JSON.** A POST/PUT/PATCH/DELETE request that carries body bytes must send
  `Content-Type: application/json` (a `charset` parameter or a `+json` type is fine); anything else
  (`text/plain`, form types, a missing type) is `415 UNSUPPORTED_MEDIA_TYPE`, before any parsing. This
  is the CSRF defence together with SameSite=Lax cookies. A request with an empty body needs no
  content type, so bodyless calls such as `POST /auth/logout` or `DELETE /auth/sessions/{id}` work as
  they are. The body is capped at 1 MB: more than that, by `Content-Length` or by the bytes actually
  received, is `413 PAYLOAD_TOO_LARGE`. A non-empty body that is not valid JSON is `400
  VALIDATION_FAILED` (`field: "body"`).
- **MFA is checked on every request.** A session that never passed MFA, whose user now holds a role
  that requires it, is sent back to the MFA-pending state and answers `401 UNAUTHENTICATED` on every
  route except the `session, MFA-pending allowed` ones (audited as `auth.access_denied` with reason
  `mfa_required`); the client then runs `/auth/mfa/enroll` or `/auth/mfa/verify`.
- **Pipeline order** (`defineRoute`): correlation id, authenticate, read the body (size limit) and
  check its content type, parse and validate input (params, query, body), authorize, handler. Consequence: a malformed request is `400
  VALIDATION_FAILED` before any permission check, and an unauthenticated caller always gets `401`
  first. Validation `field` values are prefixed with their source (`body.email`, `query.limit`,
  `params.id`); an unparsable body is `field: "body"`.
- **Always possible**: `400 VALIDATION_FAILED`, `401 UNAUTHENTICATED` (on every non-public route:
  no cookie, unknown token, expired / idle / revoked session, deactivated user, inactive tenant, or an
  MFA-pending session on a route that does not allow it; a refused real session is audited as
  `auth.access_denied`, outcome `DENIED`), and `500 INTERNAL`. They are not repeated per endpoint.
- **`x-correlation-id`** is returned on every response (success, error, 204).
- **Optional header** `x-leadro-client: web | mobile` sets the audit `sourceApp` (default `API`). It is
  informational, not a security claim.
- **Tenant** always comes from the session. No endpoint takes a tenant id; an id of another tenant is
  indistinguishable from a missing record (`404`).
- **Collections** accept `?cursor=` (opaque, 1-300 chars) and `?limit=` (integer 1-200, default 50) and
  return `{ data: [...], page: { nextCursor: string | null, limit } }`. An unusable cursor is `400
  VALIDATION_FAILED` (`field: "cursor"`).
- **Field-level projection.** Responses that return business records are projected to the field sets
  the caller's grant reveals. Every field in this phase is classified `base`, so a normal grant sees
  all listed fields; the projection machinery is in place for the reserved sensitive sets (`financial`
  for employees, `billing` for customers). A field that is not in the module's field map is never
  returned. A field-limited grant (one that does not cover `base`) can read but cannot change employee
  or user records (`403`). Secrets are never part of any response: `passwordHash`, `mfaSecretEncrypted`,
  `mfaLastUsedStep`, `failedLoginCount`, `lockedUntil`, session token hashes and invitation tokens are
  never selected.

### Permission and scope rules

Authorization is RBAC plus ABAC (permissions plus data scopes over the org tree), evaluated live on
every request. Role names never matter. Three mechanisms appear below:

| Label | Meaning | Denial |
|---|---|---|
| **capability** | The caller holds the permission in any active assignment (`requirePermission(p)` without a resolver). Record scope is then applied by the service or the list query. | `403 FORBIDDEN` |
| **over a record** | The permission must cover that record (employee, org unit, legal entity) in the scope of the granting assignment. | capability missing: `403`; record outside scope, missing or other tenant: `404 NOT_FOUND` (existence not confirmed) |
| **tenant-level** | A tenant-wide (`TENANT` scope) grant is required, for records with no org placement (company settings, roles, legal entities). | `403 FORBIDDEN` |

Route-level denials are audited as `authz.denied` (outcome `DENIED`, target type `Permission`). Services
re-check the same rule inside their own transaction, so a permission change between the gate and the
write cannot be exploited; those in-service denials are not audited (the transaction rolls back). A
list endpoint puts the scope into the query (never filters afterwards), so a page can be shorter than
`limit` only by scope, never by post-filtering.

Scope objects (used by role grants and invitations):
`{ type: "TENANT" | "LEGAL_ENTITY" | "ORG_UNIT" | "OWN" | "ASSIGNED", legalEntityId?: string,
orgUnitId?: string, includeDescendants?: boolean }` (strict). `LEGAL_ENTITY` needs `legalEntityId`,
`ORG_UNIT` needs `orgUnitId`, the others need neither; `includeDescendants` applies to `ORG_UNIT` and
defaults to `true`.

### Idempotency in this phase

A route marked **Idempotency: supported** honours `Idempotency-Key: <1-128 chars>`. Without the header
the request simply runs. With it: first request runs and its status and body are stored (24 h); the same
key and the same method + path + body replays the stored response with `Idempotent-Replayed: true`; the
same key with a different request is `409 CONFLICT`; a concurrent duplicate still running is `409
CONFLICT` with `retryable: true`; a key of 0 or more than 128 characters is `400 VALIDATION_FAILED`
(`field: "Idempotency-Key"`). Authentication and authorization run before the key is consulted. A
failed attempt releases the key so it can be retried. All other routes ignore the header.

### Rate limits

Fixed-window limits (in-process, configuration constants in `src/server/auth/config.ts`) return `429
RATE_LIMITED` with a `Retry-After` header where a delay is known. Per-IP limits are skipped when the
client IP cannot be determined (set `LEADRO_TRUSTED_PROXY_HOPS` behind a proxy). Limits are quoted on
the endpoints that have them.

---

## 1. Auth (`/api/v1/auth`)

Authentication uses the opaque `leadro_session` cookie (`HttpOnly; SameSite=Lax; Path=/`, `Secure`
outside `next dev`). Sessions expire after 60 minutes idle or 12 hours absolute. There is no bearer
header. Self-service auth endpoints need no permission: they act only on the caller's own account.

Every auth event is written twice, in the same transaction: a login-history row (authentication
events) and an audit event; the audit names are listed per endpoint. Failures never reveal which part
was wrong.

### POST /api/v1/auth/login

- **Purpose**: log in with company code + email + password; sets the session cookie.
- **Auth**: public.
- **Permission**: none.
- **Request body**: `tenantSlug` string 1-100 (the company code, trimmed and lower-cased), `email`
  string 1-320 (normalised), `password` string 1-1000. Not strict (unknown keys are ignored). No
  password policy is applied here on purpose.
- **Idempotency**: not supported.
- **Response**: `200 { data: { userId, expiresAt, mfaRequired, mfaEnrollmentRequired } }` plus
  `Set-Cookie: leadro_session=...`. When `mfaRequired` is true the session is MFA-pending: it works only
  on `/auth/mfa/*` and `/auth/logout` until a code is verified. `mfaRequired` is true when the user has
  MFA enabled or any active role of the user has `requiresMfa`; `mfaEnrollmentRequired` is true when
  additionally no authenticator exists yet.
- **Errors**: `401 UNAUTHENTICATED` with the one generic message "The company code, email or password
  is incorrect." for an unknown or inactive company, unknown email, account without password, inactive
  or locked account, and wrong password (no enumeration; a throw-away password check equalises timing).
  `429 RATE_LIMITED`: 30 per minute per IP, 10 per minute per company+email.
- **Lockout**: 5 wrong passwords inside 15 minutes lock the account for 15 minutes (audited as
  `auth.account_lock`, outcome `DENIED`).
- **Audit**: `auth.login` (`SUCCESS`, or `FAILED` with the real reason in `newValue.reason`, which is
  never returned to the client); `auth.account_lock` when the lockout triggers.

### POST /api/v1/auth/logout

- **Purpose**: revoke the current session and clear the cookie.
- **Auth**: session, MFA-pending allowed.
- **Permission**: none.
- **Request**: no body.
- **Idempotency**: not supported (revoking twice is harmless: a revoked session is just `401`).
- **Response**: `204`, `Set-Cookie` clearing `leadro_session`.
- **Audit**: `auth.logout`.

### POST /api/v1/auth/mfa/enroll

- **Purpose**: start TOTP enrollment: stores a new encrypted seed (not active yet) and returns it once.
- **Auth**: session, MFA-pending allowed (this is how a user whose role newly requires MFA gets
  enrolled).
- **Permission**: none.
- **Request**: no body.
- **Idempotency**: not supported. Calling it again before confirming replaces the pending seed.
- **Response**: `200 { data: { secret, otpauthUri } }`. `secret` is the base32 seed and `otpauthUri` an
  `otpauth://` URI containing it: **sensitive, shown only here, never logged or returned again**.
- **Errors**: `409 CONFLICT` when MFA is already enabled (a stolen session cannot swap the
  authenticator); `404 NOT_FOUND` if the user row is gone; `500 INTERNAL` if the server encryption key
  (`LEADRO_ENCRYPTION_KEY`) is missing or invalid.
- **Audit**: `auth.mfa_enroll_start`.

### POST /api/v1/auth/mfa/confirm

- **Purpose**: prove the authenticator works and switch MFA on; an MFA-pending session becomes complete
  and its cookie is rotated.
- **Auth**: session, MFA-pending allowed.
- **Permission**: none.
- **Request body**: `code` string, exactly 6 digits (`^\d{6}$`).
- **Idempotency**: not supported.
- **Response**: `204`. If the session was MFA-pending, a new `Set-Cookie` replaces the token (the old
  token stops working); a session that was already complete gets no cookie.
- **Errors**: `400 VALIDATION_FAILED` (`field: "code"`) for a wrong or already used code (a code is
  accepted once; older time steps are refused after a newer one); `409 CONFLICT` if MFA is already
  enabled; `409 INVALID_STATE_TRANSITION` if enrollment was never started; `429 RATE_LIMITED` (10 per
  minute per session, or while the account is locked, with `Retry-After`). Wrong codes count toward the
  same lockout as wrong passwords.
- **Audit**: `auth.mfa_challenge` (`SUCCESS` or `FAILED`, `newValue.enrolling: true`).

### POST /api/v1/auth/mfa/verify

- **Purpose**: login step 2: verify a TOTP code, promote the MFA-pending session and rotate its cookie.
  Also usable on a complete session as a step-up check.
- **Auth**: session, MFA-pending allowed.
- **Permission**: none.
- **Request body**: `code` string, exactly 6 digits.
- **Idempotency**: not supported.
- **Response**: `204`; new `Set-Cookie` when the session was pending (none otherwise).
- **Errors**: `400 VALIDATION_FAILED` (`field: "code"`) wrong or reused code; `409
  INVALID_STATE_TRANSITION` when MFA is not enabled for the user (enroll first) or has no seed; `429
  RATE_LIMITED` as for `/mfa/confirm`.
- **Audit**: `auth.mfa_challenge` (`SUCCESS` or `FAILED`, `newValue.enrolling: false`).

### POST /api/v1/auth/password-reset/request

- **Purpose**: ask for a password-reset link. Always answers the same way, whether or not the account
  exists.
- **Auth**: public.
- **Permission**: none.
- **Request body**: `tenantSlug` string 1-100, `email` string 1-320. Not strict.
- **Idempotency**: not supported.
- **Response**: `202 { data: { accepted: true } }`. For an existing active user a single-use token
  (valid 1 hour, older unused tokens are invalidated) is handed to the notifier; it is never in the
  response.
- **Errors**: `429 RATE_LIMITED` only for the per-IP limit (10 per 15 minutes). The per-account limit
  (3 per 15 minutes per company+email) silently sends nothing but still answers `202`. This is
  intentional enumeration safety: a different answer once the limit is hit would reveal that the
  account exists, so a caller can never tell "limited" from "sent" (nor "unknown account" from either).
- **Audit**: `auth.password_reset_request` (only when an account matched).

### POST /api/v1/auth/password-reset/confirm

- **Purpose**: set a new password with a reset token; signs the user out everywhere.
- **Auth**: public (the token is the credential).
- **Permission**: none.
- **Request body**: `token` string 1-256, `newPassword` string 1-1000. Not strict. Password policy:
  at least 12 characters, at most 72 bytes (UTF-8), not equal to the email.
- **Idempotency**: not supported (the token is single use).
- **Response**: `204`. The user's failed-login counter and lockout are cleared and every session is revoked.
- **Errors**: `400 VALIDATION_FAILED` with "This password reset link is invalid or has expired." for any
  bad, used, expired or foreign token or an inactive user; `400 VALIDATION_FAILED` (`field: "password"`)
  when the new password breaks the policy; `429 RATE_LIMITED` (20 per 15 minutes per IP).
- **Audit**: `auth.password_reset_complete` (`newValue.revokedSessions`).

### POST /api/v1/auth/invitations/accept

- **Purpose**: accept an invitation: the invitee sets a password and the account becomes ACTIVE.
- **Auth**: public (the token is the credential).
- **Permission**: none.
- **Request body**: `token` string 1-256, `password` string 1-1000. Not strict. Same password policy as
  above.
- **Idempotency**: not supported (the token is single use).
- **Response**: `201 { data: { userId } }`. No session is created; the invitee logs in afterwards. The
  invited employee record (if any) is linked to the new user and the invited role (if any) is granted
  with the scope stored on the invitation.
- **Errors**: `400 VALIDATION_FAILED` "This invitation is invalid or has expired." for an unknown,
  expired, used or revoked token, an inviter who is no longer active, a role that is gone, or an
  assignment the inviter may no longer grant; `400 VALIDATION_FAILED` (`field: "password"`) for a policy
  breach; `409 CONFLICT` (same generic message) when an active account with that email already exists;
  `429 RATE_LIMITED` (20 per 15 minutes per IP).
- **Audit**: `auth.invitation_accept`; the role grant also writes `role_assignment.grant`.

### GET /api/v1/auth/sessions

- **Purpose**: list the caller's own live sessions.
- **Auth**: session.
- **Permission**: none (own data only).
- **Request**: no params.
- **Response**: `200 { data: [{ id, createdAt, lastSeenAt, expiresAt, ipAddress, userAgent, isCurrent }] }`,
  newest first, not paginated. `ipAddress` and `userAgent` can be null. Only unrevoked, unexpired
  sessions of the caller. The token itself is never returned.
- **Audit**: none (read).

### DELETE /api/v1/auth/sessions/{sessionId}

- **Purpose**: revoke one of the caller's own sessions (including the current one).
- **Auth**: session.
- **Permission**: none (own data only).
- **Request**: path `sessionId` string 1-64.
- **Idempotency**: not supported.
- **Response**: `204`.
- **Errors**: `404 NOT_FOUND` when the id is not one of the caller's live sessions (someone else's id
  is not confirmed to exist; an already revoked one is also `404`).
- **Audit**: `auth.session_revoke` (`newValue.sessionId`).

---

## 2. Tenants (`/api/v1/tenants`)

### GET /api/v1/tenants/current

- **Purpose**: the caller's company profile.
- **Auth**: session.
- **Permission**: `company_settings.view`, tenant-level.
- **Request**: none.
- **Response**: `200 { data: { id, slug, name, status, defaultLocale, defaultTimeZone, createdAt,
  updatedAt } }`. `slug` is the company code used at login (immutable). All fields `base`.
- **Errors**: `403 FORBIDDEN`.
- **Audit**: none.

### PATCH /api/v1/tenants/current

- **Purpose**: edit the company name and locale / time-zone defaults.
- **Auth**: session.
- **Permission**: `company_settings.edit`, tenant-level.
- **Request body** (strict, at least one key): `name` string 1-120 (trimmed), `defaultLocale` one of
  `en-US | es-US | he-IL`, `defaultTimeZone` IANA time-zone name, max 64 chars.
- **Idempotency**: not supported (a repeat with the same body is a no-op).
- **Response**: `200 { data: <profile as above> }`. An update that changes nothing returns the current
  profile without writing or auditing.
- **Errors**: `403 FORBIDDEN`.
- **Audit**: `tenant.update` (changed fields only, previous and new values).

---

## 3. Organization (`/api/v1/organization`)

Org unit fields (all `base`): `id, type, name, code, parentId, legalEntityId, active, address, timeZone,
defaultLocale, operatingHours, createdAt, updatedAt`. `type` is `BUSINESS_UNIT | STATE | REGION | CITY |
BRANCH | DEPARTMENT | TEAM`. `address`, `timeZone`, `defaultLocale` and `operatingHours` exist only for
`BRANCH` units (any other type with a non-null value is `400 VALIDATION_FAILED`, `field` = that key).
Parent/child type rules come from `src/lib/org-hierarchy.ts` (violations are `400 VALIDATION_FAILED`,
`field: "parentId"`). Archiving is soft: nothing is deleted.

Legal entity fields (all `base`): `id, name, legalName, active, createdAt, updatedAt`.

Shared request pieces: `address` (strict) `{ line1: string 1-200, line2?: string 1-200, city: string
1-100, state: 2 letters (upper-cased), postalCode: US ZIP (`12345` or `12345-6789`), country: "US"
(default) }`; `operatingHours`: object keyed by `mon|tue|wed|thu|fri|sat|sun`, each `null` (closed) or
`{ open: "HH:MM", close: "HH:MM" }` (strict, 24 h); `archive` body (strict) `{ reason?: string 1-500 }`.

### GET /api/v1/organization/units

- **Purpose**: list org units.
- **Auth**: session.
- **Permission**: `organization.view`, capability; the scope (`TENANT`, `LEGAL_ENTITY`, `ORG_UNIT`
  subtree) is part of the query.
- **Request query**: `cursor`, `limit`; `parentId` string; `type` unit type; `active` `true` (default) |
  `false` | `all`; `search` string 1-100 (case-insensitive match on name or code).
- **Response**: `200 { data: [unit], page }` ordered by name then id. Each row is projected per its
  matching scope.
- **Audit**: none.

### POST /api/v1/organization/units

- **Purpose**: create an org unit.
- **Auth**: session.
- **Permission**: `organization.create` over the parent unit (a top-level unit, `parentId` null or
  omitted, needs a tenant-wide grant); also over the legal entity when `legalEntityId` is set. The route
  gate is capability only, the service does the scope check.
- **Request body** (strict): `type` unit type (required), `name` string 1-120 (required), `code` string
  1-40, `parentId` string or null, `legalEntityId` string or null, and for `BRANCH` only `address`,
  `timeZone`, `defaultLocale`, `operatingHours`.
- **Idempotency**: supported.
- **Response**: `201 { data: unit }`.
- **Errors**: `403`; `404` parent unit not found or outside scope; `400` hierarchy violation
  (`parentId`), branch-only attribute on another type, unknown or archived legal entity
  (`legalEntityId`); `409 INVALID_STATE_TRANSITION` parent is archived; `409 CONFLICT` an active sibling
  already has the name (case-insensitive, `field: "name"`) or another uniqueness conflict.
- **Audit**: `org_unit.create`.

### GET /api/v1/organization/units/{id}

- **Purpose**: one org unit.
- **Auth**: session.
- **Permission**: `organization.view` over the unit.
- **Request**: path `id` string 1-64.
- **Response**: `200 { data: unit }`.
- **Errors**: `404` missing or outside scope (a caller with no grant at all gets `403`).
- **Audit**: none.

### PATCH /api/v1/organization/units/{id}

- **Purpose**: rename a unit and edit its attributes. The type never changes.
- **Auth**: session.
- **Permission**: `organization.edit` over the unit (and over the new legal entity if `legalEntityId`
  is set).
- **Request body** (strict, at least one key): `name` string 1-120, `code` string 1-40 or null,
  `legalEntityId` string or null, `address`, `timeZone`, `defaultLocale`, `operatingHours` (each or
  null to clear; `BRANCH` units only).
- **Idempotency**: not supported (repeating the same patch is a no-op).
- **Response**: `200 { data: unit }`. A patch that changes nothing returns the current unit without an
  audit event.
- **Errors**: `404`; `409 INVALID_STATE_TRANSITION` the unit is archived; `400` branch-only attribute,
  unknown or archived legal entity; `409 CONFLICT` sibling name taken.
- **Audit**: `org_unit.update` (changed fields).

### POST /api/v1/organization/units/{id}/move

- **Purpose**: re-parent a unit (and its subtree).
- **Auth**: session.
- **Permission**: `organization.edit` over the unit AND over the destination parent (a move to the top
  level, `newParentId: null`, needs a tenant-wide grant).
- **Request body** (strict): `newParentId` string or null (required), `reason` string 1-500.
- **Idempotency**: not supported.
- **Response**: `200 { data: unit }`.
- **Errors**: `404` unit or destination not found or outside scope; `409 INVALID_STATE_TRANSITION` the
  unit or the destination is archived; `400 VALIDATION_FAILED` (`field: "newParentId"`) already under
  this parent, destination is the unit itself or a descendant (cycle), or the type is not allowed
  under the new parent; `409 CONFLICT` a sibling of the destination has the same name. The tree is
  locked per tenant while moving.
- **Audit**: `org_unit.move` (previous and new `parentId`, `reason`).

### POST /api/v1/organization/units/{id}/archive

- **Purpose**: soft-archive a unit.
- **Auth**: session.
- **Permission**: `organization.archive` over the unit.
- **Request body** (strict, may be empty or omitted): `reason` string 1-500.
- **Idempotency**: not supported (a second call is `409`).
- **Response**: `200 { data: unit }` (with `active: false`). Open manager assignments of the unit are
  ended (history kept).
- **Errors**: `404`; `409 INVALID_STATE_TRANSITION` already archived, still has active child units
  ("Archive or move the unit's active child units first."), or people are currently or prospectively
  placed in it.
- **Audit**: `org_unit.archive` (`newValue.endedManagerAssignments`, `reason`).

### GET /api/v1/organization/units/{id}/managers

- **Purpose**: managers of a unit (current by default).
- **Auth**: session.
- **Permission**: `organization.view` over the unit. A manager's name is included only when the caller
  also holds `employees.view` over that employee.
- **Request**: path `id`; query `cursor`, `limit`, `includeEnded` `true | false` (default `false`; `true`
  adds ended assignments, i.e. history).
- **Response**: `200 { data: [{ id, orgUnitId, employeeId, isPrimary, effectiveFrom, effectiveTo,
  employee: { firstName, lastName } | null }], page }`, ordered by `effectiveFrom` desc. `employee` is
  null when the caller may not see the person's name. Managing a unit grants no data access.
- **Errors**: `404` unit missing or outside scope.
- **Audit**: none.

### POST /api/v1/organization/units/{id}/managers

- **Purpose**: make an employee a manager of the unit, effective now.
- **Auth**: session.
- **Permission**: `organization.assign` over the unit AND `employees.view` over the employee.
- **Request body** (strict): `employeeId` string 1-64 (required), `isPrimary` boolean (default `false`;
  `true` demotes the unit's current primary manager in the same transaction).
- **Idempotency**: not supported (a repeat is `409`).
- **Response**: `201 { data: { id, orgUnitId, employeeId, isPrimary, effectiveFrom, effectiveTo } }`
  (no `employee` key).
- **Errors**: `404` unit or employee missing or outside scope; `409 INVALID_STATE_TRANSITION` unit
  archived, or the employee is terminated; `409 CONFLICT` the employee already manages the unit.
- **Audit**: `org_unit.manager_assign` (`newValue` has `managerId`, `employeeId`, `isPrimary`,
  `demotedPrimaryManagers`).

### DELETE /api/v1/organization/units/{id}/managers/{managerId}

- **Purpose**: end a manager assignment (the row is kept as history).
- **Auth**: session.
- **Permission**: `organization.assign` over the unit.
- **Request**: path `id`, `managerId` (the assignment id, not the employee id), each string 1-64.
- **Idempotency**: not supported.
- **Response**: `204`.
- **Errors**: `404` unit or assignment not found or outside scope; `409 INVALID_STATE_TRANSITION` the
  assignment already ended.
- **Audit**: `org_unit.manager_unassign`.

### GET /api/v1/organization/legal-entities

- **Purpose**: list legal entities (the employing companies).
- **Auth**: session.
- **Permission**: `organization.view`, capability. Only a `TENANT` scope or a `LEGAL_ENTITY` scope on
  that entity reveals an entity; org-unit scopes do not.
- **Request query**: `cursor`, `limit`, `active` `true` (default) | `false` | `all`.
- **Response**: `200 { data: [legalEntity], page }` ordered by name then id.
- **Audit**: none.

### POST /api/v1/organization/legal-entities

- **Purpose**: create a legal entity.
- **Auth**: session.
- **Permission**: `organization.create`, tenant-level.
- **Request body** (strict): `name` string 1-120 (required), `legalName` string 1-200.
- **Idempotency**: supported.
- **Response**: `201 { data: legalEntity }`.
- **Errors**: `403`; `409 CONFLICT` "A legal entity with this name already exists."
- **Audit**: `legal_entity.create`.

### GET /api/v1/organization/legal-entities/{id}

- **Purpose**: one legal entity.
- **Auth**: session.
- **Permission**: `organization.view` over the entity (`TENANT` or matching `LEGAL_ENTITY` scope).
- **Request**: path `id`.
- **Response**: `200 { data: legalEntity }`.
- **Errors**: `404` missing or outside scope.
- **Audit**: none.

### PATCH /api/v1/organization/legal-entities/{id}

- **Purpose**: rename a legal entity or edit its legal name.
- **Auth**: session.
- **Permission**: `organization.edit`, tenant-level.
- **Request body** (strict, at least one key): `name` string 1-120, `legalName` string 1-200 or null.
- **Idempotency**: not supported.
- **Response**: `200 { data: legalEntity }` (an unchanged patch returns it without an audit event).
- **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` the entity is archived; `409 CONFLICT`
  duplicate name.
- **Audit**: `legal_entity.update`.

### POST /api/v1/organization/legal-entities/{id}/archive

- **Purpose**: archive a legal entity.
- **Auth**: session.
- **Permission**: `organization.archive`, tenant-level.
- **Request body** (strict, may be empty): `reason` string 1-500.
- **Idempotency**: not supported.
- **Response**: `200 { data: legalEntity }` (`active: false`).
- **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` already archived, or active org units or
  non-terminated employees still reference it ("Reassign the active org units and employees of this
  legal entity first.").
- **Audit**: `legal_entity.archive` (`reason`).

---

## 4. Employees (`/api/v1/employees`)

Employee fields: `id, userId, legalEntityId, employeeNumber, firstName, lastName, email, phone,
jobTitle, status, hireDate, terminationDate, createdAt, updatedAt`, plus the derived
`currentOrgUnitIds` (string array: where the person is placed right now). All are `base`; the
reserved financial keys (`salary`, `payRate`, bank and tax fields) are classified `financial` and are
not stored in this phase. `status` is `ACTIVE | ON_LEAVE | TERMINATED`. `hireDate` and
`terminationDate` are calendar dates: they are sent and returned as `YYYY-MM-DD` (`2026-03-02`), or
`null`; `createdAt` / `updatedAt` stay ISO datetimes. A write needs a grant that covers the `base`
set; a field-limited grant (for example availability-only) can read but gets `403` on writes. After a
write the response is projected with what the caller may VIEW of the post-change record (falls back to
`{ id }` if they can no longer view it).

Placement (`kind`): `PRIMARY` (the operational team, exactly one at any time), `SECONDARY` (open-ended
extra), `TEMPORARY` (extra, with an end). Placements are never overwritten; a transfer closes the
current primary and inserts a new row. Dates in a placement body are ISO-8601 instants with an offset
(`2026-11-21T13:40:00Z`).

### GET /api/v1/employees

- **Purpose**: list employees.
- **Auth**: session.
- **Permission**: `employees.view`, capability; scope in the query, fields projected per row by the
  scope part that matched that row.
- **Request query**: `cursor`, `limit`; `status` `ACTIVE | ON_LEAVE | TERMINATED`; `orgUnitId` (currently
  placed in exactly this unit); `legalEntityId`; `search` string 1-100 (first name, last name, email or
  employee number, case-insensitive).
- **Response**: `200 { data: [employee], page }` ordered by last name, first name, id.
- **Audit**: none.

### POST /api/v1/employees

- **Purpose**: create an employee and, when `orgUnitId` is given, their first `PRIMARY` placement
  (reason "Initial placement", effective now).
- **Auth**: session.
- **Permission**: `employees.create` over the initial unit (without a unit the employee is unplaced
  and a tenant-wide grant is required), and over the legal entity when one is given; the grant must
  cover `base`.
- **Request body** (strict): `firstName` string 1-80 and `lastName` string 1-80 (required); `email`
  (trimmed, lower-cased, valid, max 254) or null; `phone` 5-32 chars of digits, spaces and `+ ( ) - .`
  or null; `jobTitle` 1-120 or null; `employeeNumber` 1-40 or null; `legalEntityId` or null; `hireDate`
  `YYYY-MM-DD` (a real calendar date) or null; `orgUnitId` string or null.
- **Idempotency**: supported.
- **Response**: `201 { data: employee }`.
- **Errors**: `403` (also for a field-limited grant); `404` the unit is missing or outside scope;
  `409 INVALID_STATE_TRANSITION` the unit is archived; `400` unknown or archived legal entity
  (`legalEntityId`), `hireDate` more than 366 days in the future; `409 CONFLICT` "An employee with this
  employee number already exists."
- **Audit**: `employee.create` (`newValue` is the input plus `orgUnitId`).

### GET /api/v1/employees/{id}

- **Purpose**: one employee.
- **Auth**: session.
- **Permission**: `employees.view` over the employee.
- **Request**: path `id` string 1-64.
- **Response**: `200 { data: employee }` projected to the caller's grant.
- **Errors**: `404` missing or outside scope.
- **Audit**: none.

### PATCH /api/v1/employees/{id}

- **Purpose**: edit employee data or toggle `ACTIVE` / `ON_LEAVE`.
- **Auth**: session.
- **Permission**: `employees.edit` over the employee with the `base` field set; also over the new legal
  entity when `legalEntityId` is set.
- **Request body** (strict, at least one key): `firstName`, `lastName` (1-80), `email`, `phone`,
  `jobTitle`, `employeeNumber`, `legalEntityId`, `hireDate` (same formats as create; the nullable ones
  accept null to clear), `status` `ACTIVE | ON_LEAVE` (leaving the company is `terminate`).
- **Idempotency**: not supported (a repeated identical patch is a no-op).
- **Response**: `200 { data: employee }` (an unchanged patch returns the current record, no audit).
- **Errors**: `403` field-limited grant; `404`; `409 INVALID_STATE_TRANSITION` the employee is
  terminated; `400` unknown or archived legal entity; `409 CONFLICT` duplicate employee number.
- **Audit**: `employee.update` (changed fields).

### POST /api/v1/employees/{id}/terminate

- **Purpose**: end employment (soft). In one transaction: sets `TERMINATED` and the termination date,
  ends every open placement and manager assignment, deactivates the linked login when the caller also
  holds `users.archive` over it, and always revokes that user's sessions.
- **Auth**: session.
- **Permission**: `employees.archive` over the employee. For an employee with a login the caller must
  also be allowed to administer any privileged role that user holds (HR cannot lock out an Owner).
- **Request body** (strict): `terminationDate` `YYYY-MM-DD` (required), `reason` string 1-500
  (required).
- **Idempotency**: not supported (a second call is `409`).
- **Response**: `200 { data: employee }`.
- **Errors**: `404`; `409 INVALID_STATE_TRANSITION` already terminated; `403 FORBIDDEN` terminating
  your own record, or the person holds a privileged role you may not administer; `400`
  (`field: "terminationDate"`) in the future or before the hire date.
- **Audit**: `employee.terminate` (`newValue` has `endedPlacements`, `endedManagerAssignments`,
  `deactivatedUserId`, `loginLeftActiveForUserAdministrator`, `revokedSessions`; `reason`).

### GET /api/v1/employees/{id}/assignments

- **Purpose**: placement history of one employee, newest first.
- **Auth**: session.
- **Permission**: `employees.view` over the employee with the `base` field set (else `403`).
- **Request**: path `id`; query `cursor`, `limit` only.
- **Response**: `200 { data: [{ id, employeeId, orgUnitId, kind, effectiveFrom, effectiveTo, reason,
  createdById, createdAt, previousOrgUnitId }], page }`. `previousOrgUnitId` is the unit the person was
  in right before this `PRIMARY` row (null for the first and for non-primary rows).
- **Errors**: `403` no `base` field set; `404`.
- **Audit**: none.

### POST /api/v1/employees/{id}/assignments

- **Purpose**: place or transfer an employee.
- **Auth**: session.
- **Permission**: `employees.assign` over the employee (where they are now) AND over the destination
  unit.
- **Request body** (strict): `orgUnitId` string (required); `kind` `PRIMARY` (default) | `SECONDARY` |
  `TEMPORARY`; `effectiveFrom` instant (default now; may be in the future; a past date more than 5
  minutes back is a "correction" and requires `reason`); `effectiveTo` instant (required for
  `TEMPORARY`, optional for `SECONDARY`, not allowed for `PRIMARY`); `reason` string 1-500.
- **Idempotency**: supported.
- **Response**: `201 { data: { id, employeeId, orgUnitId, kind, effectiveFrom, effectiveTo, reason,
  createdById, createdAt, previousOrgUnitId } }`.
- **Errors**: `404` employee or unit missing or outside scope; `409 INVALID_STATE_TRANSITION` employee
  terminated or unit archived; `400` (`effectiveTo`) not after `effectiveFrom`, (`effectiveFrom`) not
  after the current primary started, (`orgUnitId`) already placed in that unit, (`reason`) a past date
  without a reason; `409 CONFLICT` the current placement already has a later end, or an overlapping
  placement in the same unit exists. Operations on one employee are serialised.
- **Audit**: `employee.assign` (`newValue.correction: true` for a past-dated change; `reason`).

### POST /api/v1/employees/{id}/assignments/{assignmentId}/end

- **Purpose**: end a `SECONDARY` or `TEMPORARY` placement.
- **Auth**: session.
- **Permission**: `employees.assign` over the employee.
- **Request**: path `id`, `assignmentId` (each string 1-64); body (strict, may be empty): `effectiveTo`
  instant (default now; a `TEMPORARY` one can only be shortened), `reason` string 1-500 (required when
  the end date is more than 5 minutes in the past).
- **Idempotency**: not supported.
- **Response**: `200 { data: placement }` (the same shape as above; `previousOrgUnitId` is null).
- **Errors**: `404` assignment not found for that employee; `409 INVALID_STATE_TRANSITION` it is
  `PRIMARY` (transfer or terminate instead) or it already ended; `400` (`effectiveTo`) would extend
  the placement, (`reason`) a past date without a reason.
- **Audit**: `employee.assignment_end`.

### GET /api/v1/employees/{id}/org-unit-at

- **Purpose**: the org unit the employee was primarily placed in at a given instant (the reporting
  primitive that keeps historical numbers stable across transfers).
- **Auth**: session.
- **Permission**: `employees.view` over the employee with the `base` field set.
- **Request**: path `id`; query `date` ISO-8601 instant with offset (required).
- **Response**: `200 { data: { assignmentId, orgUnitId, effectiveFrom, effectiveTo } | null }`; `null`
  data when there was no primary placement then (before hire, in a gap, after termination).
- **Errors**: `403` no `base` field set; `404`.
- **Audit**: none.

### POST /api/v1/employees/{id}/invitations

- **Purpose**: invite the employee to create a login, optionally granting a role on acceptance.
- **Auth**: session.
- **Permission**: `users.create` over the employee. With a role, the inviter must also be able to
  assign that role over that scope to this person (anti-escalation, checked now and again when the
  invitation is accepted).
- **Request body** (strict): `email` (as for employees; falls back to the employee's email) , `roleId`
  string, `scope` (a scope object, see "Permission and scope rules"). `roleId` and `scope` must be given
  together.
- **Idempotency**: supported.
- **Response**: `201 { data: { invitationId, expiresAt } }`. The single-use token (valid 72 hours) goes
  to the notifier and is never in the response. Any earlier open invitation to that email is revoked.
- **Errors**: `404` employee, or an employee outside scope; `409 INVALID_STATE_TRANSITION` terminated
  employee; `409 CONFLICT` the employee already has a login, or an account with that email exists
  (`field: "email"`), or the employee can no longer be invited; `400` no email available (`field:
  "email"`), unknown role (`roleId`), invalid scope target, unknown employee, inviter inactive; `403`
  the inviter may not grant that role or scope.
- **Audit**: `auth.invitation_create`.

---

## 5. Users (`/api/v1/users`)

A user's data scope is that of their employee record (org-unit scopes follow the employee's active
placements, legal-entity scopes their legal employer, `OWN` their own employee). A user with no
employee record (for example the Owner) is reachable only by a tenant-wide grant. A terminated
employee has no open placement, so their still-active login is visible only to tenant-wide user
administrators.

User fields (all `base`): `id, email, status, locale, timeZone, mfaEnabled, lastLoginAt, employeeId,
employeeStatus, loginPendingDeactivation, firstName, lastName, createdAt, updatedAt`. `status` is
`INVITED | ACTIVE | LOCKED | DEACTIVATED`. `locale` and `timeZone` are the user's own preference (null
means inherit from branch or company). `loginPendingDeactivation` is true when the employee is
terminated but the login is still ACTIVE. Credentials and lockout state are never returned.
Accounts are created only by accepting an invitation, so there is no create endpoint.

### GET /api/v1/users

- **Purpose**: list users.
- **Auth**: session.
- **Permission**: `users.view`, capability; scope in the query via the user's employee.
- **Request query**: `cursor`, `limit`; `status` `INVITED | ACTIVE | LOCKED | DEACTIVATED`; `search`
  string 1-100 (email, or the employee's first or last name); `pendingDeactivation` only the value
  `true` (active logins of terminated employees).
- **Response**: `200 { data: [user], page }` ordered by email, then id.
- **Audit**: none.

### GET /api/v1/users/me

- **Purpose**: the signed-in user's own profile.
- **Auth**: session.
- **Permission**: none (self-service; own row only, every mapped non-secret field).
- **Response**: `200 { data: user }`.
- **Errors**: `404` if the row has vanished.
- **Audit**: none.

### POST /api/v1/users/me/password

- **Purpose**: change the signed-in user's own password. Every OTHER session of the user is revoked; the
  current one stays.
- **Auth**: session.
- **Permission**: none (own data).
- **Request body** (strict): `currentPassword` string 1-1000, `newPassword` string 1-1000 (policy: at
  least 12 characters, at most 72 bytes, not equal to the email, different from the current password).
- **Idempotency**: not supported.
- **Response**: `200 { data: { revokedSessions } }`.
- **Errors**: `400 VALIDATION_FAILED` `field: "currentPassword"` wrong current password;
  `field: "password"` policy breach; `field: "newPassword"` same as the current one; `409 CONFLICT` the
  password changed concurrently (retry); `404` user missing or not active; `429 RATE_LIMITED` (5 per 15
  minutes per user).
- **Audit**: `auth.password_change` (`newValue.revokedSessions`).

### GET /api/v1/users/{id}

- **Purpose**: one user.
- **Auth**: session.
- **Permission**: `users.view` over the user (resolved through their employee; tenant-level when they
  have none). The route gate is capability; the service checks the record.
- **Request**: path `id`.
- **Response**: `200 { data: user }`.
- **Errors**: `404` missing or outside scope.
- **Audit**: none.

### PATCH /api/v1/users/{id}

- **Purpose**: set or clear a user's locale and time-zone preference.
- **Auth**: session.
- **Permission**: `users.edit` over the user, with the `base` field set.
- **Request body** (strict, at least one key): `locale` `en-US | es-US | he-IL` or null, `timeZone` IANA
  name (max 64) or null.
- **Idempotency**: not supported (a repeated identical patch is a no-op).
- **Response**: `200 { data: user }`.
- **Errors**: `403` field-limited grant; `404`; `409 INVALID_STATE_TRANSITION` the user is
  deactivated.
- **Audit**: `user.update` (changed fields).

### POST /api/v1/users/{id}/deactivate

- **Purpose**: disable the login and sign it out everywhere (the record, role history and audit trail
  stay).
- **Auth**: session.
- **Permission**: `users.archive` over the user.
- **Request body** (strict): `reason` string 1-500 (required).
- **Idempotency**: not supported (a second call is `409`).
- **Response**: `200 { data: { revokedSessions } }`.
- **Errors**: `404`; `403 FORBIDDEN` deactivating your own account; `409 INVALID_STATE_TRANSITION`
  already deactivated.
- **Audit**: `user.deactivate` (previous status, `revokedSessions`, `reason`); `auth.session_revoke`
  when at least one session was revoked.

---

## 6. Roles (`/api/v1/roles`)

Roles are tenant-level bundles of catalog permissions; data scopes belong to assignments. Role fields
(all `base`): `id, name, description, templateKey, isSystemTemplate, requiresMfa, active,
permissionCount, permissions, createdAt, updatedAt`. `permissions` (present on single-role responses,
omitted on lists) is a list of `{ permission: string, conditions: object | null }` sorted by key. A
grant in a request is `{ permission: string 1-80, conditions?: object }` (strict; `conditions` is parsed
strictly by authz as `{ fields?, includeFields?, set? }`); a permission may appear once and at most 200
grants are allowed. Role names never affect access.

Two escalation rules apply to every role write: nobody can put a permission (or a sensitive field set)
into a role that they do not hold themselves, and nobody can edit, re-permission or archive a role that
is assigned to themselves (separation of duties). `requiresMfa` is forced on when a permission demands
it (permission management, `*.configure`, always-MFA templates) and cannot be switched off then.

### GET /api/v1/roles

- **Purpose**: list roles.
- **Auth**: session.
- **Permission**: `permissions.view`, capability. Roles have no org placement, so only a tenant-wide
  grant matches them: a holder with only a unit scope gets an empty page.
- **Request query**: `cursor`, `limit`; `active` `true` (default) | `false` | `all`; `search` string
  1-100 (name, case-insensitive).
- **Response**: `200 { data: [role without permissions], page }` ordered by name, then id.
- **Audit**: none.

### POST /api/v1/roles

- **Purpose**: create a custom role.
- **Auth**: session.
- **Permission**: `permissions.create`, tenant-level; the caller must hold every permission in the role.
- **Request body** (strict): `name` string 1-80 (required), `description` string 1-500, `requiresMfa`
  boolean, `permissions` array of grants (required, may be empty).
- **Idempotency**: supported.
- **Response**: `201 { data: role with permissions }`.
- **Errors**: `403` missing permission or escalation attempt; `400` unknown permission key
  (`field: "permissions"`); `409 CONFLICT` "A role with this name already exists."
- **Audit**: `role.create` (name, MFA flag, permissions).

### GET /api/v1/roles/{id}

- **Purpose**: one role with its permissions and qualifiers.
- **Auth**: session.
- **Permission**: `permissions.view`, tenant-level.
- **Request**: path `id`.
- **Response**: `200 { data: role with permissions }`.
- **Errors**: `403`; `404`.
- **Audit**: none.

### PATCH /api/v1/roles/{id}

- **Purpose**: change a role's name, description or MFA flag.
- **Auth**: session.
- **Permission**: `permissions.edit`, tenant-level; the role must not be assigned to the caller.
- **Request body** (strict, at least one key): `name` string 1-80, `description` string 1-500 or null,
  `requiresMfa` boolean.
- **Idempotency**: not supported.
- **Response**: `200 { data: role with permissions }` (unchanged patch: current role, no audit).
- **Errors**: `403` (including "You cannot change a role that is assigned to you."); `404`; `409
  INVALID_STATE_TRANSITION` the role is archived; `400` (`field: "requiresMfa"`) MFA is mandatory for
  this role; `409 CONFLICT` duplicate name.
- **Audit**: `role.update`.

### PUT /api/v1/roles/{id}/permissions

- **Purpose**: replace the whole permission set of a role.
- **Auth**: session.
- **Permission**: `permissions.edit`, tenant-level; the role must not be assigned to the caller; the
  caller must hold every ADDED or CHANGED grant, and every live holder of the role must be inside a
  scope the caller could grant it in (removing a permission never escalates anyone).
- **Request body** (strict): `permissions` array of grants (required), `reason` string 1-500.
- **Idempotency**: not supported (replacing with the same set is a no-op).
- **Response**: `200 { data: role with permissions }`.
- **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` the role is archived; `400` unknown
  permission key (`field: "permissions"`).
- **Audit**: `role.permissions_change` (`previousValue.removed` / `changed`, `newValue.added` /
  `changed`, `reason`). This is what `/history` serves.

### POST /api/v1/roles/{id}/clone

- **Purpose**: copy a role (for example a template) under a new name, as an ordinary custom role.
- **Auth**: session.
- **Permission**: `permissions.create`, tenant-level; the caller must hold every permission of the
  source role.
- **Request body** (strict): `name` string 1-80 (required), `description` string 1-500 (defaults to the
  source's).
- **Idempotency**: supported.
- **Response**: `201 { data: role with permissions }`.
- **Errors**: `403`; `404` source role not found; `409 CONFLICT` duplicate name.
- **Audit**: `role.clone` (`newValue.clonedFromRoleId`).

### POST /api/v1/roles/{id}/archive

- **Purpose**: archive a role; it stops granting access at once while assignments and history stay.
- **Auth**: session.
- **Permission**: `permissions.archive`, tenant-level; the role must not be assigned to the caller.
- **Request body** (strict): `reason` string 1-500 (required).
- **Idempotency**: not supported.
- **Response**: `200 { data: role without permissions }` (`active: false`).
- **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` already archived.
- **Audit**: `role.archive` (`reason`).

### GET /api/v1/roles/{id}/history

- **Purpose**: permission history of a role: every audit event that targeted it (create, clone, edit,
  permission changes, archive), newest first.
- **Auth**: session.
- **Permission**: `permissions.view`, tenant-level.
- **Request**: path `id`; query `cursor`, `limit` only. The cursor is opaque and specific to this
  endpoint (it is not interchangeable with other lists).
- **Response**: `200 { data: [{ id, action, occurredAt, reason, actor, changes }], page }`. `actor`
  is `{ userId, displayName }` (employee name, else login email) or `null`. `changes` is a summary
  reduced to keys: `{ permissionsAdded: string[], permissionsRemoved: string[], permissionsChanged:
  string[], fieldsChanged: string[] }` (`permissionsChanged` = kept permissions whose qualifiers
  changed; `fieldsChanged` = which of `name`, `description`, `requiresMfa` an edit touched). The raw
  audit values, qualifier contents, IP address, user agent and correlation id are not returned.
- **Errors**: `403`; `404` role not found.
- **Audit**: none.

### GET /api/v1/roles/assignments

- **Purpose**: who holds which role, scope and expiry.
- **Auth**: session.
- **Permission**: `permissions.view`, capability; scope applies through the TARGET user's employee (a
  user with no employee needs a tenant-wide grant).
- **Request query**: `cursor`, `limit`; `userId`, `roleId`; `state` `active` (default, in effect now) |
  `all` (also revoked, expired, scheduled).
- **Response**: `200 { data: [{ id, userId, roleId, roleName, state, effectiveFrom, effectiveTo,
  grantedById, reason, revokedAt, revokedById, scopes: [{ id, type, legalEntityId, orgUnitId,
  includeDescendants }], createdAt }], page }`, newest first. `state` is `ACTIVE | SCHEDULED | EXPIRED |
  REVOKED | ROLE_INACTIVE`.
- **Audit**: none.

### POST /api/v1/roles/assignments

- **Purpose**: grant a role to a user with explicit scopes and an optional expiry.
- **Auth**: session.
- **Permission**: `permissions.assign`, capability at the route; the service enforces authority over the
  target user and every requested scope, that the caller holds every permission of the role, and
  (for sensitive roles) the stricter administer rule.
- **Request body** (strict): `userId` string, `roleId` string, `scopes` array of 1-20 scope objects (all
  required), `effectiveFrom` instant (default now), `effectiveTo` instant (temporary access, must be
  after `effectiveFrom`), `reason` string 1-500 (required).
- **Idempotency**: supported.
- **Response**: `201 { data: { roleAssignmentId } }`.
- **Errors**: `403` granting to yourself, escalation, "You cannot grant a role containing permissions
  you do not hold."; `404` "The user or role was not found." or "A scope target was not found.";
  `400` scope shape (`field: "scopes"`) or `effectiveTo` not after `effectiveFrom`; `409 CONFLICT` the
  user already holds that role with the same scope for an overlapping period.
- **Audit**: `role_assignment.grant`.

### POST /api/v1/roles/assignments/{id}/revoke

- **Purpose**: end a role assignment now; the row stays as history.
- **Auth**: session.
- **Permission**: `permissions.assign`, capability at the route; the service requires authority over the
  assignment's user and scopes (revoking your own assignment is allowed).
- **Request**: path `id`; body (strict): `reason` string 1-500 (required).
- **Idempotency**: not supported (a second call is `409`).
- **Response**: `204`.
- **Errors**: `403`; `404` "The role assignment was not found."; `409 INVALID_STATE_TRANSITION` already
  revoked.
- **Audit**: `role_assignment.revoke` (`reason`).

### GET /api/v1/roles/effective-access

- **Purpose**: what a user can do right now, and optionally why a single permission is or is not
  granted.
- **Auth**: session.
- **Permission**: `permissions.view` over the target user (their employee, or tenant-wide for a user
  without one). With `permission`, the optional record must also be inside the caller's scope.
- **Request query**: `userId` string (required); `permission` string 1-80; `employeeId`; `orgUnitId`
  (the last two refine the explanation and only matter with `permission`).
- **Response**: `200 { data: { userId, accountActive, assignments: [{ roleAssignmentId, roleId,
  roleName, requiresMfa, effectiveFrom, effectiveTo, scopes, permissions: [{ permission, conditions }]
  }], permissions: [string], explanation?: { permission, decision, accountActive, assignments,
  summary } } }`. The explanation includes expired and revoked assignments, so it exposes a user's grant
  history.
- **Errors**: `403`; `404` user or record missing or outside scope.
- **Audit**: none.

## Qualifications (`/api/v1/qualifications`, Phase 2)

Skills, credentials (certifications, licenses, equipment qualifications, training), job-category
permissions, service territories, availability, and the eligibility check (spec 10.1). Module:
`src/server/qualifications`; rules: `src/lib/eligibility`. Qualification records belong to an employee, so
their data scope is the EMPLOYEE's (placements, legal employer, OWN) and every endpoint needs the `base`
field set (a grant limited to another field set gets `403`). A record outside the caller's scope is `404`.
Calendar dates (`issuedAt`, `expiresAt`, `validFrom`, `validTo`) are `YYYY-MM-DD`; instants are ISO
datetimes. A credential is valid through the END of its `expiresAt` day in the job's time zone. None of
these records hold performance data (§10.3).

Private fields: a credential `number` is returned in full only to the holder and to callers who hold
`qualifications.approve` over the employee (HR, Owner); everyone else with `qualifications.view` gets it masked
(`\u2022\u2022\u2022\u20221234`, last four characters). Availability `note` is returned only to the same two groups
(others get `null`). The audit log never stores a number in clear (masked likewise).

Statuses (`PENDING_VERIFICATION`, `VERIFIED`, `REJECTED`, `REVOKED`) follow `src/lib/qualification-lifecycle.ts`;
only `VERIFIED`, unexpired rows count for eligibility.

### GET /api/v1/qualifications

- **Purpose**: employees' skills and credentials in the caller's scope, newest first.
- **Auth**: session. **Permission**: `qualifications.view`, scoped in the query.
- **Request query**: `cursor`, `limit`; filters `employeeId`, `kind` (`SKILL|CERTIFICATION|LICENSE|EQUIPMENT|TRAINING`),
  `status`, `skillId`, `certificationId`.
- **Response**: `200 { data: [qualification], page }`; qualification = `{ id, employeeId, kind, skillId,
  certificationId, level, number, issuingAuthority, issuedAt, expiresAt, status, verifiedById, verifiedAt,
  notes, createdAt, updatedAt }`.
- **Audit**: none.

### POST /api/v1/qualifications

- **Purpose**: record a skill or credential; it starts `PENDING_VERIFICATION`.
- **Auth**: session. **Permission**: `qualifications.create` over the employee.
- **Request body** (strict): `employeeId`; exactly one of `skillId` / `certificationId`; `level` 1-5 (skills
  only); `number`, `issuingAuthority`, `issuedAt`, `expiresAt` (after `issuedAt`), `notes`. A certification with
  `requiresNumber` needs `number`. `kind` is taken from the catalog entry.
- **Idempotency**: honoured.
- **Response**: `201 { data: qualification }`.
- **Errors**: `404`; `400` unknown or retired catalog entry; `409 CONFLICT` the employee already has that skill;
  `409 INVALID_STATE_TRANSITION` terminated employee.
- **Audit**: `qualification.create`.

### GET /api/v1/qualifications/{id}

- **Purpose**: one record. **Auth**: session. **Permission**: `qualifications.view` over the holder.
- **Response**: `200 { data: qualification }`. **Errors**: `404`.
- **Audit**: none.

### PATCH /api/v1/qualifications/{id}

- **Purpose**: change the facts of a record. A change to `level`, `number`, `issuingAuthority`, `issuedAt` or
  `expiresAt` of a `VERIFIED` row, or any edit of a `REJECTED` / `REVOKED` row (a resubmission), returns it to
  `PENDING_VERIFICATION` and clears the verifier. Editing `notes` alone keeps the verification.
- **Auth**: session. **Permission**: `qualifications.edit` over the holder.
- **Request body** (strict, at least one key, nullable to clear): `level`, `number`, `issuingAuthority`, `issuedAt`,
  `expiresAt`, `notes`.
- **Response**: `200 { data: qualification }`.
- **Errors**: `404`; `400` (`level` on a credential, number required, expiry not after issue date); `409
  INVALID_STATE_TRANSITION` terminated employee.
- **Audit**: `qualification.update` (changed fields; includes the status change when it reverted).

### POST /api/v1/qualifications/{id}/verify

- **Purpose**: HR confirms the record: `PENDING_VERIFICATION` to `VERIFIED`, recording verifier and time.
- **Auth**: session. **Permission**: `qualifications.approve` over the holder (HR, Owner; not managers).
- **Response**: `200 { data: qualification }`.
- **Errors**: `403` your own record; `404`; `409 INVALID_STATE_TRANSITION`; `400` number missing or already expired.
- **Audit**: `qualification.verify` (previous and new status).

### POST /api/v1/qualifications/{id}/reject

- **Purpose**: `PENDING_VERIFICATION` to `REJECTED`. **Auth**: session. **Permission**: `qualifications.approve`.
- **Request body** (strict): `reason` string 1-500 (required).
- **Response**: `200 { data: qualification }`. **Errors**: as `verify`.
- **Audit**: `qualification.reject` (`reason`).

### POST /api/v1/qualifications/{id}/revoke

- **Purpose**: `VERIFIED` to `REVOKED` (the authority withdrew it, or it was found invalid).
  **Auth**: session. **Permission**: `qualifications.approve`.
- **Request body** (strict): `reason` string 1-500 (required).
- **Response**: `200 { data: qualification }`. **Errors**: as `verify`.
- **Audit**: `qualification.revoke` (`reason`).

### GET /api/v1/qualifications/skills

- **Purpose**: the skill catalog, by name. Company-wide reference data. **Auth**: session.
  **Permission**: any `qualifications.view` grant.
- **Request query**: `cursor`, `limit`, `active` (`true|false`).
- **Response**: `200 { data: [{ id, code, name, category, description, active, createdAt, updatedAt }], page }`.
- **Audit**: none.

### POST /api/v1/qualifications/skills

- **Purpose**: add a skill. **Auth**: session. **Permission**: `qualifications.manage` with a TENANT scope.
- **Request body** (strict): `code` (`^[a-z0-9][a-z0-9_-]{0,62}$`), `name`, `category?`, `description?`.
- **Idempotency**: honoured. **Response**: `201 { data: skill }`.
- **Errors**: `403`; `409 CONFLICT` code exists.
- **Audit**: `skill.create`.

### PATCH /api/v1/qualifications/skills/{id}

- **Purpose**: edit or retire (`active: false`) a skill; entries are never deleted. **Auth**: session.
  **Permission**: `qualifications.manage` (TENANT).
- **Request body** (strict, at least one key): `name`, `category`, `description`, `active`.
- **Response**: `200 { data: skill }`. **Errors**: `403`; `404`.
- **Audit**: `skill.update`.

### GET /api/v1/qualifications/certifications

- **Purpose**: the credential catalog (certifications, licenses, equipment qualifications, training).
  **Auth**: session. **Permission**: any `qualifications.view` grant.
- **Request query**: `cursor`, `limit`, `active`, `type` (`CERTIFICATION|LICENSE|EQUIPMENT|TRAINING`).
- **Response**: `200 { data: [{ id, code, name, type, issuingAuthority, validityMonths, requiresNumber,
  description, active, createdAt, updatedAt }], page }`.
- **Audit**: none.

### POST /api/v1/qualifications/certifications

- **Purpose**: add a credential type. **Auth**: session. **Permission**: `qualifications.manage` (TENANT).
- **Request body** (strict): `code`, `name`, `type` (default `CERTIFICATION`), `issuingAuthority?`,
  `validityMonths?` (1-600), `requiresNumber` (default false), `description?`.
- **Idempotency**: honoured. **Response**: `201 { data: certification }`. **Errors**: `403`; `409 CONFLICT`.
- **Audit**: `certification.create`.

### PATCH /api/v1/qualifications/certifications/{id}

- **Purpose**: edit or retire a credential type (`code` and `type` are fixed). **Auth**: session.
  **Permission**: `qualifications.manage` (TENANT).
- **Request body** (strict, at least one key): `name`, `issuingAuthority`, `validityMonths`, `requiresNumber`,
  `description`, `active`.
- **Response**: `200 { data: certification }`. **Errors**: `403`; `404`.
- **Audit**: `certification.update`.

### GET /api/v1/qualifications/territories

- **Purpose**: the employee's service territories (org units they may be dispatched into), oldest first.
  **Auth**: session. **Permission**: `qualifications.view` over the employee.
- **Request query**: `employeeId` (required), `activeOnly`, `cursor`, `limit`.
- **Response**: `200 { data: [{ id, employeeId, orgUnitId, includeDescendants, effectiveFrom, effectiveTo,
  createdAt }], page }`.
- **Audit**: none.

### POST /api/v1/qualifications/territories

- **Purpose**: add a territory. Re-adding an ended one reopens that row (the audit event keeps the earlier period).
- **Auth**: session. **Permission**: `qualifications.edit` over the employee AND over the org unit.
- **Request body** (strict): `employeeId`, `orgUnitId`, `includeDescendants` (default true), `effectiveFrom?`.
- **Response**: `201 { data: territory }`.
- **Errors**: `404`; `409 CONFLICT` already a territory; `409 INVALID_STATE_TRANSITION` archived unit or terminated employee.
- **Audit**: `service_territory.add`.

### POST /api/v1/qualifications/territories/{id}/end

- **Purpose**: end the territory now (a not-yet-started one is cancelled). **Auth**: session.
  **Permission**: `qualifications.edit` over the employee.
- **Request body** (strict): `reason?`. **Response**: `200 { data: territory }`.
- **Errors**: `404`; `409 INVALID_STATE_TRANSITION` already ended.
- **Audit**: `service_territory.end`.

### GET /api/v1/qualifications/job-permissions

- **Purpose**: the employee's job-category permissions (a job type OR a category, for a period).
  **Auth**: session. **Permission**: `qualifications.view` over the employee.
- **Request query**: `employeeId` (required), `activeOnly`, `cursor`, `limit`.
- **Response**: `200 { data: [{ id, employeeId, jobTypeId, category, effectiveFrom, effectiveTo, grantedById,
  reason, createdAt }], page }`.
- **Audit**: none.

### POST /api/v1/qualifications/job-permissions

- **Purpose**: authorize an employee for a job type or category. A matching permission in force is a hard
  requirement of eligibility. **Auth**: session. **Permission**: `qualifications.approve` over the employee
  (an authorization decision: HR / Owner, not managers).
- **Request body** (strict): `employeeId`; exactly one of `jobTypeId` / `category`; `effectiveFrom?`,
  `effectiveTo?` (after `effectiveFrom`), `reason?`.
- **Response**: `201 { data: permission }`.
- **Errors**: `404`; `400` unknown or retired job type; `409 INVALID_STATE_TRANSITION` terminated employee.
- **Audit**: `job_permission.grant`.

### POST /api/v1/qualifications/job-permissions/{id}/end

- **Purpose**: end the permission now. **Auth**: session. **Permission**: `qualifications.approve`.
- **Request body** (strict): `reason?`. **Response**: `200 { data: permission }`.
- **Errors**: `404`; `409 INVALID_STATE_TRANSITION` already ended.
- **Audit**: `job_permission.end`.

### GET /api/v1/qualifications/availability

- **Purpose**: the employee's availability rows: weekly windows (by day and start) then exceptions.
  **Auth**: session. **Permission**: `qualifications.view` over the employee.
- **Request query**: `employeeId` (required), `activeOnly`, `cursor`, `limit`.
- **Response**: `200 { data: [{ id, employeeId, kind, timeZone, isoDayOfWeek, startMinute, endMinute, validFrom,
  validTo, startsAt, endsAt, note, createdAt, updatedAt }], page }`.
- **Audit**: none.

### POST /api/v1/qualifications/availability

- **Purpose**: add a recurring weekly window or a dated exception. Windows are read in `timeZone` (default: the
  employee's login zone, else their branch's, else the company's) per local date, DST included. They cannot cross
  midnight: a night shift is two windows (Mon 1320-1440, Tue 0-360). Exceptions beat weekly windows;
  `EXCEPTION_UNAVAILABLE` (time off) blocks, `EXCEPTION_AVAILABLE` adds hours.
- **Auth**: session. **Permission**: `qualifications.edit` over the employee.
- **Request body** (strict, by `kind`): `WEEKLY_WINDOW`: `employeeId`, `isoDayOfWeek` 1-7 (Monday = 1),
  `startMinute` 0-1439, `endMinute` 1-1440 (after start), `validFrom?`, `validTo?`, `timeZone?`, `note?`;
  `EXCEPTION_AVAILABLE` / `EXCEPTION_UNAVAILABLE`: `employeeId`, `startsAt`, `endsAt` (after start), `timeZone?`, `note?`.
- **Response**: `201 { data: availability }`.
- **Errors**: `404`; `400`; `409 INVALID_STATE_TRANSITION` terminated employee.
- **Audit**: `availability.create`.

### DELETE /api/v1/qualifications/availability/{id}

- **Purpose**: remove a window or exception. Schedule data is deleted rather than ended (the audit event keeps
  what it said). **Auth**: session. **Permission**: `qualifications.edit` over the employee.
- **Response**: `204`. **Errors**: `404`.
- **Audit**: `availability.delete` (previous value).

### GET /api/v1/qualifications/expiring

- **Purpose**: `VERIFIED` records of active employees expiring within `withinDays` (default: the company's
  `qualificationWarningDays`, 30), soonest first; today's date is the company's. Drives HR's "expiring soon" list
  and the notification engine.
- **Auth**: session. **Permission**: `qualifications.view`, scoped in the query.
- **Request query**: `withinDays` 1-730, `includeExpired` (`true|false`: also records already past their date),
  `cursor`, `limit`.
- **Response**: `200 { data: [{ qualificationId, employeeId, userId, kind, skillId, certificationId, name,
  expiresOn, daysRemaining }], page }`; `daysRemaining` 0 = expires today, negative = already expired.
- **Audit**: none.

### POST /api/v1/qualifications/eligibility

- **Purpose**: may this employee do this job type here and then? A read (nothing is stored); POST because the
  requirements are a body. Checks, in order: employment, required skills (verified, unexpired by the end of the
  window, minimum level), required credentials, job-category permission, service territory, availability for the
  whole window. Every failing rule is reported. `UNAVAILABLE_TIME_OFF` carries no params: only that the time is
  blocked, never when or why. A territory on an archived unit does not cover. Status gate: `TERMINATED` always
  fails; `ON_LEAVE` fails only for work starting now or earlier (future leave is an `EXCEPTION_UNAVAILABLE` row).
- **Auth**: session. **Permission**: `qualifications.view` over the employee.
- **Request body** (strict): `employeeId`, `jobTypeId` (required); `orgUnitId?` (service area; omit to skip the
  territory rule); `extraSkills?` `[{ skillId, minLevel? }]`, `extraCertificationIds?` (on top of the type's);
  `startsAt` + `endsAt` (both or neither; omit to skip availability); `timeZone?` (default the unit's, else the
  company's).
- **Response**: `200 { data: { employeeId, timeZone, eligible, failures: [{ code, params }], checked: {
  availability, territory, jobPermission } } }`. `code` is one of `EMPLOYEE_NOT_ACTIVE`, `EMPLOYEE_NOT_EMPLOYED`,
  `QUALIFICATION_MISSING`, `QUALIFICATION_NOT_VERIFIED`, `QUALIFICATION_EXPIRED`, `QUALIFICATION_RENEWAL_PENDING` (expired, but a still-valid renewal awaits verification), `SKILL_LEVEL_TOO_LOW`,
  `JOB_PERMISSION_MISSING`, `OUTSIDE_TERRITORY`, `UNAVAILABLE_TIME_OFF`, `UNAVAILABLE_OUTSIDE_HOURS`; clients
  translate with the key `QUALIFICATION.FAILURE.<code>` and the params (a `kind` param via
  `QUALIFICATION.KIND.<kind>`). No prose is returned.
- **Errors**: `404`; `400` unknown job type, skill, certification or unit (`field` names it).
## Notifications (`/api/v1/notifications`, Phase 2)

Own-notification API (§14). Every endpoint is pinned to the caller (`recipientId = session user`): the
`notifications.view` / `notifications.edit` permissions are capability checks and the assignment's scope never widens
them. Responses carry `templateKey` + `params` (ids and numbers), never display text: render the title and body with
`<templateKey>.TITLE` / `.BODY` in the user's language (`renderNotification` on the server, `t()` in the UI).

### GET /api/v1/notifications

- **Purpose**: the caller's own notifications, newest first (`createdAt desc, id desc`).
- **Auth**: session.
- **Permission**: `notifications.view` (capability; rows are always the caller's own).
- **Request query**: `cursor`, `limit` (collection rules); `unread` `true | false` (default `false`: all).
- **Response**: `200 { data: [{ id, eventType, templateKey, params, targetType, targetId, critical, readAt, createdAt, redacted }], page }`.
  `targetType`/`targetId` are a deep link only. The viewer's current access to the target is re-checked on every read: when lost
  (or the record is gone), the row has `redacted: true`, `templateKey` `NOTIFICATION.ITEM_UNAVAILABLE`, empty `params` and no target.
- **Errors**: `403` no `notifications.view` grant; `400` bad query.
- **Audit**: none.

### GET /api/v1/notifications/unread-count

- **Purpose**: the number of unread notifications (the bell badge).
- **Auth**: session.
- **Permission**: `notifications.view`.
- **Response**: `200 { data: { unread } }`.
- **Audit**: none.

### POST /api/v1/notifications/read-all

- **Purpose**: mark every unread notification of the caller read.
- **Auth**: session.
- **Permission**: `notifications.edit`.
- **Idempotency**: not needed (repeating it changes nothing).
- **Response**: `200 { data: { updated } }`.
- **Audit**: none (a per-user read marker, not a business change).

### POST /api/v1/notifications/{id}/read

- **Purpose**: mark one of the caller's notifications read. An already-read notification keeps its first `readAt`.
- **Auth**: session.
- **Permission**: `notifications.edit`.
- **Request**: path `id`.
- **Response**: `200 { data: { id, readAt } }`.
- **Errors**: `404` the notification does not exist, belongs to another user or tenant (indistinguishable).
- **Audit**: none.

### GET /api/v1/notifications/preferences

- **Purpose**: the caller's stored channel opt-ins and opt-outs. An absent row means "enabled".
- **Auth**: session.
- **Permission**: `notifications.view`.
- **Response**: `200 { data: [{ eventType, channel, enabled }] }`; `eventType` is an event key or `*`.
- **Audit**: none.

### PUT /api/v1/notifications/preferences

- **Purpose**: opt in or out of one channel for one event type, or for every non-critical event (`*`).
- **Auth**: session.
- **Permission**: `notifications.edit`.
- **Request body** (strict): `eventType` a known event key (`NOTIFICATION_EVENTS`) or `*`; `channel` `PUSH | EMAIL | SMS`
  (in-app cannot be switched off); `enabled` boolean.
- **Response**: `200 { data: { eventType, channel, enabled } }`.
- **Errors**: `400` unknown event, `IN_APP`, or a critical event (`field: "eventType"`): critical notifications ignore
  opt-outs (§14.1), so a preference for them is refused instead of stored and ignored.
- **Audit**: none.
## Customers (`/api/v1/customers`) - Phase 2

Code: `src/server/customers` (README there), routes `src/app/api/v1/customers/**`. Design decisions:
`DECISIONS.md` "Phase 2 Task 2".

Customer fields: `id, number, kind (INDIVIDUAL | BUSINESS), name, email, phone, phoneE164,
preferredLocale (en-US | es-US | he-IL), preferredContactChannel (PHONE | SMS | EMAIL | IN_PERSON | CHAT |
OTHER), contactPreferences (object), doNotContact, orgUnitId, archivedAt, createdById, createdAt, updatedAt` are
`base`; `billingName, billingEmail, billingAddress (object), taxId, paymentTerms` are the opt-in `billing`
set (`customers.billing_fields`: a grant must name it, Owner/CEO and Finance do). Single-customer reads add
`addresses` (active service addresses, primary first). `phone` is stored as typed; `phoneE164` is the
normalized match/search key (a number without `+` is read as US/Canada, 10 or 11 digits; anything else must
use the international form, else `400 field: "phone"`). `orgUnitId` is the service-area unit that drives
ORG_UNIT scope; a customer without one is tenant-level.

Data scope: `ORG_UNIT` / `LEGAL_ENTITY` follow `orgUnitId`; `ASSIGNED` means a lead or job of the customer is
assigned to the caller (directly, or through a team assignment to a team the caller belongs to); `OWN` matches
nothing. A grant qualified by a record set covers only customers of the set: `job_related` (has a job),
`lead_related` (has a lead or a recovery case). Outside the scope a customer is `404`, never `403`.

### GET /api/v1/customers

- **Purpose**: list customers, ordered by name then id.
- **Auth**: session.
- **Permission**: `customers.view`, capability; scope in the query; each row projected with the field sets of
  the grants that cover that row (billing never leaks across rows).
- **Request query**: `cursor`, `limit`; `q` 1-100 (name or email substring, partial phone digits, or `#number`);
  `archived` `exclude` (default) | `include` | `only`; `orgUnitId`; `kind`; `preferredLocale`. Search and
  filters only match rows the caller sees with the `base` set (a billing-only grant such as Finance gets no
  rows from a filtered query), and such a page can hold fewer rows than `limit`.
- **Response**: `200 { data: [customer], page }`. List rows carry no `addresses`.
- **Errors**: `400` bad query.
- **Audit**: none.

### POST /api/v1/customers

- **Purpose**: create a customer, optionally with service addresses (the first becomes the primary), and
  flag possible duplicates (never blocks, never merges).
- **Auth**: session.
- **Permission**: `customers.create` over `orgUnitId` (without a unit the customer is tenant-level and a
  tenant-wide grant is required, else `403`); each address `orgUnitId` is checked the same way. The grant must
  name the billing set to write billing fields. A set-qualified create grant (Lead Operations) is judged as if
  the new customer belongs to every set.
- **Request body** (strict): `name` 1-200 (required); `kind` (default `INDIVIDUAL`); `email` (trimmed,
  lower-cased) or null; `phone` or null; `preferredLocale`; `preferredContactChannel`; `contactPreferences`
  object (4000 chars at most); `doNotContact` (default false); `orgUnitId`; billing fields; `addresses` (up
  to 20): `{ label?, line1, line2?, city, region, postalCode, countryCode (default US), latitude?, longitude?
  (together; entered, never geocoded), accessInstructions?, isPrimary?, orgUnitId? }`.
- **Idempotency**: supported.
- **Response**: `201 { data: customer + possibleDuplicates: [{ flagId, customerId, matchedOn: [PHONE | EMAIL |
  ADDRESS | NAME] }] }`. Only duplicates whose other customer the caller may view are listed; a duplicate in
  someone else's scope is flagged for them but not revealed here. The customer is projected to what the
  caller may view after the write (`{ id }` if nothing).
- **Errors**: `403`; `404` unit missing or outside scope; `409 INVALID_STATE_TRANSITION` unit archived; `400`.
- **Audit**: `customer.create` (billing values are never copied into audit); `customer.duplicate_flag` per new flag.

### GET /api/v1/customers/{id}

- **Purpose**: one customer with its active addresses.
- **Auth**: session. **Permission**: `customers.view` over the customer.
- **Response**: `200 { data: customer }` projected to the grant. **Errors**: `404`. **Audit**: none.

### PATCH /api/v1/customers/{id}

- **Purpose**: partial update (strict, at least one key; same fields and formats as create, minus
  `addresses`).
- **Auth**: session.
- **Permission**: `customers.edit` over the customer and the field set of every key sent (billing keys need
  the billing grant, else `403`). Moving `orgUnitId` needs the permission over the destination too; clearing it
  needs a tenant-wide grant.
- **Response**: `200 { data: customer [+ possibleDuplicates when name, email or phone changed] }`; an unchanged
  patch returns the record without audit.
- **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` the customer is archived (restore first).
- **Audit**: `customer.update` (changed fields; billing columns by name only: `billingFieldsChanged`).

### POST /api/v1/customers/{id}/archive

- **Purpose**: soft remove (nothing is deleted; leads, jobs and history keep pointing at it).
- **Auth**: session. **Permission**: `customers.archive` over the customer.
- **Request body** (optional, strict): `reason` 1-500.
- **Response**: `200 { data: customer }`. **Errors**: `403`; `404`; `409` already archived.
- **Audit**: `customer.archive` (`reason`).

### POST /api/v1/customers/{id}/restore

- **Purpose**: bring an archived customer back (re-runs duplicate detection).
- **Auth**: session. **Permission**: `customers.archive` over the customer. **Request body**: as archive.
- **Response**: `200 { data: customer }`. **Errors**: `403`; `404`; `409` not archived.
- **Audit**: `customer.restore`.

### GET /api/v1/customers/{id}/addresses

- **Purpose**: service addresses, primary first.
- **Auth**: session. **Permission**: `customers.view` over the customer.
- **Request query**: `includeArchived` `true | false` (default false).
- **Response**: `200 { data: [address] }`; address = `{ id, customerId, label, line1, line2, city, region,
  postalCode, countryCode, latitude, longitude (numbers or null), coordinateSource, accessInstructions,
  isPrimary, orgUnitId, archivedAt, createdAt, updatedAt }`. **Errors**: `404`. **Audit**: none.

### POST /api/v1/customers/{id}/addresses

- **Purpose**: add a service address (same body as one entry of `addresses` on create).
- **Auth**: session. **Permission**: `customers.edit` over the customer with the `base` set (and over the
  address's own `orgUnitId`).
- **Response**: `201 { data: { address, possibleDuplicates } }`. **Errors**: `403`; `404`; `409` unit archived.
- **Audit**: `customer.address_add`.

### PATCH /api/v1/customers/{id}/addresses/{addressId}

- **Purpose**: partial update of one address (strict, at least one key). `isPrimary: true` moves the primary
  flag; `false` on the primary is `400` (make another primary instead). The duplicate-matching key is
  recomputed.
- **Auth**: session. **Permission**: as add.
- **Response**: `200 { data: { address, possibleDuplicates } }`. **Errors**: `403`; `404`;
  `409 INVALID_STATE_TRANSITION` the address is archived; `400` unpaired coordinates.
- **Audit**: `customer.address_update` (changed fields).

### POST /api/v1/customers/{id}/addresses/{addressId}/archive

- **Purpose**: soft remove an address (jobs keep pointing at it); the oldest remaining active address becomes
  primary when the primary was archived.
- **Auth**: session. **Permission**: as add. **Response**: `200 { data: address }`.
  **Errors**: `404`; `409` already archived. **Audit**: `customer.address_archive`.

### GET /api/v1/customers/{id}/notes

- **Purpose**: notes, newest first. **Auth**: session. **Permission**: `customers.view` over the customer.
- **Request query**: `cursor`, `limit`. **Response**: `200 { data: [{ id, customerId, authorId, body, createdAt }], page }`.
- **Errors**: `404`. **Audit**: none.

### POST /api/v1/customers/{id}/notes

- **Purpose**: append a note authored by the caller. Notes are not edited or deleted; a correction is a new note.
- **Auth**: session. **Permission**: `customers.edit` over the customer with the `base` set.
- **Request body** (strict): `body` 1-4000. **Response**: `201 { data: note }`. **Errors**: `403`; `404`.
- **Audit**: `customer.note_add` (note id only).

### GET /api/v1/customers/{id}/history

- **Purpose**: the customer's leads and jobs (service history, §5.9).
- **Auth**: session.
- **Permission**: `customers.view` over the customer. Leads are shown only if the caller may view them
  (`leads.view` scope); jobs only if the caller may view them (`jobs.view` scope, where a grant qualified
  `customer_history` counts: Customer Relations). Money fields are never selected.
- **Request query**: `limit` 1-200 (default 50; applied to leads and jobs separately, newest first).
- **Response**: `200 { data: { leads: [entry], jobs: [entry], access: { leads, jobs } } }`; entry = `{ id,
  number, status, createdAt, archivedAt }`; `access.*` is false when the caller holds no such permission
  (an empty list then means "hidden", not "none"). **Errors**: `404`. **Audit**: none.

### GET /api/v1/customers/{id}/employee-preferences

- **Purpose**: preferred / avoided employees (a soft dispatch factor, never an eligibility rule).
- **Auth**: session. **Permission**: `customers.view` over the customer.
- **Response**: `200 { data: [{ employeeId, kind (PREFERRED | AVOID), note, createdAt }] }`. **Errors**: `404`.

### PUT /api/v1/customers/{id}/employee-preferences

- **Purpose**: replace the whole preference list.
- **Auth**: session. **Permission**: `customers.edit` over the customer with the `base` set.
- **Request body** (strict): `preferences` (up to 50) of `{ employeeId, kind, note? }`, an employee at most once;
  new entries must be existing, non-terminated employees (`400 field: "preferences"`).
- **Response**: `200 { data: [preference] }`. **Errors**: `403`; `404`; `400`. **Audit**: `customer.preferences_set`.

### GET /api/v1/customers/duplicates

- **Purpose**: the duplicate review queue, newest detection first.
- **Auth**: session.
- **Permission**: `customers.view`; a flag is listed only when the caller may view BOTH customers of the pair
  (otherwise the queue would reveal customers outside the scope).
- **Request query**: `cursor`, `limit`; `status` `OPEN` (default) | `NOT_DUPLICATE` | `CONFIRMED_DUPLICATE`;
  `customerId` (flags involving this customer).
- **Response**: `200 { data: [{ id, customerId, otherCustomerId, matchedOn, reason, status, detectedAt,
  resolvedAt, resolvedById, resolutionNote }], page }`. **Audit**: none.

### POST /api/v1/customers/duplicates/{flagId}/resolve

- **Purpose**: record a human decision. `NOT_DUPLICATE` keeps the pair from ever being flagged again;
  `CONFIRMED_DUPLICATE` records that they are the same party. Nothing is merged. A decision can be changed to
  the other one; repeating the current one is `409`.
- **Auth**: session. **Permission**: `customers.edit` over BOTH customers.
- **Request body** (strict): `resolution` (required), `note` 1-500.
- **Response**: `200 { data: flag }`. **Errors**: `403`; `404` (flag missing or either customer out of scope);
  `409 INVALID_STATE_TRANSITION` same resolution; `409 CONFLICT` changed concurrently.
- **Audit**: `customer.duplicate_resolve` (previous and new status, `reason`).

### GET /api/v1/customers/duplicate-matchers

- **Purpose**: which matchers run on create/update. **Auth**: session. **Permission**: `customers.view`.
- **Response**: `200 { data: { matchers: { phone, email, address, name }, isDefault } }`. Defaults: phone, email
  and address on, name off.

### PUT /api/v1/customers/duplicate-matchers

- **Purpose**: replace the configuration (only future detection is affected).
- **Auth**: session. **Permission**: `customers.manage` with a TENANT scope (`403` otherwise).
- **Request body** (strict): `phone`, `email`, `address`, `name`, all booleans, all required.
- **Response**: `200 { data: { matchers, isDefault: false } }`. **Audit**: `customer.duplicate_matchers_update`.

## Leads (`/api/v1/leads`) - Phase 2

Code: `src/server/leads` (README there), routes `src/app/api/v1/leads/**`, status machine `src/lib/lead-lifecycle.ts`.
Design decisions: `DECISIONS.md` "Phase 2 Task 5".

Lead fields (all `base`; leads have no sensitive set): `id, number, status, statusChangedAt, priority (LOW | NORMAL | HIGH |
URGENT), sourceId, campaign, externalId, customerId, contactName, contactPhone, contactPhoneE164, contactEmail,
customerAddressId, addressLine1, addressLine2, addressCity, addressRegion, addressPostalCode, addressNormalizedKey, jobTypeId,
serviceCategory, requestedWork, preferredWindowStart, preferredWindowEnd, preferredTimeNote, notes, quotedAmountMinor (integer
minor units), currency, orgUnitId, nextFollowUpAt, duplicateOfLeadId, closedReason, archivedAt, createdById, createdAt,
updatedAt`, plus `assignedEmployeeId` (the current owner: the ACTIVE assignment) and, on a single lead, `nextStatuses` (what the
status action accepts now).

Statuses (§6.3): `NEW, UNASSIGNED, ASSIGNED, CONTACT_ATTEMPTED, CONTACTED, QUALIFIED, SCHEDULED, DISPATCHED, CONVERTED, LOST,
DUPLICATE, CANCELLED`. Default path NEW -> ASSIGNED -> CONTACT_ATTEMPTED -> CONTACTED -> QUALIFIED -> SCHEDULED -> DISPATCHED ->
CONVERTED; LOST / DUPLICATE / CANCELLED close a lead (LOST and DUPLICATE can be reopened to UNASSIGNED, CONVERTED and CANCELLED are
final). A tenant can switch off optional transitions (`OperationsSettings.disabledLeadTransitions`), never add any. Every change
writes a history row (previous, new, who, when, reason).

Data scope: `ORG_UNIT` / `LEGAL_ENTITY` follow `orgUnitId` (a lead without a unit is tenant-level); `ASSIGNED` means the caller is the
lead's current owner; `OWN` matches nothing. A grant qualified by the record set `dispatch_related` (Dispatcher) covers only leads
that reached dispatch (`QUALIFIED, SCHEDULED, DISPATCHED, CONVERTED`). Outside the scope a lead is `404`, never `403`.

### GET /api/v1/leads

- **Purpose**: list leads, newest first (then id).
- **Auth**: session. **Permission**: `leads.view`, capability; scope in the query; each row projected with its grants' field sets.
- **Request query**: `cursor`, `limit`; `q` 1-100 (contact name or email substring, partial phone digits, or `#number`); `status`;
  `priority`; `sourceId`; `orgUnitId`; `customerId`; `assigned` `true` | `false` (has an owner); `assigneeEmployeeId` (an id or `me`);
  `followUpDue` `true` (follow-up date passed, lead still open); `archived` `exclude` (default) | `include` | `only`.
- **Response**: `200 { data: [lead], page }`. **Errors**: `400` bad query. **Audit**: none.

### POST /api/v1/leads

- **Purpose**: lead intake (manual entry, API, webhook, import). Creates a `NEW` lead and flags possible duplicates (never blocks,
  never merges). Lead Operations of the unit are notified (`lead.needs_owner`).
- **Auth**: session. **Permission**: `leads.create` over `orgUnitId` (no unit = tenant-level lead: a tenant-wide grant is required,
  else `403`; a unit outside the caller's scope is `404`).
- **Request body** (strict): `contactName`, `contactPhone`, `contactEmail` (at least one of these or `customerId`), address as
  received (`addressLine1`, `addressLine2`, `addressCity`, `addressRegion`, `addressPostalCode`; may be incomplete), `priority`
  (default `NORMAL`), `campaign`, `serviceCategory`, `requestedWork`, `jobTypeId`, `preferredWindowStart/End`, `preferredTimeNote`,
  `notes`, `quotedAmountMinor`, `currency` (default `USD`), `orgUnitId`, `nextFollowUpAt`; `sourceId` or `sourceCode` (not both),
  `externalId` (needs a source); `customerId` and `customerAddressId` for a known customer.
- **Idempotency**: supported (`Idempotency-Key`), and `(source, externalId)` is idempotent too: a repeat answers `200` with the lead
  that already exists (`409` when the caller may not see it).
- **Response**: `201 { data: lead + possibleDuplicates: [{ flagId, kind: LEAD_LEAD | LEAD_CUSTOMER, otherId, matchedOn }] }`; only
  duplicates whose other side the caller may view are listed.
- **Errors**: `400` (unknown source or job type, address of another customer); `403`; `404`; `409 INVALID_STATE_TRANSITION` archived
  customer or unit.
- **Audit**: `lead.create`; `lead.duplicate_flag` per new flag.

### GET /api/v1/leads/{id}

- **Purpose**: one lead with its owner and `nextStatuses`. **Permission**: `leads.view` over the lead. **Response**: `200 { data: lead }`.
  **Errors**: `404`. **Audit**: none.

### PATCH /api/v1/leads/{id}

- **Purpose**: partial update of the lead's content (strict, at least one key; same fields and formats as intake minus source, external
  id, customer link and status).
- **Permission**: `leads.edit` over the lead AND every changed field inside the grant (`assertWritableFields`): a Technician's
  status-only grant changes none of these (`403`). Moving `orgUnitId` needs the permission over the destination too.
- **Response**: `200 { data: lead + possibleDuplicates }` (duplicates re-checked when contact or address changed).
  **Errors**: `400`; `403`; `404`; `409 INVALID_STATE_TRANSITION` closed or archived lead. **Audit**: `lead.update` (changed fields).

### POST /api/v1/leads/{id}/status

- **Purpose**: a validated status change. **Permission**: `leads.edit` over the lead; the grant must allow `status` (and `closedReason`
  when `reason` is sent, `duplicateOfLeadId` for DUPLICATE: a Technician's grant allows `status` and `closedReason` only).
- **Request body** (strict): `status` (required), `reason` 1-500 (required for `LOST` and `CANCELLED`), `duplicateOfLeadId` (required
  for `DUPLICATE`, a lead the caller may view). `ASSIGNED` (use assign), `CONVERTED` (use convert) and `UNASSIGNED` while someone owns
  the lead (use unassign) are refused with `400 field: "status"`.
- **Response**: `200 { data: lead }`. **Errors**: `400`; `403`; `404`; `409 INVALID_STATE_TRANSITION` (not allowed from the current
  status, or archived); `409 CONFLICT` changed concurrently. **Audit**: `lead.status_change` (+ a `LeadStatusHistory` row). Closing a
  lead ends the owner's assignment.

### GET /api/v1/leads/{id}/history

- **Purpose**: the status history, oldest first. **Permission**: `leads.view`.
- **Response**: `200 { data: [{ id, fromStatus, toStatus, actorType, actorUserId, reason, occurredAt }] }` (the first row has `fromStatus` null).

### POST /api/v1/leads/{id}/assign

- **Purpose**: give the lead to an employee (first assignment or reassignment). A `NEW` / `UNASSIGNED` lead becomes `ASSIGNED`; the new
  owner is notified (`lead.assigned`).
- **Permission**: `leads.assign` over the lead.
- **Request body** (strict): `employeeId` (required); `reason` 1-500 (required when replacing an owner or confirming a conflict);
  `confirmOpenContactAttempt` (default false); `confirmOutsideServiceArea` (default false).
- **Rules (§25.1)**: the employee must be ACTIVE (not on leave / terminated) with a current placement and an active login, and must be
  able to view the lead once assigned (else `400 field: "employeeId"`). When ANOTHER employee has an open contact attempt on the lead
  the call is `409 CONFLICT field: "confirmOpenContactAttempt"` until repeated with `confirmOpenContactAttempt: true` and a `reason`; the
  confirmation is stored on the assignment (`conflictConfirmed`) and the other person's open attempts are closed (their record stays).
  An employee whose placements are not in the lead's unit, above it or below it gets `400 field: "confirmOutsideServiceArea"` until
  confirmed with a reason.
- **Response**: `200 { data: lead }`. **Errors**: `400`; `403`; `404`; `409` (above, already assigned to this employee, closed or archived
  lead, concurrent change). **Audit**: `lead.assign` (previous and new owner, conflict flags, closed attempt ids, reason).

### POST /api/v1/leads/{id}/unassign

- **Purpose**: release the owner; the lead goes back to `UNASSIGNED`. **Permission**: `leads.assign`.
- **Request body** (strict): `reason` 1-500 (required), `confirmOpenContactAttempt` (needed when any contact attempt is open).
- **Response**: `200 { data: lead }`. **Errors**: `403`; `404`; `409` (no owner to release, open attempt unconfirmed). **Audit**: `lead.unassign`.

### GET /api/v1/leads/{id}/interactions

- **Purpose**: contact attempts, notes, customer messages and follow-ups, newest first. **Permission**: `leads.view`.
- **Request query**: `cursor`, `limit`, `kind`. **Response**: `200 { data: [{ id, leadId, kind, direction, channel, outcome, body, occurredAt,
  closedAt, durationSeconds, followUpAt, authorId, createdAt }], page }`.

### POST /api/v1/leads/{id}/interactions

- **Purpose**: record an interaction. A contact attempt without `outcome` is OPEN (in progress, §25.1) for the tenant's
  `contactAttemptOpenMinutes` (default 30) or until closed; with an outcome it is already finished. A contact attempt moves an
  `ASSIGNED` lead to `CONTACT_ATTEMPTED` (and to `CONTACTED` when `REACHED`).
- **Permission**: `leads.edit` over the lead with a grant that may write the base set (a status-only grant cannot log contact: `403`).
- **Request body** (strict): `kind` `CONTACT_ATTEMPT | NOTE | CUSTOMER_MESSAGE | FOLLOW_UP` (required); `channel` (required for an
  attempt); `outcome` (attempts only); `body` (required for a note); `direction`; `occurredAt` (not in the future); `durationSeconds`;
  `followUpAt` (required for FOLLOW_UP; sets `nextFollowUpAt`). A `REACHED` / `DECLINED` / `WRONG_NUMBER` outcome clears the follow-up date.
- **Idempotency**: supported. **Response**: `201 { data: interaction }`. **Errors**: `400`; `403`; `404`; `409` archived lead, or a closed lead
  for attempts and follow-ups. **Audit**: `lead.interaction_create` (no body text).

### POST /api/v1/leads/{id}/interactions/{interactionId}/close

- **Purpose**: finish an open contact attempt. **Permission**: `leads.edit` (base set).
- **Request body** (strict): `outcome` (required), `durationSeconds`, `body`, `followUpAt`. **Response**: `200 { data: interaction }`.
  **Errors**: `404`; `409 INVALID_STATE_TRANSITION` not an attempt or already closed. **Audit**: `lead.interaction_close`.

### POST /api/v1/leads/{id}/link-customer

- **Purpose**: attach the lead to an existing customer and optionally one of its addresses; an OPEN lead-customer duplicate flag of the pair
  becomes `CONFIRMED_DUPLICATE`. **Permission**: `leads.edit` (base set) and `customers.view` over the customer.
- **Request body** (strict): `customerId` (required), `customerAddressId`. **Response**: `200 { data: lead }`. **Errors**: `400`; `404`;
  `409` archived customer, closed or archived lead. **Audit**: `lead.link_customer`.

### POST /api/v1/leads/{id}/convert

- **Purpose**: create the job and mark the lead `CONVERTED` in one transaction (the lead's owner assignment ends).
- **Permission**: `leads.view` over the lead AND `jobs.create` over its service area (`403` without it: Lead Operations hands over; Dispatcher
  and unit managers convert). Allowed from `QUALIFIED`, `SCHEDULED`, `DISPATCHED`.
- **Request body** (strict, all optional; omitted values come from the lead): `customerId`, `serviceAddressId`, `jobTypeId`, `description`,
  `priority`, `appointmentWindowStart` + `appointmentWindowEnd` (together).
- **Idempotency**: supported; converting an already converted lead returns its job (`replayed: true`).
- **Response**: `200 { data: { leadId, status: "CONVERTED", job: { id, number }, created, replayed, warnings } }` (`created: false` on a replay; `warnings` are the jobs module's soft warnings). **Errors**: `400` (customer, service address or
  job type missing, unknown job type); `403`; `404`; `409` (archived customer, status not convertible, archived lead). **Audit**: `lead.convert`,
  `lead.status_change`.

### POST /api/v1/leads/{id}/archive

- **Purpose**: soft remove (body optional `{ reason? }`); ends the owner's assignment. **Permission**: `leads.archive`. **Response**: `200`.
  **Errors**: `404`; `409` already archived. **Audit**: `lead.archive`.

### POST /api/v1/leads/{id}/restore

- **Purpose**: bring an archived lead back (assign it again). **Permission**: `leads.archive`. **Response**: `200`. **Errors**: `404`; `409` not
  archived. **Audit**: `lead.restore`.

### GET /api/v1/leads/duplicates

- **Purpose**: the lead duplicate review queue, newest detection first. **Permission**: `leads.view`; a flag is listed only when the caller may
  view the lead AND its other side (the other lead, or the customer).
- **Request query**: `cursor`, `limit`, `status` `OPEN` (default) | `NOT_DUPLICATE` | `CONFIRMED_DUPLICATE`, `leadId`.
- **Response**: `200 { data: [{ id, kind, leadId, otherLeadId, customerId, matchedOn, reason, status, detectedAt, resolvedAt, resolvedById,
  resolutionNote }], page }`. For `LEAD_LEAD` the two ids are in sorted order; for `LEAD_CUSTOMER` `leadId` is the lead.

### POST /api/v1/leads/duplicates/{flagId}/resolve

- **Purpose**: record a human decision (never merges): `NOT_DUPLICATE` keeps the pair from being flagged again, `CONFIRMED_DUPLICATE` records
  that they are the same party (move the lead to `DUPLICATE` with the status action, or link it to the customer). A decision can be changed;
  repeating it is `409`. **Permission**: `leads.edit` over the lead(s) and `customers.view` over the customer.
- **Request body** (strict): `resolution` (required), `note` 1-500. **Response**: `200 { data: flag }`. **Errors**: `403`; `404`; `409`.
  **Audit**: `lead.duplicate_resolve`.

### GET /api/v1/leads/sources

- **Purpose**: the lead sources (`{ id, code, name, type, active, createdAt, updatedAt }`), by name. **Permission**: `leads.view`.

### POST /api/v1/leads/sources

- **Purpose**: add a source. **Permission**: `leads.manage` with a TENANT scope (`403` otherwise).
- **Request body** (strict): `code` (lower-case `[a-z0-9][a-z0-9_-]*`, unique per tenant), `name`, `type` (`MANUAL | PHONE | WEBSITE |
  MARKETING_CAMPAIGN | EXTERNAL_CRM | API | IMPORT | INTEGRATION`). **Response**: `201`. **Errors**: `409` code in use. **Audit**: `lead_source.create`.

### PATCH /api/v1/leads/sources/{sourceId}

- **Purpose**: rename or switch a source on or off (sources are never deleted). **Permission**: `leads.manage` with a TENANT scope.
- **Request body** (strict): `name`, `active`. **Response**: `200`. **Errors**: `404`. **Audit**: `lead_source.update`.

## Jobs (`/api/v1/jobs`) - Phase 2

Code: `src/server/jobs` (README there), pure status machine `src/lib/job-lifecycle.ts`, routes `src/app/api/v1/jobs/**`.
Design decisions: `DECISIONS.md` "Phase 2 Task 6".

Job fields: `id, number, customerId, serviceAddressId, jobTypeId, orgUnitId, leadId, parentJobId, origin (LEAD_CONVERSION |
RECURRING_AGREEMENT | MANUAL | INTEGRATION | CUSTOMER_FOLLOW_UP), status, statusChangedAt, priority (LOW | NORMAL | HIGH | URGENT),
title, description, instructions, appointmentWindowStart/End (customer arrival window), scheduledStartAt/EndAt (the dispatcher's
slot), timeZone, estimatedDurationMinutes, currentVisitNumber, startedAt, completedAt, closedAt, cancelledAt, statusReason, archivedAt, createdById,
createdAt, updatedAt` are `base`; `quotedAmountMinor, currency` are the opt-in `financial` set (`jobs.financial_fields`: a grant
must name it, Owner/CEO, COO and Finance do; Dispatcher and Technician do not). Reads add `assignments` (ACTIVE assignments:
`{ id, employeeId | teamOrgUnitId, role, method, assignedAt }`) and, on a single job, `requirements` (the job's own rows:
`{ skillId | certificationId, minLevel, source: JOB_TYPE | MANUAL }`, copied from the job type at creation). Writes may add
`warnings: [{ code, params }]` (`DURATION_EXCEEDS_WINDOW`, `SLOT_SHORTER_THAN_DURATION`, `ASSIGNEE_ELIGIBILITY_CONFLICT`;
clients translate `JOB.WARNING.<code>`); a warning never blocks the change (§25.2).

Statuses (`JOB.STATUS.<status>`): `CREATED, PENDING_ASSIGNMENT, ASSIGNED, SCHEDULED, EN_ROUTE, ARRIVED, IN_PROGRESS, COMPLETED,
AWAITING_REVIEW, CLOSED, CANCELLED, CUSTOMER_UNAVAILABLE, RESCHEDULED, FAILED, ON_HOLD, REQUIRES_RETURN_VISIT`. The allowed
transitions are `GET /jobs/workflow-settings` (`core` ones always on, `optional` ones a tenant may switch off). A refused
change is `409 INVALID_STATE_TRANSITION` with a message naming why (no such edge, switched off by the company, or a guard).

Data scope: `ORG_UNIT` / `LEGAL_ENTITY` follow `orgUnitId`; `ASSIGNED` = the caller has an ACTIVE assignment, directly or as a
current member of an assigned team; `OWN` matches nothing; record-set grants (`recovery_related`, `customer_history`) do not
apply to these endpoints. Outside the scope a job is `404`, never `403`. Assignment access ends when the job is CLOSED, CANCELLED
or unassigned.

### GET /api/v1/jobs

- **Purpose**: list jobs, newest first (`createdAt desc, id desc`).
- **Auth**: session. **Permission**: `jobs.view`, capability; scope in the query; each row projected with the field sets of the
  grants that cover that row.
- **Request query**: `cursor`, `limit`; `status` (comma-separated list), `priority`, `orgUnitId`, `customerId`, `jobTypeId`,
  `assignedEmployeeId` (direct or through a team), `unassigned` (`true` | `false`), `scheduledFrom` / `scheduledTo` (ISO instants,
  on `scheduledStartAt`), `q` (title substring or `#number`), `archived` `exclude` (default) | `include` | `only`. Filters only
  match rows the caller sees with the `base` set (a financial-only grant such as Finance gets no rows from a filtered query).
- **Response**: `200 { data: [job + assignments], page }`. **Errors**: `400` bad query. **Audit**: none.

### POST /api/v1/jobs

- **Purpose**: create a job by hand (origin `MANUAL` or `CUSTOMER_FOLLOW_UP`). It starts at `PENDING_ASSIGNMENT`
  (history rows `null > CREATED` by the caller and `CREATED > PENDING_ASSIGNMENT` by the system); the job type's skills and
  credentials are copied onto it. Jobs from a lead are created by the leads module (`createJobFromLead`), not here.
- **Auth**: session. **Permission**: `jobs.create` over the service-area unit (the address's unit, else the customer's; an
  explicit `orgUnitId` must lie inside it, and then the caller needs the permission over the customer's unit too). A customer
  with no unit needs a tenant-wide `jobs.create` (`403` otherwise). Money needs the `financial` grant.
- **Request body** (strict): `customerId`, `serviceAddressId` (an active address OF that customer), `jobTypeId` (active) required;
  `orgUnitId`, `origin` (default `MANUAL`), `parentJobId` (a job of the same customer), `title` (default the job type's name),
  `description`, `instructions`, `priority` (default the job type's), `appointmentWindow { start, end }`, `estimatedDurationMinutes`
  5-1440 (default the job type's), `timeZone` (IANA), `quotedAmountMinor` (integer minor units), `currency` (default the
  company's), `additionalRequirements { skills: [{ skillId, minLevel? }], certificationIds }` (§25.2, added to the type's;
  the stricter level wins).
- **Idempotency**: supported (`Idempotency-Key`).
- **Response**: `201 { data: job + assignments + requirements + warnings }`, projected to what the caller may view after the write.
- **Errors**: `403`; `404` customer / address owner / unit outside the scope; `409 INVALID_STATE_TRANSITION` archived customer;
  `400` unknown or archived address, inactive job type, unit outside the customer's, unknown parent or requirement ids.
- **Audit**: `job.create` (money by field name only).

### GET /api/v1/jobs/mine

- **Purpose**: the technician's own jobs: assigned to the caller's employee directly or through a team they currently belong to,
  within their `jobs.view` scope. Soonest `scheduledStartAt` first, then `appointmentWindowStart`, unscheduled last, then id.
- **Auth**: session. **Permission**: `jobs.view`.
- **Request query**: `cursor`, `limit`; `status` (comma list), `scheduledFrom`, `scheduledTo`. CLOSED and CANCELLED are hidden
  unless named in `status`.
- **Response**: `200 { data: [job + assignments], page }` (empty for a user with no employee record). **Audit**: none.

### GET /api/v1/jobs/workflow-settings

- **Purpose**: every transition of the lifecycle with its `optional` flag and whether the company has it `enabled`, plus the
  `disabledTransitions` list (`"FROM>TO"`).
- **Auth**: session. **Permission**: `job_types.view` (capability).
- **Response**: `200 { data: { disabledTransitions: [string], transitions: [{ key, from, to, optional, enabled }] } }`.

### PUT /api/v1/jobs/workflow-settings

- **Purpose**: replace the list of optional transitions the company switched off. A company can only narrow the machine: naming
  a core transition or one that does not exist is refused, and a stored name that is not optional is ignored by the machine.
- **Auth**: session. **Permission**: `job_types.configure`, tenant-wide (`403` otherwise; the role requires MFA).
- **Request body** (strict): `{ disabledTransitions: [string] }` (up to 200). **Response**: `200` as the GET.
- **Errors**: `400` with `details` listing each name that is not an optional transition. **Audit**: `job.workflow_update`.

### GET /api/v1/jobs/{id}

- **Purpose**: one job with its active assignments and requirements.
- **Auth**: session. **Permission**: `jobs.view` over the job. **Response**: `200 { data: job }` projected to the grant.
  **Errors**: `404`. **Audit**: none.

### PATCH /api/v1/jobs/{id}

- **Purpose**: edit job facts (strict, at least one key): `title`, `description` (nullable), `instructions` (nullable), `priority`,
  `estimatedDurationMinutes`, `timeZone` (nullable), `quotedAmountMinor` (nullable), `currency`. Status, assignment and schedule
  have their own endpoints.
- **Auth**: session. **Permission**: `jobs.edit` over the job AND, for every key sent, the right to write it: a Technician's
  execution grant covers `instructions` only (anything else sent is `403`); money needs the financial grant.
- **Response**: `200 { data: job + warnings }`; a request that changes nothing writes nothing.
- **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` closed, cancelled or archived job; `400`.
- **Audit**: `job.update` (money by field name only); events `job.updated`, and `job.priority_changed` for a priority change.

### POST /api/v1/jobs/{id}/transition

- **Purpose**: move the job to another status along the machine. Side effects: PENDING_ASSIGNMENT ends the assignments and
  clears the scheduled slot; IN_PROGRESS / COMPLETED / CLOSED / CANCELLED stamp `startedAt` (first time) / `completedAt` /
  `closedAt` / `cancelledAt`; CLOSED and CANCELLED end the assignments. Cancelling notifies the people the job was assigned to
  (`job.cancelled`, critical).
- **Auth**: session. **Permission**: `jobs.edit` over the job with `status` (and `statusReason` when a reason is sent) writable.
  Edges out of AWAITING_REVIEW also need `jobs.approve` (to CLOSED) or `jobs.reject` (back to IN_PROGRESS); a move that ends the
  assignments (back to PENDING_ASSIGNMENT, CLOSED, CANCELLED) needs `jobs.assign` too. Entering RESCHEDULED, or leaving ON_HOLD for ASSIGNED, clears the scheduled slot. An execution-only grant (Technician) may move a job only to `EN_ROUTE` in Phase 2 (`403` otherwise).
- **Request body** (strict): `toStatus`; `reason` (1-500; required for CANCELLED, CUSTOMER_UNAVAILABLE, RESCHEDULED, FAILED, ON_HOLD,
  REQUIRES_RETURN_VISIT). Offline envelope, `toStatus: EN_ROUTE` only (`400` otherwise): `clientEventId` (UUID) and `occurredAt` (device time) make the move idempotent per employee (`job.en_route`; a repeat answers `200` with `replayed: true`) and stamp the status history with the device time.
- **Response**: `200 { data: job }`. **Errors**: `403`; `404`; `400` missing reason / unknown status; `409 INVALID_STATE_TRANSITION`.
- **Audit**: `job.status_change`; a `JobStatusHistory` row and a `job.status_changed` event.

### POST /api/v1/jobs/{id}/assign

- **Purpose**: give the job to ONE employee or ONE team; an existing assignment is ENDED and replaced (reassignment). Allowed in
  PENDING_ASSIGNMENT, ASSIGNED, SCHEDULED, RESCHEDULED, ON_HOLD, CUSTOMER_UNAVAILABLE and REQUIRES_RETURN_VISIT; a PENDING_ASSIGNMENT
  job becomes ASSIGNED, any other keeps its status. Method is `MANUAL` (dispatch recommendations arrive with the dispatch task).
- **Hard eligibility is enforced** with the qualification engine against the job's requirement rows and, when set, its slot or
  appointment window: employment, verified unexpired skills and credentials, job-category permission, service territory,
  availability. A team passes when at least one current member is eligible. A failure is `409 CONFLICT` with
  `error.details: [{ field, code, message }]` (`code` is a `QUALIFICATION.FAILURE.<code>`); nothing is written.
- **Override**: `override: { reason }` assigns despite the failures. It needs `jobs.approve` over the job (`403` otherwise) and is
  never accepted for employment failures (inactive or terminated employee, empty team); a team can be overridden when at least
  one member lacks only excusable things. Optional `expectedAssignmentId` (the active assignment id the caller saw, or `null` for
  none): a different current assignment answers `409 field: "expectedAssignmentId"`. `overrideReason` (assignments list) and the
  `reason`/`failureCodes` of `dispatch.override` events are shown only to `jobs.assign` / `jobs.approve` holders. It is stored as method `OVERRIDE` with
  `overrideReason`, as a `dispatch.override` event and in the audit log.
- **Auth**: session. **Permission**: `jobs.assign` over the job with the base field set.
- **Request body** (strict): exactly one of `employeeId`, `teamOrgUnitId` (an active TEAM unit inside the job's service area);
  `reason`; `override { reason }`.
- **Response**: `200 { data: job }`. **Errors**: `403`; `404`; `404` unknown employee or one outside the caller's employee scope; `400` unknown team; `409 CONFLICT` already assigned to
  this target or not eligible; `409 INVALID_STATE_TRANSITION` job already on its way or finished.
- **Audit**: `job.assign` or `job.reassign`. Events `job.assigned` / `job.reassigned`. Notifications: `job.assigned` to the new
  assignee (every current member of a team) and `job.reassigned` to people who lost the job, after commit.

### POST /api/v1/jobs/{id}/unassign

- **Purpose**: take the job off its assignee(s): assignments end, the scheduled slot is cleared, the job returns to
  PENDING_ASSIGNMENT (the transition must be enabled for the company). The previous assignee is notified (`job.reassigned`).
- **Auth**: session. **Permission**: `jobs.assign` over the job. **Request body** (strict): `reason` (required).
- **Response**: `200 { data: job }`. **Errors**: `403`; `404`; `409 INVALID_STATE_TRANSITION` nothing to remove / status does not allow.
- **Audit**: `job.unassign` plus the status change; event `job.unassigned`.

### POST /api/v1/jobs/{id}/reschedule

- **Purpose**: change the customer arrival window and/or the dispatcher's slot (`null` clears; the slot cannot be cleared while the
  job is SCHEDULED). A slot needs an active assignment (`400 field scheduledSlot`); setting one on an ASSIGNED, RESCHEDULED,
  CUSTOMER_UNAVAILABLE or REQUIRES_RETURN_VISIT job moves it to SCHEDULED. Not allowed once the technician is on the way.
  Conflicts come back as `warnings` (duration longer than the window or slot; an assigned employee not eligible or available then).
- **Auth**: session. **Permission**: `jobs.edit` over the job with the scheduling fields writable (not part of the Technician grant).
- **Request body** (strict, at least one span): `appointmentWindow { start, end } | null`, `scheduledSlot { start, end } | null`, `reason`.
  End must be after start.
- **Response**: `200 { data: job + warnings }` (a request that changes nothing writes nothing). **Errors**: `403`; `404`; `400`;
  `409 INVALID_STATE_TRANSITION`.
- **Audit**: `job.reschedule`; event `job.rescheduled`; notification `job.rescheduled` to the assignees after commit.

### GET /api/v1/jobs/{id}/history

- **Purpose**: status history, newest first: `{ id, fromStatus, toStatus, actorType (USER | SYSTEM), actorUserId, reason, occurredAt }`.
- **Auth**: session. **Permission**: `jobs.view` over the job with the base field set (`403` for a financial-only grant).
  Paged (`cursor`, `limit`). **Audit**: none.

### GET /api/v1/jobs/{id}/events

- **Purpose**: the job's event log, newest first: `{ id, type, actorType, actorUserId, occurredAt, recordedAt, payload }`. Types in
  Phase 2: `job.created`, `job.assigned`, `job.reassigned`, `job.unassigned`, `job.rescheduled`, `job.updated`,
  `job.priority_changed`, `job.status_changed`, `dispatch.override`; clients translate `JOB.EVENT.<NAME>` (the part after `job.`,
  dots to underscores, upper case: `JOB.EVENT.PRIORITY_CHANGED`, `JOB.EVENT.DISPATCH_OVERRIDE`).
- **Auth**: session. **Permission**: as `/history`. Paged. **Audit**: none.

### GET /api/v1/jobs/{id}/assignments

- **Purpose**: every assignment the job has had, ACTIVE first: `{ id, employeeId, teamOrgUnitId, role, state (ACTIVE | ENDED), method,
  overrideReason, assignedAt, assignedById, reason, endedAt, endedReason }`.
- **Auth**: session. **Permission**: as `/history`. Paged. **Audit**: none.

## Dispatch (`/api/v1/dispatch`) - Phase 2

Code: `src/server/dispatch` (README there), pure ranking `src/lib/dispatch-scoring.ts`, routes `src/app/api/v1/dispatch/**`.
Design decisions, factors and weights: `DECISIONS.md` "Phase 2 Task 7". Rule-based and explainable, no LLM; a person always decides.

A **recommendation** is `{ id, jobId, mode, status (PENDING | APPROVED | MODIFIED | REJECTED | SUPERSEDED), candidates, blockingReasons,
distanceBasis ("STRAIGHT_LINE_ESTIMATE"), generatedAt, generatedById, chosenEmployeeId, decidedAt, decidedById, decisionReason }`.
`candidates` is ranked best first: `{ employeeId, rank, score, factors: [{ key (DISTANCE | WORKLOAD | EXPERIENCE | PREFERENCE), value,
contribution, maxContribution, explanationKey, explanationParams }], conflicts: [{ code, messageKey }] }`. Only ids and codes are returned:
translate `DISPATCH.FACTOR.*`, `DISPATCH.CONFLICT.*`, `DISPATCH.STATUS.*`, `QUALIFICATION.FAILURE.<code>` and resolve employee ids with the
employees API. Distances are straight-line estimates from stored coordinates, never travel time. `blockingReasons` is
`{ employeeId: [{ code, params }] }` and is set only when nobody was eligible AND the evaluation was complete (then `candidates` is `[]`).
Everything is limited to employees the CALLER may see (`employees.view`): `outOfScopeCount` says how many relevant employees were not
evaluated for them (no ids), `hiddenCandidateCount` how many entries of a stored recommendation were dropped for this viewer,
`evaluatedCount` how many were judged, `poolTruncated` that the evaluation ceiling (5000) stopped the pass, `scoringVersion` which rules ranked.

Permissions are checked over the job's service area; a job outside the caller's scope is `404`.

### GET /api/v1/dispatch/settings

- **Purpose**: the dispatch mode `{ mode, modes: [{ mode, available }] }`. MANUAL and AI_ASSISTED (default) are available;
  RULE_BASED_AUTO and OPTIMIZATION are listed with `available: false` ("not available in this phase").
- **Auth**: session. **Permission**: `dispatch.view` (any scope).

### PUT /api/v1/dispatch/settings

- **Purpose**: change the mode. **Request body** (strict): `mode`. **Permission**: tenant-wide `dispatch.manage`.
- **Errors**: `403`; `400` for an unknown mode, or for RULE_BASED_AUTO / OPTIMIZATION (`details: [{ field: "mode", code: "NOT_AVAILABLE" }]`).
- **Audit**: `dispatch.mode_update`.

### GET /api/v1/dispatch/jobs/{id}/candidates

- **Purpose**: who passes the HARD eligibility rules for this job right now, unranked, and why everybody else does not:
  `{ jobId, distanceBasis, eligibleEmployeeIds, blocked: [{ employeeId, failures: [{ code, params }] }] }` (every failed rule per
  employee). plus `evaluatedCount`, `outOfScopeCount`, `poolTruncated`. Works in every mode (manual dispatch uses it); stores nothing.
  Candidates are non-terminated employees in the caller's scope with a territory covering the job's area or a permission for its type/category.
- **Auth**: session. **Permission**: `dispatch.view` over the job.

### POST /api/v1/dispatch/jobs/{id}/recommendations

- **Purpose**: generate and store a recommendation: eligibility filter, then ranking of the eligible by distance, workload, experience
  with the job type and customer preference. Nothing is assigned. Pending recommendations of the job become SUPERSEDED. When nobody is
  eligible the recommendation has no candidates and carries the blocking reasons; the job stays PENDING_ASSIGNMENT.
- **Auth**: session. **Permission**: `dispatch.create` over the job. No body.
- **Response**: `201 { data: recommendation }`. **Errors**: `403`; `404`; `409 CONFLICT` in MANUAL mode or for a stored mode this phase cannot run;
  `409 INVALID_STATE_TRANSITION` when the job can no longer be assigned.
- **Audit**: `dispatch.recommend`.

### GET /api/v1/dispatch/jobs/{id}/recommendations

- **Purpose**: the job's recommendations, newest first. **Permission**: `dispatch.view` over the job. Paged (`cursor`, `limit`).

### GET /api/v1/dispatch/recommendations/{id}

- **Purpose**: one recommendation. **Permission**: `dispatch.view` over its job. **Errors**: `404` (unknown, other company, out of scope).

### POST /api/v1/dispatch/recommendations/{id}/approve

- **Purpose**: assign the top-ranked candidate. Goes through the jobs module's assignment, so hard eligibility is re-checked now (a
  candidate who became ineligible is refused with the reasons) and notifications are sent. The assignment is method
  `RECOMMENDATION_APPROVED` with `recommendationId`; the recommendation becomes APPROVED with who, when and the reason.
- **Auth**: session. **Permission**: `dispatch.assign` over the job, plus `jobs.assign`. **Request body** (strict): `reason` (optional).
- **Response**: `200 { data: recommendation }`. **Errors**: `403`; `404`; `409 CONFLICT` no candidates, the top candidate is outside your scope, the top candidate is no longer
  eligible (`error.details` as for `/jobs/{id}/assign`), or the job's assignments changed since generation (`details[0].code`
  `STALE_RECOMMENDATION`: generate a new one); `409 INVALID_STATE_TRANSITION` already decided or superseded (a manual assignment supersedes it).
  The decision is one atomic step: on any error nothing is assigned and the recommendation stays pending.
- **Audit**: `dispatch.recommendation_approve` (chosen employee and rank, method), plus the jobs module's `job.assign`.

### POST /api/v1/dispatch/recommendations/{id}/modify

- **Purpose**: assign someone else (any employee, listed or not). Method `RECOMMENDATION_MODIFIED`; the recommendation becomes MODIFIED.
  If the choice fails the hard rules the request must carry an `override`; it is then honoured only for a `jobs.approve` holder
  (Owner/CEO, COO by default; `403` otherwise), never for employment failures, and the assignment is method `OVERRIDE` with
  `overrideReason`, a `dispatch.override` job event and the audit trail.
- **Auth**: session. **Permission**: `dispatch.assign` over the job, plus `jobs.assign`. **Request body** (strict): `employeeId`,
  `reason` (both required), `override { reason }`. An employee outside your employee scope is `404`.
- **Errors**: `400` missing reason, or the employee is the recommended one (approve instead); `403`; `404`; `409` not eligible and no
  override (with reasons), or already decided. **Audit**: `dispatch.recommendation_modify` (chosen rank, `overrideUsed`, reason).

### POST /api/v1/dispatch/recommendations/{id}/reject

- **Purpose**: decline the recommendation; the job stays pending and nobody is assigned. The reason is kept.
- **Auth**: session. **Permission**: `dispatch.assign` over the job. **Request body** (strict): `reason` (required).
- **Errors**: `400`; `403`; `404`; `409 INVALID_STATE_TRANSITION`. **Audit**: `dispatch.recommendation_reject`.

## Follow-up tasks (`/api/v1/follow-ups`) - Phase 3

Code: `src/server/follow-ups` (README there), routes `src/app/api/v1/follow-ups/**`, status machine `src/lib/follow-up-lifecycle.ts`.
Design decisions: `DECISIONS.md` "Phase 3 Task 7".

A follow-up is a generic task ("call the customer back") about ONE target: a `LEAD`, `CUSTOMER`, `JOB` or `RECOVERY_CASE`
(`targetType` + the matching id column `leadId | customerId | jobId | recoveryCaseId`; the database allows exactly one).

Fields (all `base`): `id, targetType, leadId, customerId, jobId, recoveryCaseId, orgUnitId (the target's service area, copied at
creation), title, description, status, priority (LOW | NORMAL | HIGH | URGENT), origin (MANUAL | OUTCOME | RECOVERY_RULE | SYSTEM),
assigneeId (employee), assignedAt, dueAt, completedAt, completedById, completionNote, cancelledAt, cancelReason, createdById,
createdAt, updatedAt`, plus derived `overdue` (open and past due) and `nextStatuses`. The sweep stamps never leave the server.

Statuses: `OPEN <-> IN_PROGRESS`, either -> `DONE` or `CANCELLED` (reason required); `DONE` / `CANCELLED` can only be reopened to `OPEN`.

**Two access gates, both must pass (otherwise `404`, never `403`)**:
1. The task, with `follow_ups.view | create | edit | assign`: `ORG_UNIT` / `LEGAL_ENTITY` follow `orgUnitId` (a task whose target has no
   unit is tenant-level), `ASSIGNED` = the caller is the assignee, `OWN` = the caller created it.
2. The target: the caller must be able to view the lead / customer / job / recovery case (`leads.view`, `customers.view`,
   `jobs.view`, `recovery.view`, each with its own module's scope rules). A task never reveals or opens a record its reader cannot reach.

**Assignee rules**: an ACTIVE employee with a login who can themselves open the task and its target. Assigning to somebody other than
yourself needs `follow_ups.assign` over THAT employee (the grant's unit scope must cover their placement); an employee outside it is
reported as `400` "Employee not found" on `assigneeId`, exactly like a missing one.

**Offline** (§8.7, §25.3): create, status, complete and cancel accept `clientEventId` (UUID) and `occurredAt` (device time, not in the
future). Idempotent per (company, employee, `clientEventId`) through `FieldEvent`: a replay returns the task as it is now and applies
nothing; the same id with different content is `409 CONFLICT`; an event refused for a business reason is stored as `REJECTED` and a replay
answers the same error class. Permission failures are not stored. `occurredAt` becomes `completedAt` / `cancelledAt`. An event needs an
employee record (`400` on `clientEventId` otherwise).

Notifications (in-app, link to the task, redacted at read time when access is lost): `follow_up.assigned` (to the new assignee, not the
person assigning), `follow_up.due_soon` and `follow_up.overdue` (raised by the sweep `sweepFollowUps` / `sweepAllFollowUps`, which a worker
calls; there is no scheduler yet). "Due soon" = within `OperationsSettings.followUpDueSoonMinutes` (default 60). Each is sent once per task
and due time; changing the due date or reopening starts a new cycle. Unassigned tasks are not notified: list them with
`unassigned=true&overdue=true`.

### GET /api/v1/follow-ups

- **Purpose**: the work queue, soonest due first (then id).
- **Auth**: session. **Permission**: `follow_ups.view`, capability; scope and target access are part of the query.
- **Request query**: `cursor`, `limit`; `status` (`OPEN | IN_PROGRESS | DONE | CANCELLED | open` where `open` = OPEN and IN_PROGRESS);
  `priority`; `targetType` (+ `targetId`, which needs `targetType`); `assigneeEmployeeId` (an id or `me`); `unassigned` `true` (open, nobody
  assigned) | `false`; `overdue` `true` (open and past due); `dueFrom`, `dueTo` (ISO datetimes, `dueTo` exclusive); `orgUnitId`.
- **Response**: `200 { data: [followUp], page }`. **Errors**: `400` bad query (`targetId` without `targetType`). **Audit**: none.

### POST /api/v1/follow-ups

- **Purpose**: create a task about a target.
- **Auth**: session. **Permission**: `follow_ups.create` over the target's service area, plus view access to the target; plus
  `follow_ups.assign` over the assignee when it is somebody else.
- **Request body** (strict): `targetType`, `targetId`, `title` 1-200, `description` 1-4000, `dueAt`, `priority` (default `NORMAL`),
  `assigneeId`, `clientEventId`, `occurredAt`. `origin` and `dedupeKey` are not settable by a person (rules and the system set them in code).
- **Idempotency**: `Idempotency-Key` honoured, and `clientEventId` (see Offline).
- **Response**: `201 { data: followUp }` (only `{ id }` when the creator may not view what they created).
- **Errors**: `400` (assignee unknown / out of scope / cannot work the task); `403`; `404` (target missing or out of reach);
  `409 INVALID_STATE_TRANSITION` archived target; `409 CONFLICT` reused `clientEventId` with different content.
- **Audit**: `follow_up.create` (ids, priority, due date, origin; never the title or description).

### GET /api/v1/follow-ups/{id}

- **Purpose**: one task with `overdue` and `nextStatuses`. **Permission**: `follow_ups.view` over the task and view access to its target.
  **Errors**: `404`. **Audit**: none.

### PATCH /api/v1/follow-ups/{id}

- **Purpose**: edit an OPEN / IN_PROGRESS task. **Request body** (strict, at least one key): `title`, `description` (nullable), `dueAt`, `priority`.
  A changed `dueAt` clears the sweep stamps (new reminders). **Permission**: `follow_ups.edit`.
- **Errors**: `400`; `404`; `409 INVALID_STATE_TRANSITION` task is DONE / CANCELLED (reopen first). **Audit**: `follow_up.update` (changed fields; text shown as `[text]`).

### POST /api/v1/follow-ups/{id}/assign

- **Purpose**: assign, reassign, or unassign (`assigneeId: null`) an open task; the new assignee is notified. **Permission**: `follow_ups.assign` over the task.
- **Request body** (strict): `assigneeId` (string | null). **Errors**: `400` (assignee rules above); `403`; `404`; `409 INVALID_STATE_TRANSITION`.
- **Audit**: `follow_up.assign` / `follow_up.unassign`.

### POST /api/v1/follow-ups/{id}/status

- **Purpose**: start (`IN_PROGRESS`), put back or reopen (`OPEN`). **Permission**: `follow_ups.edit`.
- **Request body** (strict): `status` (`OPEN | IN_PROGRESS`), `clientEventId`, `occurredAt`. **Errors**: `404`; `409 INVALID_STATE_TRANSITION`.
  Reopening clears the completion / cancellation stamps and the reminder stamps. **Audit**: `follow_up.status_change`.

### POST /api/v1/follow-ups/{id}/complete

- **Purpose**: mark DONE. **Permission**: `follow_ups.edit`. **Request body** (strict): `note` (optional, 1-2000), `clientEventId`, `occurredAt`
  (becomes `completedAt`). **Errors**: `404`; `409 INVALID_STATE_TRANSITION` (also for the loser of two simultaneous completions).
  **Audit**: `follow_up.status_change` (`hasNote`, never the note).

### POST /api/v1/follow-ups/{id}/cancel

- **Purpose**: cancel. **Permission**: `follow_ups.edit`. **Request body** (strict): `reason` (required, 1-500), `clientEventId`, `occurredAt`.
  **Errors**: `400`; `404`; `409 INVALID_STATE_TRANSITION`. **Audit**: `follow_up.status_change` (`hasReason`, never the reason).
## Shifts (`/api/v1/shifts`) - Phase 3

Code: `src/server/shifts` (README there), pure rules `src/lib/shift-rules.ts`, routes `src/app/api/v1/shifts/**`. Spec 8.1, 17.
A **shift** is `{ id, employeeId, orgUnitId (placement snapshot at start), status (ACTIVE | ENDED), startedAt, startRecordedAt, endedAt,
endRecordedAt, deviceId, startLocationEventId, endLocationEventId, startException, startExceptionNote, endException, endExceptionNote,
endedByUserId, endReason, exceptionReviewStatus (null | PENDING | APPROVED | REJECTED), reviewedById, reviewedAt, reviewNote, createdAt,
updatedAt }`. `startedAt` / `endedAt` are when it happened (the device clock for offline events), `*RecordedAt` is the server clock.
A shift never contains coordinates; its location events (`/location-events?shiftId=`) hold accuracy and verdicts. Exception codes:
`GPS_DISABLED | PERMISSION_DENIED | POOR_SIGNAL | DEVICE_OFFLINE | OUTSIDE_GEOFENCE | DELAYED | OTHER` (translate `LOCATION.EXCEPTION.*`,
`SHIFT.STATUS.*`, `SHIFT.REVIEW.*`).

**Boundary body** (start and end, strict): `position { latitude, longitude, accuracyM, deviceTime }` and / or `exception { code, note }`
(`note` required for `OTHER`); at least one of them. Without a position the boundary is a manual entry with a reason. An exception, or a
position vaguer than the tenant's `locationMaxAccuracyM` (then `POOR_SIGNAL` is raised by the server), sets `exceptionReviewStatus = PENDING`
for a manager. Offline (spec 8.7): `clientEventId` (UUID) and `occurredAt` (ISO, at most 5 minutes ahead and 7 days back) make the call
idempotent per employee: a repeat answers with the original shift (`200`), the same id with different content is `409 CONFLICT`
(`details[0].code` `CLIENT_EVENT_ID_REUSED`), and a refusal is remembered (a repeat of a refused event is refused again; send a corrected event
with a new id). `deviceId` is optional.

Scope: a technician's grant is `OWN`; managers see shifts whose placement snapshot is in their unit (or legal entity). A shift outside the caller's
scope is `404`.

### GET /api/v1/shifts

- **Purpose**: shifts the caller may see, newest start first (`startedAt desc, id desc`). Query: `employeeId`, `orgUnitId`, `status`,
  `exceptionReview` (`PENDING | APPROVED | REJECTED`: the review queue), `from`, `to` (on `startedAt`), `cursor`, `limit`.
- **Auth**: session. **Permission**: `shifts.view`. **Response**: `{ data: [shift], page }`.

### GET /api/v1/shifts/current

- **Purpose**: the caller's own ACTIVE shift, `{ data: null }` when off shift. **Permission**: `shifts.view`; `403` for a user with no employee profile.

### POST /api/v1/shifts/start

- **Purpose**: the caller starts their own shift: a SHIFT_START location event (accuracy, both clocks, source `DEVICE_GPS` or `MANUAL`) is recorded in
  the same transaction, with the org unit snapshot. Idempotent: while a shift is running it is returned (`200`) and nothing is recorded.
- **Auth**: session. **Permission**: `shifts.create` for their own record. **Request body**: the boundary body above.
- **Response**: `201 { data: shift }` new; `200` already running or replayed. **Errors**: `400` neither position nor reason, position without
  accuracy, event time in the future / too old; `403` (no permission, or no employee profile); `409 INVALID_STATE_TRANSITION` employee not
  ACTIVE or the start precedes the previous shift's end; `409 CONFLICT` reused `clientEventId`.
- **Audit**: `shift.start` (ids, accuracy, exception code; never coordinates).

### POST /api/v1/shifts/end

- **Purpose**: the caller ends their own current shift (same body and rules as start; no `reason`). Ending a shift that ended less than 5 minutes ago
  returns it unchanged (a retry after a lost response). A later blank call is `409 INVALID_STATE_TRANSITION` (no active shift).
- **Auth**: session. **Permission**: `shifts.edit` over their own shift. **Response**: `200 { data: shift }`.
- **Errors**: as start, plus `409` when `occurredAt` precedes the shift's start. **Audit**: `shift.end`.
  An end with an exception reopens the review (`PENDING`); a clean end keeps an earlier decision.

### GET /api/v1/shifts/{id}

- **Purpose**: one shift. **Permission**: `shifts.view` over it. **Errors**: `404` (unknown, other company, out of scope).

### POST /api/v1/shifts/{id}/end

- **Purpose**: end a shift by id. The owner ends their own (as above). A manager ending or correcting SOMEONE ELSE's shift sends `reason` (required),
  no `position` / `exception` (`400`); the shift records `endedByUserId` and `endReason`, and the SHIFT_END event has source `MANAGER`.
- **Auth**: session. **Permission**: `shifts.edit` over the shift's unit. **Request body**: the boundary body plus `reason` (optional, max 500).
- **Errors**: `400`; `403` (view-only roles); `404` out of scope; `409` before the start. **Audit**: `shift.end`, or `shift.end_by_manager` with the reason.

### POST /api/v1/shifts/{id}/review

- **Purpose**: approve or reject the exception of a shift (start and / or end), once. Does not change the shift's times.
- **Auth**: session. **Permission**: `shifts.approve` over the shift's unit; nobody reviews their own shift (`403`). **Request body** (strict):
  `decision` (`APPROVED | REJECTED`), `note` (required).
- **Response**: `200 { data: shift }`. **Errors**: `400`; `403`; `404`; `409 INVALID_STATE_TRANSITION` no exception, or already reviewed.
- **Audit**: `shift.exception_review` with the note as reason.

## Location events (`/api/v1/location-events`) - Phase 3

Code: `src/server/location` (README there), pure rules `src/lib/location-rules.ts`, routes `src/app/api/v1/location-events/**`. Spec 17, 22.2.
Location data is **sensitive** and **event-based**: rows exist for shift start / end, arrival, departure, navigation-opened and approved verification;
there is no tracking or polling endpoint. A **location event** is `{ id, employeeId, shiftId, jobId, orgUnitId, kind, source, verification,
accuracyM, distanceToJobM, geofenceRadiusM, deviceTime, serverTime, deviceId, exception, exceptionNote, coordinatesPurgedAt, recordedByUserId,
fieldEventId }` plus `latitude` / `longitude`. `deviceTime` (the device clock) and `serverTime` (when the server received it) are both kept.
`kind`: `SHIFT_START | SHIFT_END | ARRIVAL | DEPARTURE | NAVIGATION_OPENED | VERIFICATION` (NAVIGATION_OPENED never changes a job status and is never an
arrival). `source`: `DEVICE_GPS | GEOFENCE | MANUAL | MANAGER`. `verification`: `UNVERIFIED | WITHIN_RADIUS | OUTSIDE_RADIUS | MANAGER_VERIFIED`: what the server
concluded from a reported position, never proof (translate `LOCATION.KIND.*`, `LOCATION.SOURCE.*`, `LOCATION.VERIFICATION.*`, show
`LOCATION.CONFIDENCE_NOTE` and `LOCATION.ACCURACY`). **`latitude` / `longitude` are returned only to a grant naming the opt-in `coordinates` field set
(`location.coordinate_fields`: the Owner template); everyone else, managers included, gets time, kind, accuracy, distance and verdicts.** After the
retention period (tenant `locationRetentionDays`, default 90) the coordinates are removed and `coordinatesPurgedAt` is set; the row stays.

### GET /api/v1/location-events

- **Purpose**: location history, newest first (`serverTime desc, id desc`), limited to the caller's scope (unit / legal entity of the employee's placement
  at the time). Query: `employeeId`, `jobId`, `shiftId`, `kind`, `from`, `to` (on `serverTime`), `cursor`, `limit`.
- **Auth**: session. **Permission**: `location.view` (sensitive; held by managers and the COO, not by technicians, dispatchers or Lead Operations).
  Coordinates per row as described above. **Response**: `{ data: [event], page }`.

### GET /api/v1/location-events/{id}

- **Purpose**: one event. **Permission**: `location.view` over it. **Errors**: `403`; `404` (unknown, other company, out of scope).

### POST /api/v1/location-events

- **Purpose**: a technician reports one of their own events for a job assigned to them: `DEPARTURE` or `NAVIGATION_OPENED`. Shift events belong to the
  shift endpoints, arrival to arrival verification. This never changes the job.
- **Auth**: session. **Permission**: `location.create` for their own record, and the job must be assigned to them (`404` otherwise).
- **Request body** (strict): `kind`, `jobId`, `position { latitude, longitude, accuracyM, deviceTime }` or `exception { code, note }` (not both; a
  `DEPARTURE` needs one of them, `NAVIGATION_OPENED` may have neither), `clientEventId`, `occurredAt`, `deviceId`. Accuracy is mandatory with a position and
  is stored rounded up to a whole meter.
- **Response**: `201 { data: event }`, `200` for a repeated `clientEventId` (same event). The event is projected to the caller's grant: never coordinates.
- **Errors**: `400` (no accuracy, bad range, blank departure, time in the future); `403`; `404`; `409 CONFLICT` reused `clientEventId` with different content.
- **Audit**: `location.record` (kind, source, accuracy, job; never coordinates).

## Arrival and field steps (`/api/v1/jobs/{id}/...`) - Phase 3

Code: `src/server/arrival` (README there), pure rules `src/lib/arrival-rules.ts`, routes `src/app/api/v1/jobs/[id]/{arrive,start-work,navigation-opened,arrivals}`.
Spec 8.3, 8.4, 17.2, 17.4. Design decisions: `DECISIONS.md` "Phase 3 Task 3". An arrival holds distance, accuracy, radius, codes and a `confidence` code
(`ARRIVAL.CONFIDENCE.*`): wording is about confidence, never certainty. Coordinates are never returned.

### POST /api/v1/jobs/{id}/arrive

- **Purpose**: the assigned technician confirms arrival at a job that is `EN_ROUTE`. The job moves to `ARRIVED`; the server compares the reported position with the
  service address (straight-line distance against the address's radius, else the tenant default) and records the verdict with its accuracy.
- **Auth**: session. **Permission**: `location.create` (own record) and the job assigned to the caller (`404` otherwise).
- **Request body** (strict): `position { latitude, longitude, accuracyM, deviceTime }` OR `exception { code, note }` (exactly one), `trigger` (`TECHNICIAN` default, or
  `GEOFENCE` for a device geofence event, which needs a position), `clientEventId`, `occurredAt`, `deviceId`.
- **Response**: `201 { data: { arrival, job: { id, status } } }`, `200` for a repeated `clientEventId`. `arrival.status` is `RECORDED` (inside the radius with a usable
  accuracy: a candidate, not proof) or `PENDING_MANAGER_REVIEW` (outside, too vague, no position, address without coordinates; `exceptionReason` says which). Managers
  with `location.approve` over the job's unit are notified (`job.arrival_unverified`).
- **Errors**: `400` (neither or both of position / exception, no accuracy, time in the future); `403`; `404`; `409` (job not EN_ROUTE, reused `clientEventId` with different content).
- **Audit**: `arrival.record` (status, verdict, distance, accuracy; never coordinates). Job event `job.arrival_recorded`.

### POST /api/v1/jobs/{id}/start-work

- **Purpose**: the technician starts the work: `ARRIVED` to `IN_PROGRESS`, stamping `startedAt` (the device time when `occurredAt` is sent, never before the arrival).
- **Auth**: session. **Permission**: `jobs.edit` over the job with `status` writable (execution grant), job assigned to the caller (`404` otherwise).
- **Request body** (strict): `clientEventId`, `occurredAt`, `deviceId`. **Response**: `200 { data: { job: { id, status, startedAt } } }` (same answer on a replay).
- **Errors**: `403`; `404`; `409` (job not ARRIVED, or a manager rejected the arrival, or reused `clientEventId` with different content).

### POST /api/v1/jobs/{id}/navigation-opened

- **Purpose**: record that the technician opened navigation. Informational: never changes the job status and never counts as arrival.
- **Auth/body/response**: as `POST /location-events` with `kind: NAVIGATION_OPENED` (position or exception optional); `201`, `200` on replay; no coordinates in the response.

### GET /api/v1/jobs/{id}/arrivals

- **Purpose**: the arrivals of the job, newest first. **Permission**: `location.view` over the job. **Response**: `200 { data: [arrival] }`; no coordinates.

### POST /api/v1/jobs/{id}/arrivals/{arrivalId}/verify

- **Purpose**: a manager verifies or rejects an arrival (also one the server accepted: an override), with a mandatory reason.
- **Permission**: `location.approve` over the job. Nobody decides their own arrival. **Request body** (strict): `decision` (`VERIFIED` | `REJECTED`), `note` (1-500 chars).
- **Response**: `200 { data: arrival }` with `status` `MANAGER_VERIFIED` / `MANAGER_REJECTED`, `verifiedByUserId`, `verifiedAt`, `verificationNote`. VERIFIED also records a
  `VERIFICATION` location event by the manager. REJECTED leaves the job status as it is and blocks that technician's `start-work`.
- **Errors**: `400` (no reason); `403`; `404`; `409` (already decided). **Audit**: `arrival.verify` (status change, reason).

## Job outcomes and lost reasons (`/api/v1/jobs/{id}/outcome`, `/api/v1/job-outcomes`, `/api/v1/lost-reasons`) - Phase 3

Code: `src/server/job-outcomes` (README there), pure rules `src/lib/job-outcome-rules.ts`, routes `src/app/api/v1/{job-outcomes,lost-reasons}/**`
and `src/app/api/v1/jobs/{id}/outcome(s)`. Spec 9.1, 9.2. Design decisions: `DECISIONS.md` "Phase 3 Task 5".

Outcome fields: `base` = `id, jobId, visitNumber, employeeId, outcome, lostReasonId, notes, customerRequestedFollowUp, preferredFollowUpAt, occurredAt, recordedAt, recordedById, clientEventId`; the opt-in `financial` set (`job_outcomes.financial_fields`: Owner, COO, State/Regional/City managers, the Technician, Finance Director) = `quotedAmountMinor, approvedAmountMinor, chargedAmountMinor, collectedAmountMinor, currency, paymentMethod, paymentStatus` (Dispatcher, Team Leader and Lead Operations see the outcome without them). Complete list: `id, jobId, visitNumber, employeeId, outcome (SOLD | NOT_SOLD |
CUSTOMER_UNAVAILABLE | RESCHEDULE_REQUIRED | WORK_NOT_POSSIBLE | ADDITIONAL_APPROVAL_REQUIRED; labels OUTCOME.TYPE.<value>), lostReasonId,
notes, quotedAmountMinor, approvedAmountMinor, chargedAmountMinor, collectedAmountMinor (integer minor units, never floats), currency,
paymentMethod (CASH | CARD | CHECK | BANK_TRANSFER | FINANCING | OTHER), paymentStatus (NOT_APPLICABLE | PENDING | PARTIAL | PAID | WAIVED |
REFUSED), customerRequestedFollowUp, preferredFollowUpAt, occurredAt, recordedAt, recordedById, clientEventId`. No commission math.

Outcome > job status (always a direct lifecycle edge; a refused one is `409 INVALID_STATE_TRANSITION`, code `job_outcome.not_reportable`):
`SOLD` / `NOT_SOLD` from IN_PROGRESS > COMPLETED; `ADDITIONAL_APPROVAL_REQUIRED` from IN_PROGRESS > REQUIRES_RETURN_VISIT; `WORK_NOT_POSSIBLE`
from ARRIVED or IN_PROGRESS > FAILED; `CUSTOMER_UNAVAILABLE` from EN_ROUTE or ARRIVED > CUSTOMER_UNAVAILABLE; `RESCHEDULE_REQUIRED` from EN_ROUTE
or ARRIVED > RESCHEDULED. A job cannot move to CLOSED until the outcome of its current visit exists (`409`, detail code `job.outcome_required`;
this applies to `POST /jobs/{id}/transition` too). `Job.currentVisitNumber` (returned with the job) moves to the next number when a job whose
current visit already has an outcome goes EN_ROUTE (or ARRIVED / IN_PROGRESS directly), whatever path it took there (holds, back to the pool...). A reviewer sending work back (AWAITING_REVIEW > IN_PROGRESS) is the same visit.

**Retroactive outcomes**: a job already past its visit (COMPLETED, FAILED, REQUIRES_RETURN_VISIT, AWAITING_REVIEW, CUSTOMER_UNAVAILABLE, e.g. moved by hand) whose current visit has no outcome takes one without any status change, from a holder of `job_outcomes.create` OR `job_outcomes.edit` over the job (managers). It is audited and evented as `retroactive`. Reporting a LIVE visit stays with `create` holders (edit-only = `403`). The outcome currency must equal the job's (`job_outcome.currency_mismatch`); `occurredAt` cannot predate the visit start (`job_outcome.occurred_too_early`).

Validation failures are `400 VALIDATION_FAILED` with `details[{ field, code, message }]`; clients translate by `code` (`OUTCOME.ERROR.*`):
`job_outcome.lost_reason_required` (NOT_SOLD, WORK_NOT_POSSIBLE), `.lost_reason_not_allowed` (SOLD), `.lost_reason_unknown` (missing, other tenant or
inactive), `.lost_reason_not_applicable` (reason does not list the outcome), `.amounts_not_applicable` / `.payment_not_applicable` (approved, charged,
collected amounts and a payment belong to SOLD; the quote may accompany any outcome), `.payment_needs_collected_amount` (PARTIAL / PAID need
`collectedAmountMinor` and `paymentMethod`), `.occurred_in_future` (more than 5 minutes ahead).

### POST /api/v1/jobs/{id}/outcome

- **Purpose**: report the outcome of the job's current visit; the job follows it through its lifecycle in the same transaction.
- **Auth**: session. **Permission**: `job_outcomes.create` over the job (Technician: ASSIGNED; Owner / COO tenant-wide), or `job_outcomes.edit` for a retroactive outcome. Out of scope = `404`, neither held = `403`. Sending amounts or payment needs the `financial` set (`403` otherwise); the response shows only the fields the caller's sets cover.
- **Request body** (strict): `outcome` required; `lostReasonId`, `notes` (<= 4000), `quotedAmountMinor`, `approvedAmountMinor`, `chargedAmountMinor`,
  `collectedAmountMinor`, `currency` (default the job's), `paymentMethod`, `paymentStatus`, `customerRequestedFollowUp`, `preferredFollowUpAt`;
  offline envelope `clientEventId` (UUID) and `occurredAt` (device time, ISO).
- **Idempotency**: `Idempotency-Key` supported. With `clientEventId` and an employee caller the submission is a `FieldEvent` (per tenant, employee,
  clientEventId): the same id and content again returns `200` with `replayed: true` and the original outcome; the same id with different content is
  `409 CONFLICT` (detail code `field_event.payload_mismatch`).
- **Response**: `201 { data: { outcome, job: { id, status, currentVisitNumber }, replayed: false } }`. **Errors**: `400` (above), `403`, `404`, `409`
  (`job_outcome.already_recorded` when the visit already has one; not reportable from this status; the company switched the needed edge off).
- **Audit**: `job_outcome.record` (money by field name only). **Events**: job events `job.outcome_recorded` and, for NOT_SOLD / WORK_NOT_POSSIBLE,
  `job.not_converted` (ids and enums only). Managers with `job_outcomes.edit` over the job's unit get the notification `job.not_converted` (not the reporter).

### GET /api/v1/jobs/{id}/outcomes

- **Purpose**: the outcomes recorded for one job (one per visit), newest first. **Permission**: `job_outcomes.view` over the job (`404` outside scope).
- **Request query**: as `GET /job-outcomes` without `jobId`. **Response**: `200 { data: [outcome], page }`.

### GET /api/v1/job-outcomes

- **Purpose**: outcomes the caller may see; the scope of `job_outcomes.view` applies through the outcome's job. Newest first (`occurredAt desc, id desc`).
- **Request query**: `cursor`, `limit`; `jobId`, `outcome`, `lostReasonId`, `employeeId`, `customerRequestedFollowUp` (`true` | `false`), `occurredFrom`, `occurredTo`.
- **Response**: `200 { data: [outcome], page }`.

### GET /api/v1/job-outcomes/{id}

- **Permission**: `job_outcomes.view` over the outcome's job (`404` otherwise, also across tenants). **Response**: `200 { data: outcome }`.

### PATCH /api/v1/job-outcomes/{id}

- **Purpose**: correct a recorded outcome: `lostReasonId`, `notes`, the amounts, `currency`, payment fields, follow-up request. The outcome type never changes.
- **Permission**: `job_outcomes.edit` over the job (managers; the technician who reported it cannot correct: `403`).
- **Request body** (strict): `reason` (required, kept in the audit trail) plus at least one field; `null` clears a nullable value. The reason / money / payment rules
  of recording apply to the result.
- **Response**: `200 { data: outcome }`. Changing amounts or payment needs the `financial` set (`403`); the currency must be the job's and cannot be corrected alone (`400`). **Audit**: `job_outcome.correct` with the FULL previous and new value of every changed field + reason (financial history, §25.4); job event `job.outcome_corrected`.

### GET /api/v1/job-outcomes/{id}/corrections

- **Purpose**: the correction history of an outcome, oldest first: `[{ at, byUserId, reason, changedFields, previous, next }]` (previous / new values of the changed fields), so an overwritten amount stays retrievable.
- **Permission**: `job_outcomes.edit` over the job AND the `financial` set (`403` without either; `404` outside scope). **Response**: `200 { data: [correction] }`.

### GET /api/v1/lost-reasons

- **Purpose**: the tenant's lost reasons in display order (`sortOrder`, `name`). Fields `id, code, name, description, appliesTo (outcomes), recoverable, active, sortOrder, createdAt, updatedAt`.
- **Permission**: `job_outcomes.view` (technicians read the list to choose). **Request query**: `includeInactive` (`true`; default hides retired reasons), `outcome` (only reasons applying to it).
- **Response**: `200 { data: [lostReason] }`.

### POST /api/v1/lost-reasons

- **Purpose**: add a lost reason. **Permission**: tenant-wide `job_outcomes.configure` (`403` otherwise; the role requires MFA).
- **Request body** (strict): `code` (lower-case letters, digits, `-`, `_`; unique per tenant), `name`; `description`, `appliesTo` (default NOT_SOLD, WORK_NOT_POSSIBLE),
  `recoverable` (default true; false = recovery can do nothing about it), `sortOrder`. **Idempotency**: supported.
- **Response**: `201 { data: lostReason }`. **Errors**: `400`, `403`, `409` duplicate code. **Audit**: `lost_reason.create`.

### GET /api/v1/lost-reasons/{id}

- **Permission**: `job_outcomes.view`. **Response**: `200 { data: lostReason }`; `404` for another tenant's id.

### PATCH /api/v1/lost-reasons/{id}

- **Purpose**: edit `name`, `description`, `appliesTo`, `recoverable`, `sortOrder` or retire / restore with `active`. Reasons are never deleted and the `code` never changes;
  outcomes keep a retired reason.
- **Permission**: tenant-wide `job_outcomes.configure`. **Response**: `200 { data: lostReason }`. **Audit**: `lost_reason.update`.

## Lead recovery (`/api/v1/lead-recovery`) - Phase 3

Code: `src/server/recovery` (README there), routes `src/app/api/v1/lead-recovery/**`, pure rules `src/lib/recovery-rules.ts`, case status machine
`src/lib/recovery-lifecycle.ts`. Design decisions: `DECISIONS.md` "Phase 3 Task 6".

The engine subscribes to `job.not_converted` (a `NOT_SOLD` / `WORK_NOT_POSSIBLE` outcome). Inside the outcome's own transaction it evaluates the
tenant's ACTIVE rules (priority order, scope = the rule's unit and below), creates at most one case per outcome and runs the rule actions. It
never blocks the outcome: a failing rule is rolled back to a savepoint and recorded as `skippedReason: "error"`. **There is no discount
action**: rules may create a case, set its priority, notify Lead Operations, create a follow-up task, or recommend a next step (`call_customer |
send_quote_reminder | schedule_revisit | review_manually`). Any key or value that mentions a discount is `400`.

**Rule content** (`conditions`, all optional, strict): `outcomes` (`NOT_SOLD | WORK_NOT_POSSIBLE`), `lostReasonIds`, `jobTypeIds`, `presence`
(`AT_LOCATION | LEFT_LOCATION | UNKNOWN`), `minValueMinor`, `maxValueMinor` (the visit's quote; never matches an unknown value),
`recoverableReason` (the reason's flag), `customerRequestedFollowUp`. `actions` (1-10): `{type:"create_case", priority?}`,
`{type:"set_priority", priority, score?}`, `{type:"notify", audience:"lead_operations"}`, `{type:"create_follow_up", dueInMinutes, priority?}`,
`{type:"recommend", code}`. `cooldownMinutes`: the same rule (any version of its key) does not fire again for the same customer inside the window.

**Rule lifecycle**: `DRAFT -> PENDING_APPROVAL -> ACTIVE <-> INACTIVE`, `ACTIVE -> SUPERSEDED` by a newer version. A rule is immutable once it leaves
DRAFT (edit = new version). `highImpact` is derived from the actions (notify, create_follow_up, a HIGH / URGENT case or URGENT priority) and cannot be
lowered by the author; such a rule must be submitted and approved with `recovery.approve` by someone OTHER than its author (`403`, also a database CHECK).
Other rules are activated directly with `recovery.manage`. Rule fields (`base`): `id, ruleKey, version, name, description, status, priority, trigger,
conditions, actions, orgUnitId, highImpact, cooldownMinutes, createdById, submittedAt, approvedById, approvedAt, activatedAt, createdAt, updatedAt`,
derived `needsApproval`.

**Case fields** (`base`): `id, number, jobOutcomeId, jobId, customerId, leadId, technicianId, orgUnitId, lostReasonId, status, statusChangedAt, priority,
priorityScore, assignedToId, assignedAt, ruleId, ruleVersion, recommendation, outcomeAt, presenceStatus, presenceEvaluatedAt, presenceAccuracyM,
presenceReason, presenceAgeMinutes, initialValueMinor, estimatedValueMinor, currency, recoveredAt, recoveredAmountMinor, collectedAmountMinor,
recoveredJobId, recoveredLeadId, recoveredById, attemptCount, lastAttemptAt, closedAt, closeReason, createdAt, updatedAt`, derived `nextStatuses` and
`revenue { currency, confirmed (null until recovered), estimated }`. **Presence is a status only**: `AT_LOCATION | LEFT_LOCATION | UNKNOWN` plus
accuracy, age and (when UNKNOWN) a reason `no_location | stale_location | inaccurate_location | no_coordinates | refresh_window_closed`. It is derived from the technician's latest
fresh and accurate location event and is an estimate, never proof; coordinates, the evidence event id and distances are never returned.

**Case statuses** (§9.5): `NEW -> ASSIGNED -> CONTACTING -> CUSTOMER_REACHED -> FOLLOW_UP_REQUIRED -> RECOVERED -> CLOSED`, with `NOT_RECOVERED` (reopenable to
`CONTACTING`) and `CLOSED` (final) as the other ends. Every change writes status history. Access: `recovery.view | edit | assign` over the case's service area
(ASSIGNED / OWN = the assigned recovery employee); out of scope is `404`. Lead Operations also gets `jobs.view` on a job that has a recovery case
(`recovery_related`), so the original job opens from the case.

### GET /api/v1/lead-recovery/rules

- **Permission**: `recovery.view`. **Purpose**: rules in scope, evaluation order; query `status`, `ruleKey`, `latestOnly` (default true), `cursor`, `limit`

### POST /api/v1/lead-recovery/rules

- **Permission**: `recovery.manage` over the unit. **Purpose**: create a DRAFT (`ruleKey`, `name`, `priority`, `conditions`, `actions`, `orgUnitId?`, `cooldownMinutes`); `409` duplicate key; audit `recovery_rule.create`

### GET /api/v1/lead-recovery/rules/{id}

- **Permission**: `recovery.view`. **Purpose**: one rule

### PATCH /api/v1/lead-recovery/rules/{id}

- **Permission**: `recovery.manage`. **Purpose**: edit a DRAFT in place; `409` otherwise; audit `recovery_rule.update`

### POST /api/v1/lead-recovery/rules/{id}/new-version

- **Permission**: `recovery.manage`. **Purpose**: copy into a new DRAFT (version + 1); `409` while another working version exists

### POST /api/v1/lead-recovery/rules/{id}/submit

- **Permission**: `recovery.manage`. **Purpose**: DRAFT -> PENDING_APPROVAL (high impact only)

### POST /api/v1/lead-recovery/rules/{id}/activate

- **Permission**: `recovery.approve` (high impact, not the author) / `recovery.manage`. **Purpose**: activate; supersedes the older ACTIVE version; audit `recovery_rule.approve` / `.activate`

### POST /api/v1/lead-recovery/rules/{id}/deactivate

- **Permission**: `recovery.manage` (ACTIVE) / `recovery.approve` (reject PENDING_APPROVAL). **Purpose**: audit `recovery_rule.deactivate` / `.reject`

### POST /api/v1/lead-recovery/rules/dry-run

- **Permission**: `recovery.manage`. **Purpose**: body `jobOutcomeId` + exactly one of `ruleId` / `definition`, optional `presence` what-if; answers `matched, wouldFire, skippedReason, checks[], cooldown, presence (status only), existingCaseId, highImpact, actions`; writes nothing

### GET /api/v1/lead-recovery/cases

- **Permission**: `recovery.view`. **Purpose**: the queue, newest outcome first; query `status`, `open`, `priority`, `assignedToId` (id, `me`, `none`), `customerId`, `jobId`, `orgUnitId`, `presenceStatus`

### GET /api/v1/lead-recovery/cases/{id}

- **Permission**: `recovery.view`. **Purpose**: the case plus `attempts`, `statusHistory`, `followUps`

### PATCH /api/v1/lead-recovery/cases/{id}

- **Permission**: `recovery.edit`. **Purpose**: `estimatedValueMinor` (an estimate), `priority` of an open case

### POST /api/v1/lead-recovery/cases/{id}/assign

- **Permission**: `recovery.assign`. **Purpose**: `{ assigneeId }` (`null` unassigns); the assignee must be an active employee with a login who can view the case; notified

### POST /api/v1/lead-recovery/cases/{id}/status

- **Permission**: `recovery.edit`. **Purpose**: `status` in `CONTACTING, CUSTOMER_REACHED, FOLLOW_UP_REQUIRED, NOT_RECOVERED, CLOSED`; the last two need `reason`; `409` for an invalid move

### POST /api/v1/lead-recovery/cases/{id}/attempts

- **Permission**: `recovery.edit`. **Purpose**: one communication attempt (`channel`, `outcome?`, `occurredAt?`, `durationSeconds?`, `notes?`, `offeredAmountMinor?` entered by the employee); first attempt moves NEW / ASSIGNED to CONTACTING

### POST /api/v1/lead-recovery/cases/{id}/recover

- **Permission**: `recovery.edit`. **Purpose**: confirm: `recoveredAmountMinor`, `collectedAmountMinor?`, `recoveredJobId?`, `recoveredLeadId?` (same customer, not the original job), `recoveredAt?`; status RECOVERED; the estimate is untouched

### POST /api/v1/lead-recovery/cases/{id}/refresh-presence

- **Permission**: `recovery.edit`. **Purpose**: re-evaluate presence now (status snapshot). Allowed only within `presenceMaxAgeMinutes` after the outcome and only from the technician's location events recorded for the case job; otherwise the snapshot is `UNKNOWN` with reason `refresh_window_closed` (or `no_location`)

### GET /api/v1/lead-recovery/summary

- **Permission**: `recovery.view`. **Purpose**: cases by status; CONFIRMED recovered revenue and ESTIMATED value of open cases per currency, never added together; query `from`, `to`, `orgUnitId`

Errors: `400` validation (discount, unknown key, bad range), `403` missing permission or SoD, `404` missing or out of scope, `409` conflict or invalid
transition. Audit actions: `recovery.case_create` (system), `recovery.case_annotate`, `recovery.case_assign`, `recovery.case_status_change`,
`recovery.case_update`, `recovery.attempt_record` (no notes), `recovery.case_recover`, `recovery.presence_refresh`, plus the `recovery_rule.*` actions above.
Notifications: `recovery.case_created` (to holders of `recovery.assign`, else `recovery.view`, over the case's unit, created in the outcome transaction and
delivered by the pending-notification sweep) and `recovery.case_assigned` (to the new owner).
## Field execution (`/api/v1/jobs/{id}/...`, `/api/v1/completion-forms`) - Phase 3

What a technician records during a visit (§8.5, §8.6). Module `field-execution`; design in `DECISIONS.md` "Phase 3 Task 4".

**Common rules.** Writes need `jobs.edit` over the job (a Technician: the job must be assigned to them, else `404`), reads `jobs.view`; the job must be
`EN_ROUTE` or later and not `CLOSED` / `CANCELLED` (`409`, detail `job_field.not_in_field_state`). Every write takes the offline envelope `clientEventId` (UUID) and
`occurredAt` (ISO, at most 5 minutes ahead and 7 days back) and `deviceId`: with a `clientEventId` the write is idempotent per employee through the shared
field-event gate: a repeat answers `200` with `replayed: true` and the first result (access is re-checked), the same id with different content is
`409` (`CLIENT_EVENT_ID_REUSED`), a business refusal is remembered. Success is `201 { data: { <record>, replayed: false } }`. Lists are `{ data, page }`, newest first.
Free text appears only in the record itself; events, audit and the offline log carry ids and kinds. Amounts are integer minor units.

### GET /api/v1/jobs/{id}/notes

- The job's notes (record shape as in the POST below), newest first: `200 { data: [...], page }`. **Permission**: `jobs.view` over the job (`404` outside scope). Query `cursor`, `limit`.

### POST /api/v1/jobs/{id}/notes

- **Body** (strict): `kind` (`NOTE` default | `WORK_PERFORMED` | `ADDITIONAL_WORK_REQUESTED` | `CUSTOMER_APPROVAL`), `body` (1-4000), `amountMinor` (only for additional
  work and approval; needs the `financial` set of `job_outcomes.view`, else `403`; hidden from readers without it), `currency` (must be the job's), `customerApproved`
  (required for `CUSTOMER_APPROVAL`, forbidden otherwise), envelope. **Response**: `{ note: { id, jobId, employeeId, kind, body, amountMinor?, currency?, customerApproved, occurredAt, recordedAt, clientEventId }, replayed }`.
- **Audit** `job_note.record`; job events `job.field_note.<kind>` (ids only). Labels: `FIELD.NOTE.KIND.*`.

### GET /api/v1/jobs/{id}/materials

- The job's materials (record shape as in the POST below), newest first: `200 { data: [...], page }`. **Permission**: `jobs.view` over the job (`404` outside scope). Query `cursor`, `limit`.

### POST /api/v1/jobs/{id}/materials

- **Body** (strict): `name`, `quantity` (positive, at most 3 decimals), `unit` (default `each`), `materialRef` (placeholder for the Phase 4 catalog), `note`, envelope.
  **Response**: `{ material: { id, jobId, completionId, name, materialRef, quantity, unit, note, occurredAt, ... }, replayed }`. `completionId` is set when the visit's completion is submitted.

### GET /api/v1/jobs/{id}/attachments

- The job's attachments (record shape as in the POST below), newest first: `200 { data: [...], page }`. **Permission**: `jobs.view` over the job (`404` outside scope). Query `cursor`, `limit`.

### POST /api/v1/jobs/{id}/attachments

- **Purpose**: metadata of a photo, signature or document captured on the device. **No file is stored**: no storage provider is configured, so every row is `PENDING_UPLOAD` and `storageConfigured` is `false`.
- **Body** (strict): `kind` (`PHOTO` default | `SIGNATURE` | `DOCUMENT`), `fileName`, `contentType` (`type/subtype`), `sizeBytes` (1 - 104857600), `checksumSha256`, `caption`, `capturedAt`, envelope.
  **Response**: `{ attachment: { id, jobId, kind, status, fileName, contentType, sizeBytes, checksumSha256, caption, capturedAt, recordedAt, storageConfigured }, replayed }`. Labels `FIELD.ATTACHMENT.KIND.*`, `FIELD.ATTACHMENT.STATUS.*`.

### POST /api/v1/jobs/{id}/attachments/{attachmentId}/upload

- **Purpose**: ask the storage provider for an upload target. With no provider configured this is refused: `409`, detail code `storage.not_configured` (translate `FIELD.STORAGE_NOT_CONFIGURED`), nothing changes.
  With a provider: `200 { data: { url, storageKey, expiresAt } }`. `404` for an attachment of another job. **Permission**: `jobs.edit` over the job.

### GET /api/v1/jobs/{id}/completion/form

- The ACTIVE form for the job's type (its own, else its category's) `{ form: { id, version, name, schema }, visitNumber, alreadySubmitted, progress: { hasOutcome, materialCount, photoCount } }`.
  `404` when the type has no active form. Needs `completion_forms.view`. `schema.fields[]` is `{ key, type, required, labelKey }`; keys: `outcome, quotedAmount, approvedAmount, finalChargedAmount, amountCollected, paymentMethod, paymentStatus, materials, photos, notes, customerSignature, followUpRequired` (labels `COMPLETION_FORM.FIELD.*`).
### POST /api/v1/jobs/{id}/completion

- Needs `completion_forms.view` too; job `IN_PROGRESS` or `COMPLETED`): **Body** (strict): `notes`, `workPerformed`, `followUpRequired`, `signatureAttachmentId` (a SIGNATURE attachment of this job), envelope.
  The form states which FACTS must exist: the visit's outcome and amounts (record the outcome first), materials, photo metadata, a signature. Missing required ones: `400` with one detail per key (`completion.field_required`, `field` = the key).
  Money, payment, materials and signature fields are enforced only for a `SOLD` visit. Answers for fields the form does not contain: `400 completion.field_not_in_form`. Errors: `409` `completion.no_active_form`, `completion.already_submitted` (one per visit), `completion.not_ready`.
  **Response** `201 { data: { completion: { id, jobId, visitNumber, employeeId, formDefinitionId, formVersion, values, workPerformed, followUpRequired, signatureAttachmentId, occurredAt, submittedAt }, replayed } }`.
  It does not change the job status. **Audit** `job_completion.submit`; job event `job.completion_submitted`.
### GET /api/v1/jobs/{id}/completion

- The completions of the job (one per visit), newest visit first (`jobs.view` over the job): `{ data: [completion], page }`.

### GET /api/v1/completion-forms

- Form definitions, newest first. Query: `jobTypeId`, `category`, `status` (`DRAFT | ACTIVE | RETIRED`), `cursor`, `limit`. **Permission**: `completion_forms.view`.
- Definitions are versioned per job type XOR category; writing needs a tenant-wide `completion_forms.configure` (the role requires MFA). **Audit**: `completion_form.create | update | publish`.

### POST /api/v1/completion-forms

- Body: `jobTypeId` XOR `category`, `name`, `schema { fields[] }` -> `201` a DRAFT with `version` = highest + 1. The schema is validated (closed key vocabulary, type per key, unique keys, `labelKey` an i18n key): `400` with `completion_form.*` detail codes. Idempotency-Key supported.

### GET /api/v1/completion-forms/{id}

- One definition version (`completion_forms.view`; `404` for another tenant's id).

### PATCH /api/v1/completion-forms/{id}

- Edits a DRAFT (`name`, `schema`); a published version is immutable: `409 completion_form.not_a_draft` (create a new version).

### POST /api/v1/completion-forms/{id}/publish

- Makes the DRAFT the ACTIVE version and RETIRES the previous one atomically. Every completion keeps the `(formDefinitionId, formVersion)` it was filled in with.

## Offline sync (`/api/v1/field-sync`) - Phase 3

### POST /api/v1/field-sync

- **Purpose**: apply a batch of offline field events (§8.7, §25.3). **Auth**: session of an employee (`403` otherwise). There is no endpoint-level permission: each event is authorized by the module that owns its type, exactly like its REST endpoint.
- **Body** (strict): `batchId` (client-generated, 8-100 of `A-Za-z0-9_-`), `events` (1-100) of `{ clientEventId (UUID), type, occurredAt (ISO), jobId?, payload }`. `payload` is what the type's REST endpoint takes as a body without `clientEventId` / `occurredAt`.
  Types today: `job.en_route` (payload empty), `job.arrive`, `job.start_work`, `job.note`, `job.material`, `job.attachment`, `job.completion`, `job.outcome` (need `jobId`), `shift.start`, `shift.end` (the caller's own shift), `location.departure`, `location.navigation_opened` (need `jobId`). Modules built later register more; an unknown type is reported per event as `UNSUPPORTED`.
- **Processing**: events are applied in `occurredAt` order (ties keep the order sent), each through its module and the shared idempotency gate, each in its own transaction. One failing event never stops the batch. The `batchId` is stored on every event's `FieldEvent` row (a replay keeps its first batch).
- **Response**: always `200` for a well-formed batch: `{ data: { batchId, receivedAt, summary: { total, accepted, replayed, rejected, conflict, forbidden, unsupported, failed }, results: [ { index, clientEventId, type, sequence, status, code?, message?, details?, retryable, result? } ] } }`
  in the order sent (`index`); `sequence` is the order applied. `status`: `ACCEPTED` (applied; `result` = what the endpoint would answer), `REPLAYED` (already applied earlier, same answer), `REJECTED` (a verdict on the content is remembered: send a corrected event with a new id; with `retryable: true` it was caused by order or configuration, is NOT remembered and the same event may be sent again once the earlier events synced),
  `CONFLICT` (the id was used for different content, or the module refused with a conflict), `FORBIDDEN` (not allowed or not visible; not remembered; retryable only for a job not yet visible to the caller), `UNSUPPORTED`, `FAILED` (server problem, `retryable: true`). Labels `FIELD.SYNC.STATUS.*`.
- **Errors** (whole request): `400` malformed batch (empty, over 100 events, bad ids / times / type), `401`, `403` caller is not an employee. Sending the same batch again is safe.

## Approvals (`/api/v1/approvals`) - Phase 4

Code: `src/server/approvals` (README there), routes `src/app/api/v1/approvals/**`, pure rules `src/lib/approval-rules.ts`. Design decisions:
`DECISIONS.md` "Phase 4 Task 3". One generic engine decides material cost changes, refunds, adjustments and chargeback write-offs (§21.3, §11.5);
the subject modules open requests inside their own transaction (`createApprovalRequestInTx`) and are called back when a request ends. There is no
endpoint that creates a request: a request is always a side effect of the change that needs it.

**Who sees a request**: every endpoint needs `approvals.view`. Beyond it a request is visible to its requester, to an *eligible approver* (holds
the policy's `approverPermission`, e.g. `finance_refunds.approve`, over the request's org unit), and to an *overseer* (`approvals.manage` over the
unit). Anything else is `404`. The unit is snapshotted from the subject at creation (`orgUnitId`; null = tenant-level, TENANT scope only).
`amountMinor`, `currency` and `details` are shown only to the requester and to eligible approvers; an overseer gets `moneyRedacted: true` and no
amount fields.

**Request fields** (`ApprovalRequest`): `id, subjectType (MATERIAL_COST_CHANGE | ADJUSTMENT | REFUND | CHARGEBACK_WRITE_OFF | HIGH_VALUE_DISCOUNT),
subjectId, status (PENDING | APPROVED | REJECTED | CANCELLED | EXPIRED), policyId, policyCode, policyVersion, requiredApprovals (1 | 2),
approverPermission, amountMinor (decimal string), currency, details (ids, codes and amounts only), jobId, customerId, orgUnitId, reason,
requestedById (null = system), excludedApproverIds, requestedAt, expiresAt, decidedAt, cancelledAt, cancelledById, cancelReason`, derived
`approvalCount`, `decisions [{ deciderId, decision, comment, decidedAt }]`, `viewer { isRequester, canDecide, canCancel, myDecision }`,
`moneyRedacted`. Labels: `APPROVAL.STATUS.*`, `APPROVAL.SUBJECT.*`, `APPROVAL.DECISION.*`.

**Separation of duties**: the requester and everyone in `excludedApproverIds` (the subject's editors / submitters, set by the subject module) can
never decide (`403`, audited as `approval_request.decide` with outcome `DENIED`; a database trigger refuses it too). Each person decides once.
**Dual approval**: `requiredApprovals: 2` needs two different people; any rejection ends the request. **Expiry**: a request past `expiresAt` leaves
the queue at once; deciding or cancelling it marks it EXPIRED and answers `409`; the worker sweep `expireDueApprovalRequestsForAllTenants()` expires
the rest. Notifications: `approval.requested` to eligible approvers in scope, `approval.decided` to the requester (no params, link to the request).

### GET /api/v1/approvals/queue

- **Permission**: `approvals.view`. **Purpose**: PENDING, unexpired requests the caller can decide now (approver permission over the unit, not the
  requester, not excluded, not yet decided by them), oldest first. Query: `subjectType?`, `cursor`, `limit`.

### GET /api/v1/approvals/mine

- **Permission**: `approvals.view`. **Purpose**: the caller's own requests, newest first. Query: `status?`, `subjectType?`, `cursor`, `limit`.

### GET /api/v1/approvals

- **Permission**: `approvals.view` + `approvals.manage` (scope-filtered). **Purpose**: oversight list, newest first. Query: `status?`,
  `subjectType?`, `subjectId?`, `cursor`, `limit`.

### GET /api/v1/approvals/{id}

- **Permission**: `approvals.view` and one of requester / eligible approver / overseer (`404` otherwise). **Purpose**: one request with its decisions.

### POST /api/v1/approvals/{id}/decide

- **Permission**: `approvals.view` plus the request's `approverPermission` over its unit (`403` without the grant, `404` outside its scope), not the
  requester or an excluded editor (`403`). **Body** (strict): `decision: APPROVE | REJECT`, `comment?` (required for REJECT, max 2000).
  `Idempotency-Key` supported. **Answers** the request as the caller now sees it. The final decision runs the subject's callback in the same
  transaction (the subject moves on, or nothing is stored). **Errors**: `409 CONFLICT` already decided by the caller;
  `409 INVALID_STATE_TRANSITION` not pending or expired. Audit: `approval_request.decide` per decision, then `approval_request.approved` / `.rejected`.

### POST /api/v1/approvals/{id}/cancel

- **Permission**: `approvals.view`; the requester or `approvals.manage` over the unit (`403` otherwise). **Body**: `{ reason }` (max 500).
  **Purpose**: PENDING -> CANCELLED; the subject is told (`onRejected`, outcome CANCELLED). `409` when no longer pending. Audit `approval_request.cancelled`.

### GET /api/v1/approvals/policies

- **Permission**: `approvals.configure` (tenant-level). **Purpose**: policies, active versions by default (`activeOnly=false` for history). Query:
  `subjectType?`, `code?`. Fields: `id, code, subjectType, name, version, active, currency, minAmountMinor, maxAmountMinor, requiredApprovals,
  approverPermission, expiresAfterHours, createdById, createdAt, updatedAt`.

### POST /api/v1/approvals/policies

- **Permission**: `approvals.configure` (tenant-level). **Body** (strict): `code` (`[a-z0-9][a-z0-9_.-]*`), `subjectType`, `name`, `currency`
  (default USD), `minAmountMinor` (default 0), `maxAmountMinor` (null = open), `requiredApprovals` (1 | 2), `approverPermission` (a catalog
  `*.approve` key), `expiresAfterHours` (null = never). An existing `code` becomes version + 1 and the previous version is deactivated (same subject
  type required, `400` otherwise). A band overlapping another active policy of the subject type and currency is `409`. Pending requests keep the
  version they were made with. Audit `approval_policy.create` / `.new_version`.

### POST /api/v1/approvals/policies/{id}/deactivate

- **Permission**: `approvals.configure` (tenant-level). **Body**: `{ reason }`. **Purpose**: the version stops applying to new requests; `409` when
  not active. Audit `approval_policy.deactivate`.
## Finance: ledger, payments, revenue confirmation, provider intake (`/api/v1/finance/**`) - Phase 4

Code: `src/server/ledger`, `src/server/payments` (READMEs there), pure balance rules `src/lib/ledger-balances.ts`, routes
`src/app/api/v1/finance/**`. Spec 11.1, 11.8, 18.3, 26.3, 26.4. Design decisions: `DECISIONS.md` "Phase 4 Task 4".

Conventions for every finance endpoint:
- **Money** is a decimal STRING of minor units in responses; requests take a JSON integer or a decimal string (`API_CONVENTIONS.md` "Money").
- **Scope**: finance reaches records through TENANT, LEGAL_ENTITY and ORG_UNIT scopes only (a job's service-area unit; OWN / ASSIGNED
  never match finance). Ledger entries are scoped by the unit / legal entity snapshot taken at posting; jobs, job balances and payments by
  the job's current unit. Out of scope = `404` (audited denial), no grant at all = `403`.
- **What is returned**: ids, money, finance enums and codes only. No job titles, addresses or customer names (the Finance Director sees a
  job only through its `financial` field set).
- **Balance** object (one per currency): `currency, chargedMinor, adjustedMinor, billedMinor (= charged + adjusted), collectedMinor,
  refundedMinor, chargedBackMinor, netCollectedMinor (= collected - refunded - charged back), outstandingMinor (= billed - net collected;
  negative = customer in credit), materialCostMinor, paymentStatus`. `paymentStatus`: `NOT_CHARGED | UNPAID | PARTIAL | PAID | OVERPAID |
  REFUNDED` (labels `FINANCE.PAYMENT_STATUS.*`; rule in `src/lib/ledger-balances.ts`). A REVERSAL counts under the type it reverses.
- **Ledger entry** fields: `id, type (CHARGE | PAYMENT | REFUND | CHARGEBACK | ADJUSTMENT | REVERSAL | MATERIAL_COST), source (JOB | OUTCOME |
  PAYMENT | REFUND | CHARGEBACK | ADJUSTMENT | MATERIAL_USAGE | REVERSAL), amountMinor (signed), currency, jobId, customerId, outcomeId,
  paymentId, refundId, chargebackId, adjustmentId, materialUsageId, orgUnitId, legalEntityId, reversesEntryId, reversedByEntryId,
  idempotencyKey, actorUserId, systemActor, memo, occurredAt, recordedAt`. Labels `FINANCE.LEDGER.TYPE.*`, `FINANCE.LEDGER.SOURCE.*`.
- **Payment** fields: `id, jobId, customerId, outcomeId, method (CASH | CARD | CHECK | BANK_TRANSFER | FINANCING | OTHER), status (PENDING |
  RECEIVED | FAILED | VOIDED), origin (MANUAL | PROVIDER), amountMinor, currency, reference, provider, providerRef, intakeEventId, orgUnitId,
  receivedAt, failedAt, failureReason, voidedAt, voidReason, recordedById, createdAt, updatedAt`. Labels `FINANCE.PAYMENT.*`.
- Error detail codes are translated by clients as `FINANCE.ERROR.<CODE UPPERCASED>` (`ledger.wrong_sign` > `FINANCE.ERROR.LEDGER.WRONG_SIGN`).

### GET /api/v1/finance/ledger/entries
- **Purpose**: ledger entries in the caller's scope, newest first (`occurredAt desc, id desc`). **Permission**: `finance_ledger.view`.
- **Query**: `cursor, limit, jobId, customerId, outcomeId, paymentId, legalEntityId, type, occurredFrom, occurredTo` (ISO, `[from, to)`).
- **Response**: `200 { data: [entry], page }`. Entries are never edited or deleted: a correction appears as a REVERSAL entry.

### GET /api/v1/finance/ledger/entries/{id}
- One entry (`finance_ledger.view` over its snapshot unit / legal entity). `200 { data: entry }`, `404`.

### POST /api/v1/finance/ledger/entries/{id}/reverse
- **Purpose**: reverse a posted CHARGE (the only correction of a charge). **Permission**: `finance_payments.edit` over the entry's job.
- **Body** (strict): `{ reason }` (1-500 chars, stored as the reversal's memo and in the audit).
- **Response**: `201 { data: { reversal: entry, replayed: false } }`; reversing the same charge again is `200` with `replayed: true`.
- **Errors**: `409 INVALID_STATE_TRANSITION` `ledger.reverse_not_supported` (not a CHARGE: void the payment / use Task 5 flows),
  `ledger.reversal_not_reversible`, `ledger.already_reversed`. **Audit**: `ledger.reverse` (with reason).

### GET /api/v1/finance/jobs/{id}/balance
- **Purpose**: derived balances and payment status of one job. **Permission**: `finance_ledger.view` over the job.
- **Response**: `200 { data: { jobId, customerId, balances: [balance] } }` (`balances: []` = nothing posted).

### GET /api/v1/finance/job-balances
- Jobs in scope that have ledger entries, newest job first, each with its balances. **Permission**: `finance_ledger.view`.
- **Query**: `cursor, limit, customerId`. **Response**: `200 { data: [{ jobId, customerId, balances }], page }`.

### GET /api/v1/finance/customers/{id}/balance
- **Purpose**: a customer's balances over the entries the caller may see. **Permission**: `finance_ledger.view`.
- **Query**: `occurredFrom, occurredTo`. **Response**: `200 { data: { customerId, coverage: TENANT | SCOPE, balances } }` (`SCOPE` = only
  entries in the caller's units / legal entities were summed; labels `FINANCE.BALANCE.COVERAGE.*`). A scoped caller who sees no entry of
  the customer gets `404` (existence is not confirmed).

### GET /api/v1/finance/legal-entities/{id}/balance
- **Purpose**: totals of one legal entity (entries whose legal-entity snapshot is it). **Permission**: `finance_ledger.view` with a TENANT
  scope or a LEGAL_ENTITY scope on that entity (a unit-scoped manager gets `404`). **Query**: `occurredFrom, occurredTo`.
- **Response**: `200 { data: { legalEntityId, balances } }`.

### GET /api/v1/finance/payments
- Payments in scope (through the job), newest first. **Permission**: `finance_payments.view`.
- **Query**: `cursor, limit, jobId, outcomeId, status, method, origin`. **Response**: `200 { data: [payment], page }`.

### POST /api/v1/finance/payments
- **Purpose**: record a payment by hand (cash, check, card terminal, bank transfer...). **Permission**: `finance_payments.create` over the job
  (Owner, Finance Director; COO and unit managers view only).
- **Headers**: `Idempotency-Key` **required** (`400 payment.idempotency_key_required` otherwise). It becomes the payment's own key (scoped to
  the recording user), so double submits and concurrent duplicates create ONE payment and ONE ledger entry, even after the 24 h request store.
- **Body** (strict): `jobId, method, amountMinor (> 0)`, optional `currency` (must be the job's: `400 payment.currency_mismatch`),
  `reference` (<= 120; **required** for CHECK, CARD, BANK_TRANSFER), `status` (`RECEIVED` default | `PENDING`), `receivedAt` (RECEIVED only,
  default now, never more than 5 minutes ahead).
- **Response**: `201 { data: { payment, replayed: false } }` (the request store replays it verbatim with `Idempotent-Replayed: true`).
  RECEIVED posts a PAYMENT entry (`payment:<id>:received`) in the same transaction; PENDING posts nothing yet.
- **Errors**: `400`, `403`, `404` (job out of scope or missing), `409` (`payment.idempotency_key_reused`; in-flight duplicate, retryable).
  **Audit**: `payment.record`.

### GET /api/v1/finance/payments/{id}
- One payment (`finance_payments.view` over its job). `200 { data: payment }`.

### POST /api/v1/finance/payments/{id}/receive

### POST /api/v1/finance/payments/{id}/fail

### POST /api/v1/finance/payments/{id}/void

The three status changes share one description:
- **Purpose**: status changes (DB machine: PENDING > RECEIVED | FAILED | VOIDED, RECEIVED > VOIDED). **Permission**: `finance_payments.edit` over
  the payment's job.
- **Body**: `receive` `{ receivedAt? }`; `fail` and `void` `{ reason }` (required). `receive` posts the PAYMENT entry; `void` of a RECEIVED
  payment posts the REVERSAL of that entry (`payment:<id>:void`); `fail` posts nothing.
- **Response**: `200 { data: { payment, replayed } }`; asking for the status the payment already has is a replay (also under concurrency:
  one change, one posting). **Errors**: `409 INVALID_STATE_TRANSITION` `payment.invalid_transition`. **Audit**: `payment.receive | fail | void`
  (previous and new status, reason).

### GET /api/v1/finance/charges-to-confirm
- **Purpose**: the revenue confirmation queue: SOLD outcomes carrying a charged or collected amount, oldest first. **Permission**:
  `finance_payments.view` over the job AND the outcome `financial` field set (`job_outcomes.view`); rows without that set are left out.
- **Query**: `cursor, limit, jobId, state` (`pending` default: a charge or collection not yet posted; `all`).
- **Response**: `200 { data: [{ outcomeId, jobId, customerId, visitNumber, occurredAt, currency, chargedAmountMinor, collectedAmountMinor,
  paymentMethod, reportedPaymentStatus, charge: { state, postedMinor, entryId }, collection: { state, recordedMinor, paymentId } }], page }`.
  `state`: `NOT_REQUIRED | PENDING | POSTED | MISMATCH` (`MISMATCH` = the outcome was corrected after posting; labels `FINANCE.REVENUE.STATE.*`).

### POST /api/v1/finance/outcomes/{id}/charge
- **Purpose**: post the outcome's CHARGE (source OUTCOME, `occurredAt` = the visit). **Permission**: `finance_payments.create` over the job plus
  the outcome `financial` set (`403 revenue.financial_set_required`).
- **Body** (strict): `{ expectedAmountMinor }`: the amount the confirmer saw; a different current amount is `409 revenue.outcome_changed`.
- **Response**: `201 { data: { entryId, amountMinor, currency, replayed: false, balances } }`; confirming again is `200`, `replayed: true`.
- **Errors**: `409 revenue.nothing_to_charge` (not SOLD / no amount), `revenue.charge_already_posted` (another active charge with a different
  amount: reverse it, then confirm again; the key becomes `outcome:<id>:charge:<n+1>`). **Audit**: `revenue.charge_confirm`.

### POST /api/v1/finance/outcomes/{id}/collection
- **Purpose**: record the collection the technician reported as a RECEIVED MANUAL payment linked to the outcome (`receivedAt` = the visit)
  and post its PAYMENT entry. **Permission**: as `/charge`.
- **Body** (strict): `{ expectedAmountMinor, method?, reference? }` (`method` defaults to the outcome's, `400 revenue.method_required` when
  neither has one; `reference` required for CHECK, CARD, BANK_TRANSFER).
- **Response**: `201 { data: { payment, replayed: false, balances } }`; again = `200` replay. **Errors**: `409 revenue.nothing_to_collect`,
  `revenue.outcome_changed`, `revenue.collection_already_recorded` (void it first). **Audit**: `revenue.collection_confirm`.

### POST /api/v1/finance/intake/{tenantSlug}/{provider}
- **Purpose**: a payment provider's webhook. **Auth**: no session; the PROVIDER authenticates the delivery (its signature over the raw body
  with its per-tenant secret). JSON body, at most 1 MB.
- **This build has no provider**: every call answers `409 CONFLICT` with detail code `payment_provider.not_configured` and writes nothing
  (an unknown tenant answers the same; label `FINANCE.PROVIDER.NOT_CONFIGURED`).
- With a provider installed (`registerPaymentProvider`): bad signature `401` (logged as a REJECTED event under `unverified:<sha256>`, never
  under the id the body claims); otherwise the event is stored first, then validated and applied, and the answer is `200 { data: { eventId,
  status (ACCEPTED | REJECTED | DUPLICATE | UNMATCHED), rejectionCode, paymentId, duplicate } }` (labels `FINANCE.INTAKE.STATUS.*`,
  `FINANCE.INTAKE.REJECTION.*`: `malformed_event`, `invalid_event_fields`, `unsupported_event_type`, `unknown_job`, `currency_mismatch`,
  `duplicate_provider_ref`). A repeated delivery (same provider + event id, sequential or concurrent) returns the event on record with
  `duplicate: true` and never posts twice; the same id with different content is `409 payment_intake.payload_mismatch`. ACCEPTED creates
  a PROVIDER payment (RECEIVED) and its PAYMENT entry by `system:provider-intake`. **Audit**: `payment_intake.process` (system actor).

### GET /api/v1/finance/intake-events
- The intake log, newest first (hashes and normalized fields only). **Permission**: `finance_payments.view` with a TENANT scope (`403`
  otherwise). **Query**: `cursor, limit, provider, status`. **Response**: `200 { data: [event], page }`.

### GET /api/v1/finance/payment-providers
- `200 { data: { configured: [] } }`: the provider keys this deployment accepts events from (empty: "not configured"). **Permission**:
  `finance_payments.view`.

## Materials (`/api/v1/materials`) - Phase 4

Code: `src/server/materials` (README there), routes `src/app/api/v1/materials/**`, pure rules `src/lib/material-cost-rules.ts`. Design decisions:
`DECISIONS.md` "Phase 4 Task 2". Spec 11.4 (material costs), 25.4 (historical integrity).

**Access**: materials are tenant-wide reference data (no org unit). Reading the catalog is the `materials.view` capability (any scope: technicians
pick from it); `materials.create` / `.edit` / `.archive` need TENANT scope (`403`). **Costs are the opt-in `cost` field set**
(`materials.cost_fields`, Owner and Finance Director by default): `currentCost` / `pendingCost` are projected away without it; the cost history,
proposing or withdrawing a cost and every job-costing endpoint answer `403` without it. Job-costing endpoints also need `jobs.view` over the job
(`404` outside scope).

**Material fields**: `id, code, name, description, unit, supplier, active, archivedAt, createdById, createdAt, updatedAt` (base);
`currentCost`, `pendingCost` (`cost` set): `{ versionId, versionNumber, unitCostMinor (decimal string), currency, effectiveFrom, effectiveTo,
status, approvalRequestId }` or null. `currentCost` is the APPROVED version in effect now.

**Cost version fields** (`MaterialCostVersion`): `id, materialId, versionNumber, unitCostMinor, currency, effectiveFrom, effectiveTo,
status (PENDING_APPROVAL | APPROVED | REJECTED | CANCELLED), approvalRequestId (null = no policy applied), note, createdById, createdAt,
approvedAt`. Labels: `MATERIAL.COST_STATUS.*`. A cost is never edited: a change is a new version. Approving a version effective at D closes the
current approved version at D (`effectiveTo = D`); approved versions never overlap. One pending version per material.

**Costing** (`JobMaterialUsage`): a usage line is costed once with the APPROVED version in effect at the line's `occurredAt`;
`extendedCostMinor = quantity x unitCostMinor`, rounded half-even to whole minor units. The snapshot (`materialId, costVersionId,
unitCostMinor, extendedCostMinor, costCurrency, costedAt`) and the quantity are frozen by the database; later cost changes never rewrite it.
Line view: `usageId, jobId, employeeId, name, materialRef, materialId, quantity (number), unit, occurredAt, costed, costVersionId,
unitCostMinor, extendedCostMinor, currency, costedAt`. Skip / refusal codes (detail `code`, labels `MATERIAL.COSTING.*`):
`material.usage_already_costed`, `material.usage_not_linked` (no material and no `materialRef` matching a code), `material.unit_mismatch` (no
unit conversion), `material.no_effective_cost`, `material.cost_out_of_range`, `material.usage_linked_elsewhere`.

### GET /api/v1/materials

- **Permission**: `materials.view`. **Purpose**: the catalog by code. Query: `includeArchived` (`true|false`, default false), `q?` (code or name
  contains), `cursor`, `limit`. Cost fields per the `cost` set.

### POST /api/v1/materials

- **Permission**: `materials.create` (TENANT). **Body** (strict): `code` (`[a-z0-9][a-z0-9_.-]*`, unique per tenant, `409`), `name`,
  `description?`, `unit` (default `each`), `supplier?`. No cost (see `/costs`). `Idempotency-Key` supported. Audit `material.create`.

### GET /api/v1/materials/{id}

- **Permission**: `materials.view`. **Purpose**: one material (`404` when missing or of another tenant).

### PATCH /api/v1/materials/{id}

- **Permission**: `materials.edit` (TENANT). **Body** (strict, at least one): `name`, `description` (null clears), `supplier` (null clears),
  `unit`. The unit is locked once the material has a cost version or linked usage (`409`, detail `material.unit_locked`). Archived: `409`.
  Audit `material.update` (changed fields).

### POST /api/v1/materials/{id}/archive

- **Permission**: `materials.archive` (TENANT). **Body**: `{ reason? }`. **Purpose**: leaves the active catalog; a pending cost change is
  CANCELLED with its approval request. History and costed usage stay; past usage can still be costed. `409` when already archived. Audit
  `material.archive`.

### GET /api/v1/materials/{id}/costs

- **Permission**: `materials.view` + `cost` set (`403`). **Purpose**: the cost history, newest version first. Query: `status?`, `cursor`, `limit`.

### POST /api/v1/materials/{id}/costs

- **Permission**: `materials.create` (TENANT) + `cost` set. **Body** (strict): `unitCostMinor` (integer or decimal string), `currency` (ISO 4217,
  required), `effectiveFrom` (ISO-8601 with offset), `note?`. **Answers** `201 { version, approvalRequired, approvalRequestId }`: with an active
  `MATERIAL_COST_CHANGE` policy the version is PENDING_APPROVAL and an approval request is opened (the proposer is the requester and cannot
  approve it; deciding goes through `/api/v1/approvals/{id}/decide` with the policy's permission, default `materials.approve`, at TENANT scope);
  without a policy it is APPROVED at once. The version takes effect on `effectiveFrom`, whenever it is approved. **Errors**: `409
  INVALID_STATE_TRANSITION` archived material; `409 CONFLICT` a version is already pending, `effectiveFrom` not after the current version's
  start (`material.cost_not_after_current`), or a usage at/after `effectiveFrom` is already costed with the current version
  (`material.cost_before_costed_usage`); `400` a currency no policy covers. The same placement check runs again at approval: if it fails then, the
  decision answers `409` and nothing is stored (reject the request instead). Audit `material_cost_version.propose`, `.approved`, `.rejected`,
  `.cancelled`. `Idempotency-Key` supported.

### POST /api/v1/materials/{id}/costs/{versionId}/withdraw

- **Permission**: `cost` set, and the proposer or `materials.create` (TENANT). **Body**: `{ reason }`. **Purpose**: PENDING_APPROVAL ->
  CANCELLED; the approval request is cancelled. `409` when not pending.

### GET /api/v1/materials/job-costs/{jobId}

- **Permission**: `jobs.view` over the job + `cost` set. **Purpose**: the direct material cost of a job: `{ jobId, lines [...], totals
  [{ currency, directMaterialCostMinor, costedLineCount }], lineCount, uncostedLineCount }`. Totals sum costed lines only; uncosted lines are
  counted, never estimated.

### POST /api/v1/materials/job-costs/{jobId}/cost

- **Permission**: `jobs.view` over the job + `cost` set. **Body**: `{}`. **Purpose**: costs every uncosted line that resolves to a catalog
  material (its link, or `materialRef` read as a code). **Answers** `{ results: [{ usageId, status: COSTED, line } | { usageId, status: SKIPPED,
  code }], cost }`. Safe to repeat. Audit `job_material.costed` per line.

### POST /api/v1/materials/usages/{usageId}/cost

- **Permission**: `jobs.view` over the usage's job + `cost` set. **Body** (strict): `{ materialId? }` links an unlinked line first (`404` for a
  material of another tenant, `409 material.usage_linked_elsewhere` when linked to another one). **Answers** the costed line; `409` with the
  skip code when it cannot be costed.
