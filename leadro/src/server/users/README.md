# users

User accounts: list, read, preferences, deactivate (§22). Accounts are created only by accepting an
invitation (`employees.inviteEmployee` -> `auth.acceptInvitation`); credentials stay in `auth`.

Public API (`index.ts`): `listInvitations` (read-only list of invitations with their state; scoped through the invited employee; the token is never selected), `listUsers`, `getUser`, `getOwnProfile`, `updateUser`, `deactivateUser`,
`userScopeColumns` (and its parts, reused by `roles`), `USER_FIELD_MAP`, the Zod schemas.

Routes: `/api/v1/users`, `/users/me`, `/users/me/password` (-> `auth.changeOwnPassword`), `/users/{id}`,
`/users/{id}/deactivate`.

Invariants:
- A user's data scope is that of their employee record (placement / legal employer / own); a user with no
  employee (e.g. the Owner) is tenant-level and only a TENANT grant reaches them. Outside the scope a user is a
  404 (`enforceOnUser`), never a 403.
- Responses are projected through `USER_FIELD_MAP`; password hash, MFA secret, failed-login count and lockout
  are never selected or returned.
- Deactivation needs `users.archive`, a reason, is refused for yourself and revokes every session
  (`auth.deactivateUserAccount`). `/users/me` and password change are self-service (no permission, own row only).
- Password change needs the current password, enforces the password policy, is rate limited per account and
  signs out every other session.
- `employeeStatus` / `loginPendingDeactivation` mark ACTIVE logins of TERMINATED employees (filter `?pendingDeactivation=true`); only tenant-wide user administrators see them.
