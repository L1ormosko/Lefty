# API Conventions (Phase 0)

Authority: `SPEC.md` 20.1-20.4, 21, 16.

## Base and versioning

- All endpoints live under `/api/v1/...` (Next.js route handlers in `src/app/api/v1/`).
- Logical groups follow spec 20.2: `/auth`, `/tenants`, `/organization`, `/users`, `/employees`,
  `/roles`, `/permissions`, ... Breaking changes ship as `/api/v2`.
- JSON only (`application/json; charset=utf-8`). Field names camelCase. Enums are language-neutral
  upper-case English identifiers (`ACTIVE`, `ORG_UNIT`). Timestamps are ISO-8601 UTC
  (`2026-11-21T13:40:18.000Z`); dates without time are `YYYY-MM-DD`. Money (later) is integer
  minor units, never floats.
- Resource style: plural nouns, `GET /employees`, `POST /employees`, `GET /employees/{id}`,
  `PATCH /employees/{id}`, `POST /employees/{id}/archive` (state transitions are explicit
  action sub-resources; no hard deletes of business records).

## Pipeline (every operation)

correlation -> authenticate -> JSON content type / size -> Zod validation -> authorize (permission +
scope, audited on denial) -> handler; inside the handler's service: in-transaction permission re-check ->
business-state validation -> execute -> audit (same transaction) -> respond. See `ARCHITECTURE.md`
section 5. Tenant comes from the session, never from the request body or URL.

## Correlation

Every request may send `x-correlation-id`; if absent or malformed the server generates one (UUID).
Every response (success or error) carries `x-correlation-id`. The id is stored on audit events and
included in error bodies.

## Success shape

- Single: `200/201` with `{ "data": { ... } }`.
- Collection: `{ "data": [ ... ], "page": { "nextCursor": "opaque|null", "limit": 50 } }`.
  Cursor pagination (`?cursor=&limit=`), default limit 50, max 200; the cursor is opaque to clients
  (`src/server/core/pagination.ts`). Every list is filtered to the caller's data scope IN THE QUERY and each row
  is field-projected to what the caller's grant reveals, so a page can hold fewer fields than the
  model has. Order is fixed per endpoint (documented on the route). Filters are explicit query params
  validated by Zod.
- `204` for actions with no body. Locale-dependent display strings are not returned by the API;
  clients render by translation key.

## Error shape (spec 20.4)

```json
{ "error": { "code": "FORBIDDEN", "message": "You do not have access to this action.",
             "field": "email", "retryable": false, "correlationId": "5b0c..." } }
```

`field` is present only for field-level validation errors (multiple field errors are returned as
`details: [{ field, code, message }]` in addition to the first one's `field`). `message` is
human-readable, contains no internal detail, and is a stable English default (clients localise by
`code`). Stack traces, SQL, Prisma errors, and file paths are never returned; they are logged with
the correlation id.

The codes below are exactly `ERROR_CODES` in `src/server/core/errors.ts`; a test pins the table to
the code, so a new code must be added in both places.

| HTTP | code | retryable | Meaning |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | false | Zod input validation failed, or a business-state rule on the input (bad parent type, cycle, ...) |
| 401 | `UNAUTHENTICATED` | false | missing/expired/revoked session, and every failed login (never says which part was wrong) |
| 403 | `FORBIDDEN` | false | authenticated, lacks the permission or the data scope for a capability or tenant-level record |
| 404 | `NOT_FOUND` | false | missing **or out of scope** (existence not leaked) |
| 409 | `CONFLICT` | false | uniqueness conflict, concurrent change, same `Idempotency-Key` with a different request, or an in-flight duplicate (retryable) |
| 409 | `INVALID_STATE_TRANSITION` | false | the resource's current status does not allow this change (archived unit, terminated employee, ...) |
| 413 | `PAYLOAD_TOO_LARGE` | false | request body over 1 MB (`MAX_JSON_BODY_BYTES`) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | false | a mutating request with a body that is not `application/json` |
| 429 | `RATE_LIMITED` | true | honour `Retry-After` |
| 500 | `INTERNAL` | true | generic; details only in logs |

Not used (earlier drafts listed them): `PERMISSION_DENIED` (it is `FORBIDDEN`), `INTERNAL_ERROR` (it
is `INTERNAL`), `INVALID_CREDENTIALS` (failed logins are `UNAUTHENTICATED`), `IDEMPOTENCY_KEY_REUSED`
(it is `CONFLICT`), `BUSINESS_RULE_VIOLATION`, `ACCOUNT_LOCKED`, `MFA_REQUIRED`, `SERVICE_UNAVAILABLE`.
When a client needs to tell such cases apart, add a code to `ERROR_CODES` first, then to this table.

Login failures return the same `UNAUTHENTICATED` (401) for unknown company code, unknown email,
wrong password and a locked account, to avoid account enumeration.

## Idempotency (spec 20.3)

Mutations that may be retried (job creation, financial transactions, invitations, imports) accept
`Idempotency-Key: <opaque, <=128 chars>`. Stored per tenant and user (another user's identical key never sees your response) in
`IdempotencyRecord` with a hash of user + method + path + body. Same key + same hash replays the stored response (status and body, header
`Idempotent-Replayed: true`); same key + different hash -> `409 CONFLICT`; an
in-flight duplicate -> `409 CONFLICT` retryable. Records expire after 24 h.

## Audit (spec 21)

Every mutating operation, plus exports, logins, failed access, and permission/org changes, appends
an `AuditEvent` in the same transaction: tenant, actor, action (`resource.verb`, e.g.
`employee.update`), target type/id, previous/new value (changed fields only), reason (required for
sensitive actions), source app, correlation id, outcome. Denied and failed attempts are recorded
with outcome `DENIED` / `FAILED`. Secrets (password hash, MFA secret, tokens) are redacted before
serialisation.

## Authentication transport

Opaque session token in the `leadro_session` `HttpOnly; Secure; SameSite=Lax` cookie (the only
transport implemented; a bearer header for non-browser clients is not built yet). Tokens are
`<tenantId>.<random>`; only the SHA-256 is stored. CSRF defence: SameSite=Lax plus JSON-only bodies: a mutating request with a body must be
`application/json` (else `415`), and bodies are capped at 1 MB (else `413`).
Login body: `{ tenantSlug, email, password }` (`tenantSlug` is the company code).

## Localization

Request locale resolution: explicit `Accept-Language` is ignored for stored data; UI locale comes
from user -> org unit -> tenant. API payloads carry identifiers and values, not translated text.

## Rate limiting

Per-IP and per-account limits on `/auth/*`; `429` with `Retry-After`. The counters are in memory per
process (with several instances the limits multiply; the database lockout is the real brute-force
control). Numbers: `docs/AUTH.md`.
