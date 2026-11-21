# server/i18n

Database-backed localization: locale/time-zone resolution for a request and tenant translation
overrides. Implements spec §16.2, §16.5, §16.6. Pure logic is in `src/lib/i18n`.

## Public API (`index.ts`)
- `resolveLocaleContext(tenantId, { userId?, orgUnitId? })` → `{ locale, localeChain, direction, timeZone }`.
  Order: user → branch (nearest org unit at/above the user's current PRIMARY assignment, or the given
  `orgUnitId`) → tenant default → en-US. Time zone follows the same order, ending at the tenant zone.
- `getTranslatorForRequest(tenantId, request)` → `{ t, context }` with reviewed overrides applied.
- `loadReviewedOverrides(tenantId)`, `saveOverride`, `markOverrideReviewed`, `deleteOverride`.

## Invariants
- Only overrides with `reviewed = true` are ever served (`loadReviewedOverrides` is the single filter).
- `markOverrideReviewed` requires `reviewedValue` and only approves if the stored value still equals it (else CONFLICT),
  so a reviewer can never approve text they did not read.
- Saving/editing an override always resets it to unreviewed (value change = new review).
- Overrides must target an existing built-in key and keep the same `{placeholders}`.
- All access goes through `withTenant` (RLS); overrides never cross tenants.
- DB CHECK `translation_review_consistent`: reviewed rows carry `reviewedAt`; unreviewed rows carry none.

## Permission-checked administration (Task 5)
`saveOverrideAsActor`, `reviewOverrideAsActor`, `deleteOverrideAsActor` (actor + request context) are the entry points
for API routes/server actions:
- `localization.edit` saves an override (it lands unreviewed); `localization.configure` reviews or deletes one. Two
  permissions keep the §16.6 review meaningful (translators edit, a reviewer approves). Translations are tenant-level,
  so a TENANT scope is required. No new catalog permission was needed.
- Each write is audited in the same transaction (`translation.save|review|delete`, previous/new text).
- `TranslationOverrideError` is mapped to core errors: unsupported locale / unknown key / placeholder mismatch ->
  `ValidationError` (field `locale` / `key` / `value`), missing -> `NotFoundError`, changed-after-load -> `ConflictError`.
The low-level `saveOverride` / `markOverrideReviewed` / `deleteOverride` remain for seeds and tests (no permission check).
