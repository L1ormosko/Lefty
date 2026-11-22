# notifications

Notification engine: events become inbox rows inside the business transaction and are delivered after commit (§14).
Decisions: `docs/DECISIONS.md` "Phase 2 Task 4".

Public API (`index.ts`):
- Raise: `notifyInTx(tx, { tenantId, eventType, eventId, recipientUserIds, params?, targetId? })` -> `{ createdNotificationIds, duplicateCount, skippedRecipientCount }`.
  Event types live in `NOTIFICATION_EVENTS` (template key, critical flag, link target). Call it INSIDE the `withTenant` transaction of the business write.
- Deliver: `deliverAfterCommit(tenantId, ids)` right after commit (never throws), `deliverPending(tenantId, opts)` and `deliverPendingForAllTenants()` for a worker sweep (also runs due retries).
- Channels: `NotificationChannel` interface; defaults are in-app (DELIVERED) and `notConfiguredChannel` for PUSH/EMAIL/SMS (NOT_CONFIGURED, nothing is sent). `setNotificationChannel` installs a provider.
- Recipients: `resolveLeadOperationsRecipients(tx, tenantId, orgUnitId, { excludeUserIds })`, `resolveRecipientsByPermission`.
- Own inbox (what the UI bell needs): `listOwnNotifications`, `countOwnUnread`, `markOwnNotificationRead`, `markAllOwnRead`, `listOwnPreferences`, `setOwnPreference`.
- Text: `renderNotification(t, row)` and `renderNotificationForRecipient(tenantId, userId, row)` give `{ title, body }` from `<templateKey>.TITLE/.BODY`.

Routes: `/api/v1/notifications[/unread-count|/read-all|/preferences|/{id}/read]`. Pure rules (params contract, opt-out, retry delays): `src/lib/notification-rules.ts`.

Invariants:
1. A notification exists iff the business transaction committed; a delivery failure never rolls it back (and `deliverAfterCommit` never throws).
2. Params hold ids, numbers and codes only (enforced); text is rendered at read time in the RECIPIENT's locale.
3. Idempotent per `(recipient, <eventType>:<eventId>)`; repeats create nothing.
4. Truthful delivery: PUSH/EMAIL/SMS without a provider are NOT_CONFIGURED, never SENT (§28.3). Opted-out non-critical channels are SKIPPED; critical events ignore opt-outs.
5. One delivery row per attempt; retries are SCHEDULED with backoff (3 attempts) then EXHAUSTED. Concurrent workers never send the same row twice.
6. Own-notification endpoints are always pinned to the caller; another user's id is a 404.

Adding an event: one row in `events.ts`, `NOTIFICATION.<NAME>.TITLE` and `.BODY` in en-US/es-US/he-IL, then call `notifyInTx`.
