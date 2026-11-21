# LEADRO — Coding Standards

This codebase will be maintained by human engineers. Optimise for the next
person reading the code, not for brevity or cleverness.

## Structure
- Server modules live in `src/server/<module>/`. Each module has:
  - `index.ts` — the ONLY file other modules may import from. Re-exports the public API.
  - `README.md` — 10–40 lines: what the module owns, its public functions, its invariants,
    and which spec sections (§) it implements.
  - Small focused files (`service.ts`, `schemas.ts`, `errors.ts`, `*.test.ts`). Aim for
    files under ~300 lines; split by responsibility, not by line count.
- Pure, framework-free logic goes in `src/lib/`. Nothing in `src/lib/` imports Prisma or Next.
- Route handlers (`src/app/api/v1/**/route.ts`) and server actions are thin: parse input,
  call one service function, return. No business rules in routes or React components.

## Naming
- Descriptive names over abbreviations: `orgUnitId`, not `ouid`; `assertCanApprove`, not `chk`.
- Functions are verbs (`createOrgUnit`, `listEmployeesInScope`); booleans read as questions
  (`isActive`, `hasExpired`).
- Enum values are language-neutral UPPER_SNAKE identifiers (`PENDING_ASSIGNMENT`).
- One concept, one name across DB, code, API and docs.

## TypeScript
- `strict` on. No `any` (use `unknown` + narrowing). No non-null `!` unless justified in a comment.
- Public module functions have explicit parameter and return types and a short JSDoc
  explaining *what* and any non-obvious *why*.
- Validate every external input with Zod at the boundary; inside the boundary trust the types.

## Comments
- Explain *why*, constraints, and spec references (`// §11.8: never float for money`).
  Do not narrate what the next line obviously does.
- Every security or tenant-isolation decision gets a comment saying what it protects.

## Errors
- Throw `AppError` subclasses from `src/server/core`. Never return `null` to mean "forbidden".
- Never swallow errors. Never expose internal messages, stack traces or SQL to clients.

## Data access
- Tenant data is only touched inside `withTenant(tenantId, tx => …)`.
- Money is integer minor units. Timestamps are stored UTC.
- Mutations that matter write an audit event in the same transaction.

## Tests
- Every public service function has tests next to it (`*.test.ts`).
- Integration tests hit the real test database; do not mock Prisma.
- Test names describe behaviour: `it("rejects moving a unit under its own descendant")`.
- Include permission and tenant-isolation cases for anything touching tenant data.

## Dependencies
- Prefer the platform (node:crypto, Intl) over new packages. Any new dependency is pinned
  exactly and justified in `docs/DECISIONS.md`.

## Commits
- Conventional commits scoped to the module: `feat(leadro/auth): add account lockout`.
- One logical change per commit; the message body says why.
