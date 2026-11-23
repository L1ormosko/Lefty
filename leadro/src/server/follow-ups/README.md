# follow-ups

Generic follow-up tasks about a lead, customer, job or recovery case: assignment, due dates, status, overdue queue,
due-soon / overdue notifications (§5.6, §5.9, §9.3). Routes: `/api/v1/follow-ups/**` (`docs/API_REFERENCE.md`
"Follow-up tasks"). Status machine and overdue rules: `src/lib/follow-up-lifecycle.ts`. Decisions: `docs/DECISIONS.md` "Phase 3 Task 7".

Public API (`index.ts`):
- Records: `createFollowUp`, `getFollowUp`, `listFollowUps`, `updateFollowUp`, `assignFollowUp`, `changeFollowUpStatus`,
  `completeFollowUp`, `cancelFollowUp` (+ Zod schemas for the routes).
- **`createFollowUpTaskInTx(tx, caller, { targetType, targetId, title, dueAt, priority?, assigneeId?, origin?, dedupeKey?, description? }, ctx?)`**:
  for other modules (the recovery engine, job outcomes) inside THEIR transaction. `caller` is an `Actor` (permissions checked) or
  `{ tenantId, system: true }` (no permission check, audited as the system). Returns `{ id, created, notificationIds }`; the caller hands the ids to
  `deliverAfterCommit`. `dedupeKey` makes it idempotent per tenant (`created: false` returns the first task); use e.g. `recovery:<caseId>:<ruleId>`.
- **Sweep**: `sweepFollowUps(tenantId, now?)` and `sweepAllFollowUps({ now?, tenantIds? })`. No scheduler exists: a worker calls them (any
  frequency, any concurrency). They raise `follow_up.due_soon` / `follow_up.overdue` once per task and due time.
- Wiring: `registerFollowUpNotificationTarget()` (also called at load and from `src/server/notification-targets.ts`),
  `registerFollowUpTargetAccess(type, access)` (the recovery module registers its own rules for `RECOVERY_CASE`), `followUpResourceRefById` (route resolver).

Invariants:
1. Two gates, both must pass for every read and write: `follow_ups.*` over the task (scope = the target's service-area unit copied at creation;
   ASSIGNED = assignee, OWN = creator) AND view access to the target through the target module's own rules (`targets.ts`). Denials are 404.
2. An assignee is an ACTIVE employee with a login who can open the task and its target; giving a task to someone else needs `follow_ups.assign` over
   that employee (outside the scope = "Employee not found").
3. Every status change goes through the machine, takes the row lock, re-reads after it, and audits (free text is never audited).
4. Field writes (create, status, complete, cancel) accept `clientEventId` + `occurredAt` and are idempotent through `FieldEvent` (`offline.ts`).
5. The sweep claims a task with an atomic stamp update before notifying; a task without assignee is never stamped.
6. No coordinates, no free text in notification params or `FieldEvent.payload`.
