# employees

Employee records and their organizational placement over time (§3.4). Account creation goes through
invitations (`auth`).

Public API (`index.ts`):
- Records: `createEmployee`, `updateEmployee`, `terminateEmployee`, `getEmployee`, `listEmployees`.
- Placement: `assignEmployeeToUnit`, `endEmployeeAssignment`, `listEmployeeAssignments`.
- Org-wide placement history: `listPlacementHistory(actor, { cursor, limit, orgUnitId? })` (`employees.view` with the `base` field set, scoped in the query).
- History: `orgUnitAt(tenantId, employeeId, date)` / `orgUnitAtInTx` (reporting primitive),
  `getOrgUnitAtAsActor` (the permission-checked API variant).
- `inviteEmployee(actor, employeeId, { email?, roleId?, scope? }, client)`.

Routes: `/api/v1/employees[/{id}[/terminate|/assignments[/{assignmentId}/end]|/org-unit-at|/invitations]]`.

Invariants:
- Placement rows are NEVER overwritten. A PRIMARY transfer closes the open row (`effectiveTo = new start`) and
  inserts the next, so `orgUnitAt` answers any past date; the DB forbids overlapping PRIMARY rows. A new
  placement must start after the current one started (no rewriting history). SECONDARY/TEMPORARY rows are extra
  placements (TEMPORARY needs an end); only those can be ended early; a primary placement ends by transfer or termination.
- Legal employer (`Employee.legalEntityId`) and operational team (PRIMARY placement) are independent.
- Transfers need `employees.assign` over the employee AND the destination unit; the destination row is locked
  `FOR SHARE` so a concurrent archive cannot leave someone in an archived unit. Transfers are serialised per employee.
- Writes need the permission over the employee's scope AND the `base` field set (a field-limited grant may read,
  not change). Reads project fields per row with the grant that matched THAT row (`EMPLOYEE_FIELD_MAP`).
- A placement dated more than 5 minutes in the past is a correction: it needs a `reason` and is audited with `correction: true`.
- `legalEntityId` set or changed needs the write permission over that legal entity (it is part of the data scope).
- Terminate is soft: status TERMINATED + date (not in the future), open placements and manager rows ended, the
  login deactivated and its sessions revoked (only with `users.archive` over it; refused outright for holders of sensitive roles the actor cannot administer), all in one transaction. Terminated employees are read-only.
- Invitations: `users.create` over the employee; with a role, auth re-runs authz's anti-escalation check at
  creation and at acceptance. The token goes to the `AuthNotifier`, never into the API response.
