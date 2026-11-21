# core

The request pipeline shared by every `/api/v1` route (§20.1, §20.3, §20.4).

Public API (`index.ts`):
- Types `Actor`, `RequestContext`, `SourceApp` — the caller identity used by auth/authz/audit.
- `AppError` + `UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `ValidationError`,
  `ConflictError`, `InvalidStateTransitionError`, `RateLimitedError`, `InternalError`.
- `toErrorResponse(error, correlationId, log)` — any thrown value -> client-safe JSON response.
- `resolveCorrelationId(headers)`, `CORRELATION_HEADER`.
- `defineRoute({ schemas, authenticate?, authorize?, idempotent?, handler })` — builds a Next.js
  route handler; `ok / created / noContent / respond` build results.
- `withIdempotency(tenantId, key, scope, fn)` — run-once-per-key with response replay.

Pipeline: correlation id -> `authenticate` -> Zod parse -> `authorize` -> handler -> error mapping.
Auth (Task 3) supplies `authenticate`; authz (Task 4) supplies `authorize`. Routes stay thin.

Invariants:
- Only `AppError` messages reach clients; everything else becomes generic `INTERNAL`, with the
  real error logged (with correlation id) and never returned.
- Every response carries `x-correlation-id`.
- Idempotency: one winner per (tenant, key); same key + different request -> `CONFLICT`; a thrown
  `fn` releases the key. Records live in `IdempotencyRecord` (RLS-protected, accessed via `withTenant`).
