# field-execution

What a technician records during a visit (§8.5, §8.6) plus the versioned completion forms. Routes:
`/api/v1/jobs/{id}/(notes|materials|attachments|completion)`, `/api/v1/jobs/{id}/completion/form`,
`/api/v1/jobs/{id}/attachments/{attachmentId}/upload`, `/api/v1/completion-forms/**` (`docs/API_REFERENCE.md` "Field execution").
Design: `DECISIONS.md` "Phase 3 Task 4". Pure form rules: `src/lib/completion-form-rules.ts`.

Public API (`index.ts`): `recordFieldNote` / `listFieldNotes`, `recordMaterialUsed` / `listMaterialsUsed`,
`recordAttachmentMetadata` / `listAttachments` / `requestAttachmentUpload`, `submitCompletion` / `listJobCompletions` /
`getCompletionFormForJob`, the definition services (`createCompletionFormDraft`, `updateCompletionFormDraft`,
`publishCompletionForm`, list/get), the `StorageProvider` seam (`getStorageProvider`, `setStorageProvider`) and every Zod schema.
The sync module calls the same `record*` / `submit*` functions, so an online and a replayed offline write are one code path.

Invariants
- Writes need `jobs.edit` over the job (Technician: ASSIGNED, execution grant), reads `jobs.view`; the job must be EN_ROUTE or later
  and not CLOSED / CANCELLED (`job_field.not_in_field_state`). Amounts in notes need the `financial` set of `job_outcomes.view`.
- Every write accepts `clientEventId` + `occurredAt` and goes through the shared gate (`src/server/field-events`): replay = 200 with the
  first result, same id with other content = 409, a refusal is remembered, a replay re-checks access.
- Free text lives only in the domain rows; events, audit and `FieldEvent.payload` hold ids and kinds. No coordinates anywhere.
- Attachments are METADATA. No storage provider is configured, so uploads are refused (`409 storage.not_configured`); a row is never
  marked STORED without a key (DB CHECK).
- A completion is validated against the ACTIVE definition and stores the exact `(definition, version)`; published versions are immutable.
  Submitting does not change the job status (the outcome did, §9.1); it links the visit's loose material rows to the completion.
- Spec: §8.5 notes / materials / photos / approval, §8.6 completion form, §8.7 offline, §28.3 no fake storage.
