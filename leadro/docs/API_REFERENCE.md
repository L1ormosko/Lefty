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
`lead_related` (has a lead). Outside the scope a customer is `404`, never `403`.

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
