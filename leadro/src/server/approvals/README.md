# approvals

The generic approval engine (§21.3, §11.5): policies by subject type + currency + amount band, requests that snapshot the policy, append-only
decisions, single / dual approval, separation of duties, expiry, cancellation, and callbacks into the module that owns the subject. Routes:
`/api/v1/approvals/**` (`docs/API_REFERENCE.md` "Approvals"). Pure rules: `src/lib/approval-rules.ts`. Decisions: `docs/DECISIONS.md` "Phase 4 Task 3".

Public API (`index.ts`):
- Subject modules: `registerApprovalSubject(subjectType, { resolveResource, onApproved, onRejected })` (at module load AND from
  `src/server/notification-targets.ts`), then inside their own transaction `createApprovalRequestInTx(tx, ctx, input)` -> `{ required: false }`
  (no policy: apply the change directly) or `{ required: true, request, replayed, notificationIds }` (store `request.id` on the subject; deliver
  `notificationIds` after commit). `cancelApprovalForSubjectInTx` withdraws a request without calling back; `findPendingApprovalForSubjectInTx`.
- People: `listApprovalQueue`, `listMyApprovalRequests`, `listApprovalRequests` (oversight), `getApprovalRequest`, `decideApprovalRequest`,
  `cancelApprovalRequest`; policies `listPolicies`, `createPolicy` (new code or version + 1), `deactivatePolicy`.
- Worker: `expireDueApprovalRequests(tenantId, now?)`, `expireDueApprovalRequestsForAllTenants()`, `expireApprovalRequest`.
- Wiring: `registerApprovalNotificationTarget()` (target `approval_request`, read-time permission `approvals.view`).

Invariants:
1. **Policy snapshot.** A request copies code, version, required approvals, approver permission and expiry from the policy resolved at creation;
   the database freezes them, so editing a policy (always version + 1) never changes a request already made.
2. **No silent skip.** No active policy (or an amount in a gap between bands) = no approval needed; but a subject type with policies and none in the
   amount's currency is refused (ValidationError), never waved through.
3. **Separation of duties.** The requester and `excludedApproverIds` (editors / submitters named by the subject module) never decide: service check
   (403, audited DENIED) and the `approval_decision_guard` trigger. One decision per person (unique index); decisions are append-only (trigger).
4. **One outcome, atomically.** Deciding locks the request row; the final decision, the status, the subject callback (`onApproved` / `onRejected`),
   the audit and the requester notification commit together. A callback that throws rolls the decision back. A subject type without a handler
   cannot be requested (500, programming error) or completed (409).
5. **Dual approval** = two different people; any REJECT ends the request. **Expiry**: past `expiresAt` the request is closed for deciding and
   cancelling (it is expired on the spot, 409) and the sweep marks the rest EXPIRED (`onRejected` with outcome EXPIRED, system actor).
6. **Scope.** Requests follow the org unit `resolveResource` reported at creation (null = tenant-level). Deciding needs the approver permission over
   it; seeing needs `approvals.view` and requester / approver / `approvals.manage`. Amount and details are hidden from manage-only viewers.
   Everything else is 404. Lists filter in SQL.
7. **Ids only.** `details` and notification params hold ids, codes and amounts (decimal strings), never free text; the requester's `reason` and
   decision comments are the only text, stored in their own columns.
