# auth

Authentication: who is calling (§22.1). Authorization (what they may do) lives in `authz`. Local
credential login behind this module's interface (no external IdP yet, see DECISIONS.md).
Full reference with every rule and number: `docs/AUTH.md`.

Public API (`index.ts`):
- `authenticateRequest(req)` — the `defineRoute` `authenticate` hook; session cookie -> `Actor`.
  `authenticateMfaRequest(req)` also accepts a session still waiting for MFA (MFA endpoints and logout ONLY).
  `requireSession()` is the server component/action equivalent; `readSession()` is the page-layer reader that
  tolerates MFA-pending without writing a DENIED audit row.
- `login`, `logout`, `listOwnSessions`, `revokeOwnSession`, `changeOwnPassword`.
- `startMfaEnrollment`, `confirmMfaEnrollment`, `verifyMfaChallenge`, `userRequiresMfa`.
- `acceptInvitation`, `requestPasswordReset`, `completePasswordReset`.
- `createInvitationUnchecked`, `deactivateUserAccountUnchecked`: no permission check; for the
  employees/users services and seeds only.
- `setAuthNotifier` — plug in email/SMS delivery. None exists yet, so invitations and password
  resets cannot reach a real person (§28.3, no fake integrations); the default only logs.

Routes (`src/app/api/v1/auth/`): `login`, `logout`, `mfa/enroll|confirm|verify`, `invitations/accept`,
`password-reset/request|confirm`, `sessions` (GET), `sessions/{id}` (DELETE).

Invariants:
- Login = company code + email + password; every failure is the same generic 401 (no enumeration).
- Sessions are opaque tokens (only the SHA-256 is stored), re-validated on every request, including
  user/tenant status. Idle 60 min, absolute 12 h.
- MFA (TOTP) is re-checked on EVERY request: a full session with no `Session.mfaVerifiedAt` whose user
  now holds an MFA-requiring role goes back to `mfaPending` (enroll or verify). Promotion rotates the token.
- Lockout after 5 failures in 15 min; rate limits are in memory per instance (the DB lockout is the real control).
- Invitations and reset tokens are single-use, stored hashed; invitation roles go through authz anti-escalation.
- Not done here: user CRUD (users module), a real notifier, MFA disable/recovery codes, CSRF tokens
  (SameSite=Lax + JSON-only bodies is the defence).
