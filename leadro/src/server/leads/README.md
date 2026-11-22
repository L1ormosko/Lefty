# leads

Lead intake, lifecycle, ownership, contact history, duplicate flagging and conversion to a job (§6.2-6.4, §25.1, §5.6).
Routes: `/api/v1/leads/**` (`docs/API_REFERENCE.md` "Leads"). Decisions: `docs/DECISIONS.md` "Phase 2 Task 5".
Status machine (pure): `src/lib/lead-lifecycle.ts`.

Public API (`index.ts`):
- Records: `createLead` (intake; idempotent per `(source, externalId)`), `getLead`, `listLeads`, `updateLead`, `archiveLead`, `restoreLead`.
- Lifecycle: `changeLeadStatus`, `listLeadStatusHistory`. Every status change goes through `status-change.ts` `applyLeadStatus`
  (validates, writes `LeadStatusHistory`, audits, ends the owner's assignment when the lead closes or is released).
- Ownership: `assignLead`, `unassignLead` (spec 25.1 conflict rules, below).
- Contact history: `createInteraction`, `closeInteraction`, `listInteractions`, `findOpenContactAttempts`.
- Customer and job: `linkLeadCustomer`, `convertLead` (job created through `job-conversion-port.ts`).
- Duplicates and sources: `flagLeadDuplicates`, `revealableLeadDuplicates`, `listLeadDuplicateFlags`, `resolveLeadDuplicateFlag`,
  `listLeadSources`, `createLeadSource`, `updateLeadSource`.
- Scope helpers: `leadResourceRef` (route resolver and notifications), `leadRowAttributes`, `resolveLeadListAccess`, `visibleLeadIds`.
- `registerLeadNotifications()`: registers the "lead" notification target resolver (`leads.view`). Importing the module registers it; `src/instrumentation.ts` calls it at server start because the notifications routes never import this module.

Invariants:
1. The owner of a lead is its ACTIVE `LeadAssignment` (at most one). ASSIGNED scope uses the shared fragment `leadAssignedToWhere` from `@/server/customers`
   (also the source of customers' `assignedEmployeeIds`); closing, releasing or archiving a lead ENDS the assignment so access stops with the work.
2. Statuses ASSIGNED..DISPATCHED mean "somebody owns it". ASSIGNED is reachable only by `assignLead`, CONVERTED only by `convertLead`, and an owner is released only by `unassignLead`: the status endpoint cannot bypass them.
3. Spec 25.1: reassigning (or releasing) while ANOTHER employee has an open contact attempt (no `closedAt`, younger than `OperationsSettings.contactAttemptOpenMinutes`)
   is refused with 409 until confirmed with a reason; the confirmation is stored (`LeadAssignment.conflictConfirmed`), the open attempts are closed (never deleted) and the audit event names them.
   Replacing an owner always needs a reason. Unavailable employees (leave, terminated, no placement, no login) are refused; an employee outside the lead's service area needs an explicit confirmation.
4. Lead and job writes call `assertWritableFields(decision, changedFields, LEAD_FIELD_MAP, LEAD_WRITE_ALLOWLISTS)`: a Technician's `{fields:"status"}` grant allows `status` and `closedReason` only. Interactions need the base set (`notes`).
5. Duplicate detection flags only (customers via the shared matcher, recent leads within `RECENT_LEAD_WINDOW_DAYS`); never merges, never blocks, never reopens a decided pair; responses reveal only duplicates the caller may view.
6. New leads and conversions refuse archived customers (`assertCustomerActive`). Human numbers come from `nextNumber(..., "lead")`.

Conversion wiring: `job-conversion-port.ts` defines `createJobFromLead(tx, actor, { leadId, customerId, serviceAddressId, jobTypeId, description?, priority?, appointmentWindow? })`.
Until `@/server/jobs` is merged it is a stub that throws (conversion then rolls back and answers 500). To wire: replace the stub with `export { createJobFromLead } from "@/server/jobs";`
and adapt the return type if the jobs function returns more than `{ id, number }`; delete `tests/leads/conversion-port.test.ts` (it asserts the stub). `tests/leads/conversion.test.ts` mocks the port with a double that inserts a real Job in the same transaction.
