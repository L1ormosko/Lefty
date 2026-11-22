# customers

Customer records, service addresses, notes, communication preferences, preferred employees, service history and
duplicate detection (§6.1, §6.4, §5.9). Routes: `/api/v1/customers/**` (`docs/API_REFERENCE.md` "Customers").

Public API (`index.ts`):
- Records: `createCustomer`, `updateCustomer`, `archiveCustomer`, `restoreCustomer`, `getCustomer`, `listCustomers`.
- Around a customer: `listAddresses/addAddress/updateAddress/archiveAddress`, `listNotes/addNote`,
  `listEmployeePreferences/setEmployeePreferences`, `getCustomerHistory` (leads + jobs ids, scoped per caller).
- Duplicates: `findDuplicateCustomerCandidates` (reused by leads), `loadDuplicateMatchers`, `flagCustomerDuplicates`,
  `customerPairKey`, `listDuplicateFlags`, `resolveDuplicateFlag`, `getDuplicateMatchers/setDuplicateMatchers`.
- Pure helpers in `src/lib`: `normalizePhoneE164`, `phoneSearchDigits` (phone.ts), `normalizeAddressKey` (address-key.ts).
- `nextNumber(tx, tenantId, "customer"|"lead"|"job")` lives in `core` (human numbers; leads/jobs use the same).

## Shared ASSIGNED-scope helper (leads and jobs: reuse it, do not re-implement)
`assignment-access.ts` is the ONE definition of "assigned to employee E" (exported from `index.ts`):
- `leadAssignedToWhere(employeeId)` -> `Prisma.LeadWhereInput`: ACTIVE `LeadAssignment` of E, lead not archived.
- `jobAssignedToWhere(employeeId, now)` -> `Prisma.JobWhereInput`: ACTIVE `JobAssignment` naming E, OR naming a team
  org unit (`teamOrgUnitId`) where E has an ACTIVE placement now (team expansion), job not archived.
- `customerAssignedToWhere(employeeId, now)`: customers with a lead or job assigned to E.
- `assignedEmployeeIdsByCustomer(tx, tenantId, customerIds, now)` -> `Map<customerId, employeeId[]>`: the same rule as ids,
  for `ResourceRef.assignedEmployeeIds` (single-record checks). A test pins both forms to agree.
The complete `leadScopeColumns` / `jobScopeColumns` (ORG_UNIT, LEGAL_ENTITY, ASSIGNED) are exported too: leads and jobs MUST import them for `buildScopeWhere` instead of declaring their own. Use the where-fragments as `ScopeColumns.assigned`, and build each job/lead `ResourceRef` with
`assignedEmployeeIds` = the active assignment employees (jobs: expand team rows to the team's current members, as
`assignedEmployeeIdsByCustomer` does). Assignments count until they are ENDED, so leads/jobs services must end the
assignment when work reaches a state that should stop granting access. Team members are the employees placed in exactly
that org unit (teams are leaf units); an archived team unit expands to nobody.

`revealableDuplicates` (every response carrying `possibleDuplicates` must pass through it) and `assertCustomerActive` (guard for any write under a customer) are exported for leads/jobs too.

## How scopes apply to customers (`customer-access.ts`)
- ORG_UNIT / LEGAL_ENTITY follow `Customer.orgUnitId` (service-area branch/city). No unit = tenant-level (TENANT scope only).
- ASSIGNED = a lead/job of the customer is assigned to the caller. OWN matches nothing.
- Grants qualified by a record set: `job_related` (customer has a job; Dispatcher), `lead_related` (has a lead; Lead Ops).
  Lists express this as a union of per-set query fragments; any other set matches nothing (fail closed).
- `customerResourceRef(tx, tenantId, id)` builds the `ResourceRef` (use it as the `requirePermission` resolver); it always
  carries `assignedEmployeeIds` and `sets`, so a denial is a 404 and never leaks existence as a 403.

Invariants:
- Customers are archived, never deleted; archived customers are read-only until restored. Consumers (leads, jobs) must
  refuse to attach NEW work to an archived customer.
- Billing columns (`billingName`, `billingEmail`, `billingAddress`, `taxId`, `paymentTerms`) are the opt-in `billing` set:
  written only by grants naming it, never copied into the audit log (names only), never in a response to a plain grant.
- Duplicate detection FLAGS only: never merges, never blocks a write, never reopens a pair a person decided on. It looks at
  the whole tenant; what is revealed to the caller is limited to customers they may view (flags need BOTH sides in scope).
- Exactly one active address is primary when a customer has addresses. Coordinates exist only when entered (no geocoding, §28.3).
- Phone: `phone` as typed, `phoneE164` normalized (US/Canada default, else international `+`), the match and search key.
