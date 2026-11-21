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

authenticate -> tenant -> permission -> Zod validation -> scope -> business-state validation ->
execute -> audit -> respond. See `ARCHITECTURE.md` section 5. Tenant comes from the session, never
from the request body or URL.

## Correlation

Every request may send `x-correlation-id`; if absent or malformed the server generates one (UUID).
Every response (success or error) carries `x-correlation-id`. The id is stored on audit events and
included in error bodies.

## Success shape

- Single: `200/201` with `{ "data": { ... } }`.
- Collection: `{ "data": [ ... ], "page": { "nextCursor": "opaque|null", "limit": 50 } }`.
  Cursor pagination, default limit 50, max 200. Sorting via `sort=field` / `sort=-field` on
  allow-listed fields. Filters are explicit query params validated by Zod.
- `204` for actions with no body. Locale-dependent display strings are not returned by the API;
  clients render by translation key.

## Error shape (spec 20.4)

```json
{ "error": { "code": "PERMISSION_DENIED", "message": "You do not have access to this action.",
             "field": "email", "retryable": false, "correlationId": "5b0c..." } }
```

`field` is present only for field-level validation errors (multiple field errors are returned as
`details: [{ field, code, message }]` in addition to the first one's `field`). `message` is
human-readable, contains no internal detail, and is a stable English default (clients localise by
`code`). Stack traces, SQL, Prisma errors, and file paths are never returned; they are logged with
the correlation id.

| HTTP | code | retryable | Meaning |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | false | Zod input validation failed |
| 401 | `UNAUTHENTICATED` | false | missing/expired/revoked session |
| 403 | `PERMISSION_DENIED` | false | authenticated, lacks permission or scope (also `MFA_REQUIRED`) |
| 404 | `NOT_FOUND` | false | missing **or out of scope** (existence not leaked) |
| 409 | `CONFLICT` | false | uniqueness/state conflict (`INVALID_STATE_TRANSITION`, `DUPLICATE`) |
| 409 | `IDEMPOTENCY_KEY_REUSED` | false | same key, different request body |
| 422 | `BUSINESS_RULE_VIOLATION` | false | valid shape, violates a domain rule |
| 423 | `ACCOUNT_LOCKED` | false | lockout protection |
| 429 | `RATE_LIMITED` | true | honour `Retry-After` |
| 500 | `INTERNAL_ERROR` | true | generic; details only in logs |
| 503 | `SERVICE_UNAVAILABLE` | true | dependency down / transaction timeout |

Login failures return the same `INVALID_CREDENTIALS` (401) for unknown company code, unknown email
and wrong password, to avoid account enumeration.

## Idempotency (spec 20.3)

Mutations that may be retried (job creation, financial transactions, invitations, imports) accept
`Idempotency-Key: <opaque, <=128 chars>`. Stored per tenant in `IdempotencyRecord` with a hash of
method + path + body. Same key + same hash replays the stored response (status and body, header
`Idempotent-Replayed: true`); same key + different hash -> `409 IDEMPOTENCY_KEY_REUSED`; an
in-flight duplicate -> `409 CONFLICT` retryable. Records expire after 24 h.

## Audit (spec 21)

Every mutating operation, plus exports, logins, failed access, and permission/org changes, appends
an `AuditEvent` in the same transaction: tenant, actor, action (`resource.verb`, e.g.
`employee.update`), target type/id, previous/new value (changed fields only), reason (required for
sensitive actions), source app, correlation id, outcome. Denied and failed attempts are recorded
with outcome `DENIED` / `FAILED`. Secrets (password hash, MFA secret, tokens) are redacted before
serialisation.

## Authentication transport

Opaque session token in an `HttpOnly; Secure; SameSite=Lax` cookie (web) or `Authorization:
Bearer` (non-browser clients). Tokens are `<tenantId>.<random>`; only the SHA-256 is stored. CSRF:
mutations from browsers require a same-origin check / custom header. Login body:
`{ companyCode, email, password }`.

## Localization

Request locale resolution: explicit `Accept-Language` is ignored for stored data; UI locale comes
from user -> org unit -> tenant. API payloads carry identifiers and values, not translated text.

## Rate limiting

Per-IP and per-account limits on `/auth/*`; `429` with `Retry-After`. Limits are configuration, set
when the auth module is built.
