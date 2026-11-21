import { withTenant } from "@/server/db";
import { CATALOGS, isSupportedLocale, type Locale, type TranslationOverrides } from "@/lib/i18n";

/** Raised for invalid override requests. Wrap/map to the core AppError VALIDATION_FAILED / NOT_FOUND at the API layer. */
export class TranslationOverrideError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_LOCALE" | "UNKNOWN_KEY" | "PLACEHOLDER_MISMATCH" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "TranslationOverrideError";
  }
}

export interface OverrideInput {
  locale: string;
  key: string;
  value: string;
  /** User making the edit (recorded as `updatedById`). */
  editorUserId: string;
}

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholdersOf = (text: string) => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]).sort().join(",");

/**
 * Reviewed overrides of one tenant, shaped for `createTranslator`.
 * §16.6: UNREVIEWED overrides are never served — the filter below is the only place that
 * enforces it, so every consumer goes through this function.
 */
export async function loadReviewedOverrides(tenantId: string): Promise<TranslationOverrides> {
  const rows = await withTenant(tenantId, (tx) =>
    tx.translationResource.findMany({
      where: { tenantId, reviewed: true },
      select: { locale: true, key: true, value: true },
    }),
  );
  const overrides: TranslationOverrides = {};
  for (const row of rows) {
    if (!isSupportedLocale(row.locale)) continue; // defensive: DB CHECK already limits locales
    (overrides[row.locale] ??= {})[row.key] = row.value;
  }
  return overrides;
}

/**
 * Creates or changes an override. It always lands UNREVIEWED (even if a reviewed row existed), so
 * an edit can never go live without a fresh human review. The key must exist in the built-in
 * catalog and keep the same {placeholders}, otherwise the UI would render broken text.
 */
export async function saveOverride(tenantId: string, input: OverrideInput): Promise<{ id: string }> {
  if (!isSupportedLocale(input.locale)) {
    throw new TranslationOverrideError("UNSUPPORTED_LOCALE", `Unsupported locale: ${input.locale}`);
  }
  const builtIn = CATALOGS[input.locale].messages[input.key];
  if (builtIn === undefined) {
    throw new TranslationOverrideError("UNKNOWN_KEY", `Unknown translation key: ${input.key}`);
  }
  if (placeholdersOf(builtIn) !== placeholdersOf(input.value)) {
    throw new TranslationOverrideError("PLACEHOLDER_MISMATCH", "Override must keep the same {placeholders}");
  }
  const locale: Locale = input.locale;
  const unreviewed = { reviewed: false, reviewedAt: null, reviewedById: null };
  return withTenant(tenantId, (tx) =>
    tx.translationResource.upsert({
      where: { tenantId_locale_key: { tenantId, locale, key: input.key } },
      create: { tenantId, locale, key: input.key, value: input.value, updatedById: input.editorUserId, ...unreviewed },
      update: { value: input.value, updatedById: input.editorUserId, ...unreviewed },
      select: { id: true },
    }),
  );
}

/** Marks an override as human-reviewed so it starts being served. */
export async function markOverrideReviewed(
  tenantId: string,
  input: { locale: string; key: string; reviewerUserId: string },
): Promise<void> {
  if (!isSupportedLocale(input.locale)) {
    throw new TranslationOverrideError("UNSUPPORTED_LOCALE", `Unsupported locale: ${input.locale}`);
  }
  const locale: Locale = input.locale;
  const result = await withTenant(tenantId, (tx) =>
    tx.translationResource.updateMany({
      where: { tenantId, locale, key: input.key },
      data: { reviewed: true, reviewedAt: new Date(), reviewedById: input.reviewerUserId },
    }),
  );
  if (result.count === 0) throw new TranslationOverrideError("NOT_FOUND", "No such translation override");
}

/** Removes an override so the built-in text is used again. */
export async function deleteOverride(tenantId: string, input: { locale: string; key: string }): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.translationResource.deleteMany({ where: { tenantId, locale: input.locale, key: input.key } }),
  );
}
