# qualifications

The qualification engine (§10.1, §7.3 hard requirements): skills, certifications / licenses / equipment
qualifications / training, job-category permissions, service territories, availability, and the
eligibility check that dispatch builds on. The pure rules live in `src/lib/eligibility` (no Prisma) and
`src/lib/zoned-time.ts`; the status machine in `src/lib/qualification-lifecycle.ts`.

Public API (`index.ts`):
- Eligibility: `isEligible(tx, tenantId, employeeId, requirements, { at, window, timeZone })` returns
  `{ eligible, failures: [{ code, params }], checked }`; `evaluateCandidates` does many employees in one load.
  Build `requirements` with `requirementsForJobType` (type + extras, for "what if") or `requirementsForJob`
  (the job's own `JobRequirement` rows). `resolveWorkTimeZone` gives the zone for the query. These take a
  tenant transaction and do NOT check permissions: the caller (dispatch) has already authorized itself.
- API-facing: `checkEligibilityAsActor` (needs `qualifications.view` over the employee),
  `renderEligibilityFailure(translate, failure)` for server-rendered text.
- Expiry: `findExpiringQualifications(tx, tenantId, { withinDays?, includeExpired? })` (system query for the
  notification engine, no actor) and `listExpiringQualifications(actor, query)` (scoped API).
- Records: catalogs (`listSkills`, `createSkill`, ..., `*Certification`), employee records
  (`createQualification`, `updateQualification`, `getQualification`, `listQualifications`), HR decisions
  (`verifyQualification`, `rejectQualification`, `revokeQualification`), `createTerritory` / `endTerritory`,
  `grantJobPermission` / `endJobPermission`, `createAvailability` / `deleteAvailability`, and the `list*`.

Routes: `/api/v1/qualifications[/{id}[/verify|/reject|/revoke]|/skills|/certifications|/territories|/job-permissions|/availability|/expiring|/eligibility]`.

Invariants:
- Eligibility is hard requirements only: employment, required skills (verified, unexpired through the end
  of the work, minimum level), required credentials, a job-category permission, a service territory, and
  availability for the WHOLE window. No performance, rating or workload input exists (§10.3); a test greps for it.
- Failures are `{ code, params }`, never prose; clients translate `QUALIFICATION.FAILURE.<code>`.
- A credential is valid through the END of its `expiresAt` day in the job's time zone. Weekly windows are read
  per local date in their own IANA zone (DST-safe, cannot cross midnight: a night shift is two windows);
  time-off exceptions beat weekly windows; no availability rows means never available.
- Records are scoped by the EMPLOYEE's data scope. Recording needs `create`/`edit`; verifying, rejecting,
  revoking and granting job permissions need `approve` (HR, Owner), and nobody verifies their own record.
- A material edit of a verified record, or any edit of a rejected/revoked one, returns it to
  PENDING_VERIFICATION. Territories, job permissions and credentials are ended or revoked, never deleted
  (availability rows are the exception: plain schedule data, audited on delete).
