# auth

Authentication: who is calling (§22.1). Authorization (what they may do) lives in `authz`.
Local credential login behind this module's interface (no external IdP yet, see DECISIONS.md).

Public API (`index.ts`):
- `authenticateRequest(req)` — the `defineRoute` `authenticate` hook; session cookie -> `Actor`.
  `authenticateMfaRequest(req)` is the same but also accepts a session still waiting for MFA
  (MFA endpoints and logout ONLY). `requireSession()` is the server component/action equivalent.
- `login`, `logout`, `listOwnSessions`, `revokeOwnSession`, `deactivateUserAccountUnchecked`.
- `startMfaEnrollment`, `confirmMfaEnrollment`, `verifyMfaChallenge`, `userRequiresMfa` (delegates to authz
  `holdsMfaRequiringRole`: ONE definition of an active assignment).
- `changeOwnPassword(actor, { currentPassword, newPassword }, client)` — needs the current password, policy-checked,
  rate limited per account (5 / 15 min), revokes every OTHER session, audited (`auth.password_change`).
- `createInvitationUnchecked`, `acceptInvitation`, `requestPasswordReset`, `completePasswordReset`.
- `setAuthNotifier` — plug in email/SMS delivery for reset and invitation tokens (default only logs, no token).
- `withSessionCookie` / `queueSessionCookie` — lets thin routes set the cookie (core's `RouteResult` has no headers).

Routes (`src/app/api/v1/auth/`): `login`, `logout`, `mfa/enroll|confirm|verify`, `invitations/accept`,
`password-reset/request|confirm`, `sessions` (GET), `sessions/{id}` (DELETE).

Rules and invariants:
- Login = company code (tenant slug) + email + password. The tenant is resolved first (Tenant has no
  RLS); everything else runs in `withTenant`.
- Every login failure returns the same generic 401; the real reason is only in `AuthenticationEvent`
  and the audit log. A dummy bcrypt check equalises timing for unknown accounts.
- Passwords: bcryptjs cost 12, min 12 chars, max 72 bytes (bcrypt truncation).
- Lockout: 5 failed passwords/MFA codes in 15 min lock the account for 15 min. Failures are counted
  from `AuthenticationEvent`; the window never reaches back past the last login, last lock end or
  password change.
- Sessions: opaque token `<tenantId>.<256-bit random>`, only its SHA-256 is stored. Cookie
  `leadro_session` is HttpOnly, SameSite=Lax, Secure (except `next dev`). Idle timeout 60 min,
  absolute lifetime 12 h. Re-validated on every request, including user/tenant status.
  Unknown tokens are only logged; refused-but-real sessions write a DENIED audit event.
- Invitations (72 h) and password-reset tokens (1 h) are single-use (conditional UPDATE), stored
  hashed, and report a single generic error for unknown/expired/used tokens. Reset request answers
  identically whether or not the account exists. Completing a reset revokes all sessions.
- MFA: TOTP (RFC 6238, `src/lib/totp.ts`, node:crypto). Required when ANY active role assignment has
  `Role.requiresMfa` (`userRequiresMfa`, the one function to repoint at `authz` later) or the user
  already enrolled. A password-correct login then yields an `mfaPending` session that is refused
  everywhere except the MFA endpoints. Seeds are AES-256-GCM encrypted with `LEADRO_ENCRYPTION_KEY`
  (32 bytes base64); MFA fails closed without it. Used codes cannot be replayed within 2 minutes.
- Rate limiting: in-memory fixed windows per process (`rate-limiter.ts`): login 30/min per IP and
  10/min per account, reset request 10 per 15 min per IP (and 3 per 15 min per account, silently),
  MFA 10/min per session. With several instances the limit multiplies; the DB lockout is the real
  brute-force control.
- Client IP: `x-forwarded-for` is attacker-controlled on the left, so by default (`LEADRO_TRUSTED_PROXY_HOPS=0`)
  it is ignored and no IP is stored. With N trusted proxies the Nth entry from the right is used.
  Without an IP the per-IP limits are skipped (and logged) rather than shared by all clients.
- MFA promotion rotates the session token (the pre-MFA token stops working); the MFA routes set the new cookie.
  A TOTP code is accepted only for a step newer than `User.mfaLastUsedStep` (atomic conditional UPDATE).
- bcrypt never runs inside a transaction: login, invitation accept and reset do read -> hash/verify -> short write.
- Invitations with a role must carry a data scope (`InvitationScope`). With an inviter, authz's anti-escalation rules
  run twice: at CREATE time as a dry run (`assertMayGrantRole`, inviter -> invitee's employee, role, scope) and at
  ACCEPT time through `assignRole` AS the inviter (so a lost permission, a scope that moved out of reach or an
  archived scope target kills the invitation: generic "invalid invitation", token not consumed). An inviter-less
  (system) invitation uses `bootstrapRoleAssignment`. The token is handed to `AuthNotifier.sendInvitation` after
  commit and is never returned by the API.
- Not done here: user CRUD (users module), a real email/SMS notifier (no provider yet: §28.3),
  MFA disable/recovery codes, CSRF tokens (SameSite=Lax + JSON bodies is the defence).
