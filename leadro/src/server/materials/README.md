# materials

The material catalog, its versioned costs and the costing of the materials used on jobs (§11.4, §25.4). Routes:
`/api/v1/materials/**` (`docs/API_REFERENCE.md` "Materials"). Pure rules (half-even extended cost, effective periods, placement of a new
version): `src/lib/material-cost-rules.ts`. Decisions: `docs/DECISIONS.md` "Phase 4 Task 2".

Public API (`index.ts`):
- Catalog: `listMaterials`, `getMaterial`, `createMaterial`, `updateMaterial`, `archiveMaterial`.
- Costs: `proposeCostVersion` (opens a `MATERIAL_COST_CHANGE` approval request when a policy applies, else approves at once),
  `withdrawCostVersion`, `listCostVersions`.
- Job costing: `costMaterialUsage` (one line, optional link to a material), `costJobMaterials` (every uncosted line, per-line results),
  `getJobMaterialCost` (direct material cost per job and currency), `materialUsageJobResourceRef` (route resolver).
- Wiring: `registerMaterialCostApprovalSubject()` (called at module load and from `src/server/notification-targets.ts`).

Invariants:
1. **A cost is never edited.** It lives only in `MaterialCostVersion`; a change is version + 1, PENDING_APPROVAL -> APPROVED | REJECTED | CANCELLED.
   Approving a version effective at D closes the current approved version at D first; approved versions never overlap (GiST), and the
   database freezes an approved version's facts. One pending version per material. It takes effect on `effectiveFrom`, not on the approval date.
2. **History is never rewritten.** A usage line is costed once with the approved version in effect at its `occurredAt`; the snapshot and the
   quantity are frozen by trigger. A new version may not start at or before a usage already costed with the current version (checked at
   proposal and again inside the approval transaction, under the material row lock that costing also takes).
3. **Extended cost** = quantity (`Decimal(12,3)`) x unit cost, computed exactly in `bigint` thousandths, rounded once half-even to whole minor
   units. No unit conversion: a unit mismatch is not costed.
4. **Separation of duties** comes from the engine: the proposer is the requester and cannot decide. Requests are tenant-level (materials have no
   org unit), so approvers need the policy's permission (default `materials.approve`) at TENANT scope.
5. **Access.** Catalog read = `materials.view` capability; catalog writes = TENANT-scoped `materials.create/edit/archive`. Every cost (fields,
   history, proposing, job costing) needs the `cost` field set; job costing also `jobs.view` over the job (404 outside scope).
6. **Ledger** (Task 5): costing a line posts its MATERIAL_COST entry (minus the extended cost, key `MATERIAL_COST:<usageId>`,
   `materialUsageId`, at the usage's `occurredAt`) in the costing transaction; a zero cost posts nothing; a cost in another currency than the
   job's is not posted and raises a `material_cost.currency_mismatch` finance review flag.
7. **Audit**: `material.create/update/archive`, `material_cost_version.propose/approved/rejected/cancelled`, `job_material.costed`, all in
   the writing transaction.
