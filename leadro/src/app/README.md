# app (Next.js routes)

Thin UI layer over the server modules (spec §5, §16, §22, §24). No business rules live here.

- `layout.tsx` — root: `<html lang dir>` from the resolved locale (he-IL = rtl).
- `(auth)/` — signed-out screens: `login`, `login/mfa`, `accept-invitation`, `forgot-password`, `reset-password`.
  Each has a `page.tsx` (server, translates), a small client form, and `actions.ts` (server action -> one auth service call).
- `(app)/` — signed-in workspace. `layout.tsx` gates on the session (no session -> `/login`, MFA pending -> `/login/mfa`),
  builds the sidebar from `navigation.ts` (permission-filtered on the server), top bar (language, notifications, user menu).
  `account/sessions`, `account/security` are the self-service pages.
- `_lib/page-context.ts` — `getPageContext()`: actor, MFA-pending flag, locale, direction, time zone and translator (cached per request).
- `_actions/` — actions shared by several screens: `locale`, `mfa`, `session` (logout, revoke).
- `api/v1/` — JSON API (see docs/API_CONVENTIONS.md).

Rules: all text through `t()` keys (`SHELL.*`, `AUTH_UI.*`, `ACCOUNT.*`, `NAV.*`); client components receive translated strings as
props; actions return translated messages built from the error CODE only (never the service's English text), so login failures stay
generic. To show a new sidebar item add it to `navigation.ts` with its permission and set `isAvailable` once the page exists.
