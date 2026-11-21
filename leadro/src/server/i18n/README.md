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
- Saving/editing an override always resets it to unreviewed (value change = new review).
- Overrides must target an existing built-in key and keep the same `{placeholders}`.
- All access goes through `withTenant` (RLS); overrides never cross tenants.
- DB CHECK `translation_review_consistent`: reviewed rows carry `reviewedAt`; unreviewed rows carry none.

## Not done here (integration notes)
- Mutations do not yet write audit events (the audit module lands in parallel); call the audit service from the
  API route that wraps `saveOverride` / `markOverrideReviewed`.
- `TranslationOverrideError` should be mapped to core `AppError` (`VALIDATION_FAILED` / `NOT_FOUND`) at the API layer.
- Permission checks (`localization.edit` to save, `localization.configure` to review) belong to the API layer.
